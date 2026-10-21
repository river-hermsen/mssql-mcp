import pg from "pg";
import { validateReadOnlyQuery, ValidationResult } from "./sql-validator.js";

// ---------------------------------------------------------------------------
// PostgreSQL mode
//
// Enabled by DB_ENGINE=postgres. The server then exposes the same four tools
// (list_databases, list_tables, describe_table, execute_sql) against one or
// more PostgreSQL servers instead of MSSQL, so register it as its own MCP
// entry (e.g. postgresql-production).
//
//   PG_SERVERS   comma-separated name=host[:port] pairs, e.g.
//                prod01=pg-production-01.example:5432,prod02=pg-production-02.example
//   PG_USER / PG_PASSWORD               apply to every server
//   PG_USER_<NAME> / PG_PASSWORD_<NAME> override per server (name upper-cased)
//   PG_DATABASES optional allowlist; without it every database the user may
//                CONNECT to is discovered from each server
//   PG_SSL       require (default: TLS, certificate not verified), verify, disable
//
// Read-only is enforced on the server: every query runs in its own
// BEGIN READ ONLY ... ROLLBACK transaction over the extended protocol (which
// rejects multiple statements), on sessions opened with
// default_transaction_read_only=on. Use a role without write grants on top.
// ---------------------------------------------------------------------------

const STATEMENT_TIMEOUT_MS = 30000;

interface PgServer {
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
}

let servers: Map<string, PgServer> | null = null;
let databaseServers: Map<string, PgServer> | null = null;
const pools = new Map<string, pg.Pool>();

export function postgresEnabled(): boolean {
  return process.env.DB_ENGINE === "postgres";
}

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

function getServers(): Map<string, PgServer> {
  if (servers) {
    return servers;
  }

  servers = new Map();
  for (const entry of getRequiredEnv("PG_SERVERS").split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(`Invalid PG_SERVERS entry "${trimmed}", expected name=host[:port]`);
    }
    const name = trimmed.slice(0, eq).trim();
    const [host, port] = trimmed.slice(eq + 1).trim().split(":");
    const suffix = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    servers.set(name, {
      name,
      host,
      port: port ? parseInt(port, 10) : 5432,
      user: process.env[`PG_USER_${suffix}`] || getRequiredEnv("PG_USER"),
      password: process.env[`PG_PASSWORD_${suffix}`] || getRequiredEnv("PG_PASSWORD"),
    });
  }

  if (servers.size === 0) {
    throw new Error("PG_SERVERS must contain at least one server");
  }
  return servers;
}

function sslConfig(): pg.ClientConfig["ssl"] {
  switch (process.env.PG_SSL || "require") {
    case "disable":
      return false;
    case "verify":
      return { rejectUnauthorized: true };
    default:
      return { rejectUnauthorized: false };
  }
}

function getPool(server: PgServer, database: string): pg.Pool {
  const key = `${server.name}/${database}`;
  let pool = pools.get(key);
  if (!pool) {
    pool = new pg.Pool({
      host: server.host,
      port: server.port,
      user: server.user,
      password: server.password,
      database,
      ssl: sslConfig(),
      application_name: "mssql-mcp",
      options: `-c default_transaction_read_only=on -c statement_timeout=${STATEMENT_TIMEOUT_MS}`,
      connectionTimeoutMillis: 10000,
      idleTimeoutMillis: 30000,
      max: 5,
    });
    // An idle client dropping (network blip, server restart) must not crash the process.
    pool.on("error", (err) => console.error(`Pool ${key} error:`, err.message));
    pools.set(key, pool);
  }
  return pool;
}

async function runReadOnly(
  pool: pg.Pool,
  text: string,
  values: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN READ ONLY");
    // queryMode is supported by pg at runtime but missing from @types/pg.
    const result = await client.query({
      text,
      values,
      queryMode: "extended",
    } as pg.QueryConfig);
    return result.rows;
  } finally {
    try {
      await client.query("ROLLBACK");
      client.release();
    } catch (err) {
      client.release(err as Error);
    }
  }
}

