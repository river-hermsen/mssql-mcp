// ---------------------------------------------------------------------------
// Optional ClickHouse support
//
// Enabled by setting CLICKHOUSE_SERVERS to a comma-separated list of
// name=url pairs, e.g.:
//
//   CLICKHOUSE_SERVERS=prod=http://clickhouse-operations.prod.internal.foys.tech:8123,staging=http://clickhouse-operations.staging.internal.foys.tech:8123
//
// Credentials: CLICKHOUSE_USER / CLICKHOUSE_PASSWORD apply to every server;
// CLICKHOUSE_USER_<NAME> / CLICKHOUSE_PASSWORD_<NAME> (name upper-cased)
// override per server.
//
// Every request is sent with readonly=1 so the server itself rejects any
// write or DDL, independent of the client-side query validation.
// ---------------------------------------------------------------------------

interface ClickHouseServer {
  name: string;
  url: string;
  user: string;
  password: string;
}

let servers: Map<string, ClickHouseServer> | null = null;

export function clickHouseEnabled(): boolean {
  return !!process.env.CLICKHOUSE_SERVERS;
}

export function getClickHouseServers(): Map<string, ClickHouseServer> {
  if (servers) {
    return servers;
  }

  const raw = process.env.CLICKHOUSE_SERVERS || "";
  servers = new Map();

  for (const entry of raw.split(",")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      throw new Error(
        `CLICKHOUSE_SERVERS entry "${trimmed}" must have the form name=url`,
      );
    }
    const name = trimmed.slice(0, eq).trim();
    const url = trimmed.slice(eq + 1).trim().replace(/\/+$/, "");
    const suffix = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const user =
      process.env[`CLICKHOUSE_USER_${suffix}`] ||
      process.env.CLICKHOUSE_USER ||
      "";
    const password =
      process.env[`CLICKHOUSE_PASSWORD_${suffix}`] ||
      process.env.CLICKHOUSE_PASSWORD ||
      "";
    if (!user) {
      throw new Error(
        `No ClickHouse user configured for server "${name}" (set CLICKHOUSE_USER or CLICKHOUSE_USER_${suffix})`,
      );
    }
    servers.set(name, { name, url, user, password });
  }

  if (servers.size === 0) {
    throw new Error("CLICKHOUSE_SERVERS must contain at least one name=url entry");
  }
  return servers;
}

function getServer(name: string): ClickHouseServer {
  const all = getClickHouseServers();
  const server = all.get(name);
  if (!server) {
    throw new Error(
      `ClickHouse server "${name}" is not in the allowed list. Available: ${Array.from(all.keys()).join(", ")}`,
    );
  }
  return server;
}

/**
 * Run a query over the ClickHouse HTTP interface. `params` become
 * server-side bound parameters ({name:String} placeholders), which keeps
 * identifiers out of string interpolation.
 */
export async function clickHouseQuery(
  serverName: string,
  query: string,
  params: Record<string, string> = {},
  database?: string,
): Promise<unknown[]> {
  const server = getServer(serverName);

  const url = new URL(server.url + "/");
  // readonly=1: server-side enforcement — rejects writes, DDL and settings
  // changes regardless of what the client sends.
  url.searchParams.set("readonly", "1");
  url.searchParams.set("default_format", "JSON");
  url.searchParams.set("max_execution_time", "30");
  if (database) {
    url.searchParams.set("database", database);
  }
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(`param_${key}`, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35000);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      body: query,
      headers: {
        "X-ClickHouse-User": server.user,
        "X-ClickHouse-Key": server.password,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  const text = await response.text();
  if (!response.ok) {
    // ClickHouse returns the DB::Exception text in the body.
    throw new Error(text.trim() || `HTTP ${response.status}`);
  }

  if (!text.trim()) {
    return [];
  }
  const parsed = JSON.parse(text);
  return parsed.data ?? [];
}
