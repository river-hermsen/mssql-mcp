import sql from "mssql";
import net from "net";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";

const pools = new Map<string, sql.ConnectionPool>();

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

let availableDatabases: string[] | null = null;

export function getAvailableDatabases(): string[] {
  if (!availableDatabases) {
    const dbList = getRequiredEnv("MSSQL_DATABASES");
    availableDatabases = dbList
      .split(",")
      .map((db) => db.trim())
      .filter((db) => db.length > 0);

    if (availableDatabases.length === 0) {
      throw new Error(
        "MSSQL_DATABASES must contain at least one database name",
      );
    }
  }
  return availableDatabases;
}

// ---------------------------------------------------------------------------
// Optional SSH tunnel
//
// When MSSQL_SSH_HOST is set, the database is not reachable directly (e.g. an
// on-prem server behind a bastion).
//
// Env vars (all optional unless MSSQL_SSH_HOST is set):
//   MSSQL_SSH_HOST            enable tunneling; bastion host
//   MSSQL_SSH_USER            bastion user (required when tunneling)
//   MSSQL_SSH_PORT            bastion SSH port (default 22)
//   MSSQL_SSH_PASSWORD        bastion password (fed to ssh via SSH_ASKPASS)
//   MSSQL_SSH_STARTUP_COMMAND one-shot command run on the bastion before any
//                             query flows
// ---------------------------------------------------------------------------
interface TunnelState {
  localPort: number;
  sshPid: number;
  askpassDir: string;
}

let tunnel: TunnelState | null = null;
let tunnelPromise: Promise<TunnelState | null> | null = null;

function sshEnabled(): boolean {
  return !!process.env.MSSQL_SSH_HOST;
}

function sshEnv(askpassPath: string): NodeJS.ProcessEnv {
  // SSH_ASKPASS_REQUIRE=force makes OpenSSH use the askpass helper for the
  // password even when a tty is present; the helper just echoes the password.
  return {
    ...process.env,
    SSH_ASKPASS: askpassPath,
    SSH_ASKPASS_REQUIRE: "force",
    DISPLAY: "none",
  };
}

function sshBaseOptions(): string[] {
  const knownHosts = path.join(os.tmpdir(), "mssql_mcp_known_hosts");
  return [
    "-o",
    "StrictHostKeyChecking=accept-new",
    "-o",
    `UserKnownHostsFile=${knownHosts}`,
  ];
}

function allocateLocalPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function writeAskpass(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mssql-mcp-"));
  const p = path.join(dir, "askpass.sh");
  // Reads the password from the environment so it never lands on a command line.
  fs.writeFileSync(p, '#!/bin/sh\nprintf %s "$MSSQL_SSH_PASSWORD"\n', {
    mode: 0o700,
  });
  return p;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForPort(
  port: number,
  pid: number,
  timeoutMs = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, "127.0.0.1");
      socket.once("connect", () => {
        socket.destroy();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() > deadline || !processAlive(pid)) {
          reject(
            new Error(
              `SSH tunnel to ${process.env.MSSQL_SSH_HOST} failed to come up within ${timeoutMs}ms`,
            ),
          );
        } else {
          setTimeout(attempt, 200);
        }
      });
    };
    attempt();
  });
}

function runStartupCommand(askpassPath: string): Promise<void> {
  const command = process.env.MSSQL_SSH_STARTUP_COMMAND;
  if (!command) {
    return Promise.resolve();
  }

  const sshUser = getRequiredEnv("MSSQL_SSH_USER");
  const sshHost = getRequiredEnv("MSSQL_SSH_HOST");
  const sshPort = process.env.MSSQL_SSH_PORT || "22";

  return new Promise((resolve, reject) => {
    const child = spawn(
      "ssh",
      ["-p", sshPort, ...sshBaseOptions(), `${sshUser}@${sshHost}`, command],
      { env: sshEnv(askpassPath), stdio: ["ignore", "pipe", "pipe"] },
    );

    let output = "";
    child.stdout.on("data", (d) => (output += d.toString()));
    child.stderr.on("data", (d) => (output += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        console.error(`SSH startup command ok: ${output.trim()}`);
        resolve();
      } else {
        reject(
          new Error(
            `SSH startup command failed (exit ${code}): ${output.trim()}`,
          ),
        );
      }
    });
  });
}

