# mssql-mcp

Read-only MCP server for querying MSSQL / Azure SQL databases.

## Setup

```bash
npm install
npm run build
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `MSSQL_DATABASES` | Yes | Comma-separated database names |
| `MSSQL_SERVER` | Yes | Server hostname |
| `MSSQL_USER` | Yes | SQL auth username |
| `MSSQL_PASSWORD` | Yes | SQL auth password |
| `MSSQL_PORT` | No | Defaults to 1433 |

## Claude Code Configuration

Add to your Claude Code settings (`.claude/settings.json` or project settings):

```json
{
  "mcpServers": {
    "mssql": {
      "command": "node",
      "args": ["/absolute/path/to/mssql-mcp/dist/index.js"],
      "env": {
        "MSSQL_DATABASES": "CoreDB,SportsDB",
        "MSSQL_SERVER": "your-server.database.windows.net",
        "MSSQL_USER": "readonly-user",
        "MSSQL_PASSWORD": "your-password"
      }
    }
  }
}
```

## Tools

- **`list_databases`** — List available databases
- **`list_tables`** — List tables/views in a database
- **`describe_table`** — Get column details for a table
- **`execute_sql`** — Run a read-only SQL query (SELECT/WITH only)

## Security

Read-only access is enforced through multiple layers:

1. **SQL validator** — Blocks INSERT, UPDATE, DELETE, DROP, ALTER, CREATE, TRUNCATE, EXEC, and other mutation keywords
2. **`readOnlyIntent`** — Connection-level read-only routing for Azure SQL
3. **Database allowlist** — Only databases listed in `MSSQL_DATABASES` are accessible
4. **Query timeout** — 30-second limit on query execution

**Recommendation**: Use a SQL user with only `db_datareader` role for maximum safety.

## Optional: ClickHouse

The same server can expose read-only ClickHouse access over the HTTP
interface. Enable it by adding to the `env` block:

```json
"CLICKHOUSE_SERVERS": "prod=http://clickhouse.example.internal:8123,staging=http://clickhouse-staging.example.internal:8123",
"CLICKHOUSE_USER": "readonly-user",
"CLICKHOUSE_PASSWORD": "your-password"
```

Per-server credentials can be set with `CLICKHOUSE_USER_<NAME>` /
`CLICKHOUSE_PASSWORD_<NAME>` (server name upper-cased).

Tools (registered only when `CLICKHOUSE_SERVERS` is set):

- **`clickhouse_list_databases`** — List servers (no argument) or databases on a server
- **`clickhouse_list_tables`** — List tables in a database
- **`clickhouse_describe_table`** — Get column details for a table
- **`clickhouse_execute_sql`** — Run a read-only SQL query (SELECT/WITH only)

Security: every request is sent with `readonly=1`, which makes ClickHouse
itself reject writes, DDL and settings changes server-side; the SELECT/WITH
validator and a 30s `max_execution_time` apply on top. Use a dedicated
read-only user, e.g.:

```sql
CREATE USER 'readonly-user' IDENTIFIED BY '...' SETTINGS readonly = 1 CONST;
GRANT SHOW, SELECT ON *.* TO 'readonly-user';
```

## Optional: PostgreSQL

Set `DB_ENGINE=postgres` to run the server against PostgreSQL instead of
MSSQL. It then exposes the same four tools (`list_databases`, `list_tables`,
`describe_table`, `execute_sql`), so register it as its own MCP entry:

```json
"postgresql-production": {
  "command": "node",
  "args": ["/absolute/path/to/mssql-mcp/dist/index.js"],
  "env": {
    "DB_ENGINE": "postgres",
    "PG_SERVERS": "prod01=pg-01.example.internal:5432,prod02=pg-02.example.internal:5432",
    "PG_USER": "readonly-user",
    "PG_PASSWORD": "your-password"
  }
}
```

| Variable | Required | Description |
|---|---|---|
| `DB_ENGINE` | Yes | `postgres` |
| `PG_SERVERS` | Yes | Comma-separated `name=host[:port]` pairs (port defaults to 5432) |
| `PG_USER` / `PG_PASSWORD` | Yes | Credentials for every server; `PG_USER_<NAME>` / `PG_PASSWORD_<NAME>` override per server |
| `PG_DATABASES` | No | Allowlist; without it every database the user may `CONNECT` to is discovered |
| `PG_SSL` | No | `require` (default, TLS without certificate check), `verify` or `disable` |

`list_databases` shows which server each database lives on. A server that
cannot be reached is reported under `unreachable` instead of failing the
whole call. Without a `schema`, `describe_table` uses the database's
`search_path` schema.

Security: every query runs in its own `BEGIN READ ONLY` ... `ROLLBACK` over
the extended protocol, which rejects multiple statements, on sessions opened
with `default_transaction_read_only=on` and a 30s `statement_timeout`. The
SELECT/WITH validator applies on top, plus a block on functions that act
outside the transaction or read server files (`set_config`, `pg_read_file`,
`lo_import`, `dblink`, `pg_sleep`, advisory locks, ...). Use a role without
write grants.
