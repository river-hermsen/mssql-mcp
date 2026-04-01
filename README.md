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