async function discoverDatabases(): Promise<Map<string, PgServer>> {
  if (databaseServers) {
    return databaseServers;
  }

  const allowlist = process.env.PG_DATABASES?.split(",")
    .map((db) => db.trim())
    .filter((db) => db.length > 0);

  const found = new Map<string, PgServer>();
  const failures: string[] = [];
  for (const server of getServers().values()) {
    let rows: Record<string, unknown>[];
    try {
      rows = await runReadOnly(
        getPool(server, "postgres"),
        `SELECT datname FROM pg_database
         WHERE NOT datistemplate AND datallowconn AND datname <> 'postgres'
           AND has_database_privilege(datname, 'CONNECT')
         ORDER BY datname`,
      );
    } catch (err) {
      // One unreachable server must not hide the others; retried on the next call.
      failures.push(`${server.name} (${server.host}): ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    for (const { datname } of rows as { datname: string }[]) {
      if (allowlist && !allowlist.includes(datname)) continue;
      const existing = found.get(datname);
      if (existing) {
        throw new Error(
          `Database "${datname}" exists on both ${existing.name} and ${server.name}; restrict PG_DATABASES`,
        );
      }
      found.set(datname, server);
    }
  }

  unreachable = failures;
  if (failures.length === 0) {
    databaseServers = found;
  } else if (found.size === 0) {
    throw new Error(`No PostgreSQL server reachable: ${failures.join("; ")}`);
  }
  return found;
}

let unreachable: string[] = [];

async function poolFor(database: string): Promise<pg.Pool> {
  const databases = await discoverDatabases();
  const server = databases.get(database);
  if (!server) {
    throw new Error(
      `Database "${database}" is not available. Available: ${Array.from(databases.keys()).join(", ")}`,
    );
  }
  return getPool(server, database);
}

export async function pgListDatabases() {
  const databases = await discoverDatabases();
  return {
    databases: Array.from(databases.entries()).map(([database, server]) => ({
      database,
      server: server.name,
    })),
    ...(unreachable.length > 0 && { unreachable }),
  };
}

export async function pgListTables(database: string) {
  return runReadOnly(
    await poolFor(database),
    `SELECT table_schema, table_name, table_type
     FROM information_schema.tables
     WHERE table_schema NOT IN ('pg_catalog', 'information_schema')
     ORDER BY table_schema, table_name`,
  );
}

export async function pgDescribeTable(database: string, table: string, schema?: string) {
  // Without a schema, current_schema() follows the database's search_path,
  // which the setup SQL points at the module schema.
  return runReadOnly(
    await poolFor(database),
    `SELECT table_schema, column_name, data_type, character_maximum_length,
            is_nullable, column_default, ordinal_position
     FROM information_schema.columns
     WHERE table_name = $1 AND table_schema = COALESCE($2, current_schema())
     ORDER BY ordinal_position`,
    [table, schema ?? null],
  );
}

export async function pgExecuteSql(database: string, query: string) {
  return runReadOnly(await poolFor(database), query);
}

// Functions that act outside the transaction or read the server's files.
// Checked against the raw text (string literals included), so a dollar-quoted
// string cannot hide one from the literal stripping in validateReadOnlyQuery.
const FORBIDDEN_FUNCTIONS = [
  "set_config",
  "pg_terminate_backend",
  "pg_cancel_backend",
  "pg_reload_conf",
  "pg_rotate_logfile",
  "pg_read_file",
  "pg_read_binary_file",
  "pg_ls_dir",
  "pg_stat_file",
  "pg_sleep",
  "pg_sleep_for",
  "pg_sleep_until",
  "pg_notify",
  "pg_logical_emit_message",
  "dblink",
  "dblink_exec",
  "lo_import",
  "lo_export",
  "lo_from_bytea",
  "lo_put",
  "lo_unlink",
];

const FORBIDDEN_PG_KEYWORDS = [
  "COPY",
  "DO",
  "CALL",
  "SET",
  "RESET",
  "LOCK",
  "LISTEN",
  "NOTIFY",
  "VACUUM",
  "REFRESH",
  "DISCARD",
  "PREPARE",
  "DEALLOCATE",
  "IMPORT",
  "SECURITY",
];

export function validatePostgresReadOnlyQuery(sql: string): ValidationResult {
  const base = validateReadOnlyQuery(sql);
  if (!base.valid) {
    return base;
  }

  for (const fn of FORBIDDEN_FUNCTIONS) {
    if (new RegExp(`\\b${fn}\\b`, "i").test(sql)) {
      return { valid: false, error: `Forbidden function: ${fn}` };
    }
  }

  if (/\bpg_advisory_\w+/i.test(sql)) {
    return { valid: false, error: "Advisory locks are not allowed" };
  }

  for (const keyword of FORBIDDEN_PG_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`, "i").test(sql)) {
      return { valid: false, error: `Forbidden keyword: ${keyword}` };
    }
  }

  if (/\bFOR\s+(NO\s+KEY\s+UPDATE|KEY\s+SHARE|SHARE)\b/i.test(sql)) {
    return { valid: false, error: "Row locks are not allowed" };
  }

  return { valid: true };
}

export async function closePgPools(): Promise<void> {
  await Promise.all(
    Array.from(pools.values()).map((pool) => pool.end().catch(() => undefined)),
  );
  pools.clear();
}