async function openTunnel(): Promise<TunnelState> {
  const remoteHost = getRequiredEnv("MSSQL_SERVER");
  const remotePort = parseInt(process.env.MSSQL_PORT || "1433", 10);
  const sshUser = getRequiredEnv("MSSQL_SSH_USER");
  const sshHost = getRequiredEnv("MSSQL_SSH_HOST");
  const sshPort = process.env.MSSQL_SSH_PORT || "22";

  const localPort = await allocateLocalPort();
  const askpassPath = writeAskpass();

  const child = spawn(
    "ssh",
    [
      "-N",
      "-L",
      `127.0.0.1:${localPort}:${remoteHost}:${remotePort}`,
      "-p",
      sshPort,
      ...sshBaseOptions(),
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "ServerAliveInterval=30",
      `${sshUser}@${sshHost}`,
    ],
    { env: sshEnv(askpassPath), stdio: "ignore" },
  );
  child.unref();
  const pid = child.pid!;
  console.error(
    `Opened SSH tunnel ${sshUser}@${sshHost} -> ${remoteHost}:${remotePort} on 127.0.0.1:${localPort}`,
  );

  await waitForPort(localPort, pid);

  const state: TunnelState = {
    localPort,
    sshPid: pid,
    askpassDir: path.dirname(askpassPath),
  };
  tunnel = state;

  // Run the startup command (e.g. nxcli) once the tunnel is up and before any
  // query flows.
  await runStartupCommand(askpassPath);

  return state;
}

async function ensureTunnel(): Promise<TunnelState | null> {
  if (!sshEnabled()) {
    return null;
  }
  if (tunnel) {
    return tunnel;
  }
  if (!tunnelPromise) {
    tunnelPromise = openTunnel();
  }
  try {
    return await tunnelPromise;
  } finally {
    tunnelPromise = null;
  }
}

function buildConfig(database: string): sql.config {
  // When tunneling, connect through the local forwarded port instead of the
  // real server address.
  const server = tunnel ? "127.0.0.1" : getRequiredEnv("MSSQL_SERVER");
  const port = tunnel
    ? tunnel.localPort
    : parseInt(process.env.MSSQL_PORT || "1433", 10);

  return {
    server,
    user: getRequiredEnv("MSSQL_USER"),
    password: getRequiredEnv("MSSQL_PASSWORD"),
    database,
    port,
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
    options: {
      // Old on-prem servers reached over the tunnel often can't negotiate TLS;
      // set MSSQL_ENCRYPT=false for those. Defaults to encrypted otherwise.
      encrypt: process.env.MSSQL_ENCRYPT !== "false",
      trustServerCertificate:
        process.env.MSSQL_TRUST_SERVER_CERTIFICATE === "true",
      readOnlyIntent: true,
    },
    requestTimeout: 30000,
  };
}

export async function getPool(database: string): Promise<sql.ConnectionPool> {
  const databases = getAvailableDatabases();
  if (!databases.includes(database)) {
    throw new Error(
      `Database "${database}" is not in the allowed list. Available: ${databases.join(", ")}`,
    );
  }

  // Bring up the SSH tunnel (and run its startup command) before the first
  // connection. No-op when MSSQL_SSH_HOST is unset.
  await ensureTunnel();

  let pool = pools.get(database);
  if (pool?.connected) {
    return pool;
  }

  pool = new sql.ConnectionPool(buildConfig(database));
  await pool.connect();
  pools.set(database, pool);
  console.error(`Connected to database: ${database}`);
  return pool;
}

export async function closePools(): Promise<void> {
  const closePromises = Array.from(pools.entries()).map(
    async ([name, pool]) => {
      try {
        await pool.close();
        console.error(`Closed pool: ${name}`);
      } catch (err) {
        console.error(`Error closing pool ${name}:`, err);
      }
    },
  );
  await Promise.all(closePromises);
  pools.clear();

  if (tunnel) {
    try {
      process.kill(tunnel.sshPid, "SIGTERM");
    } catch {
      // tunnel already gone
    }
    try {
      fs.rmSync(tunnel.askpassDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    tunnel = null;
  }
}
