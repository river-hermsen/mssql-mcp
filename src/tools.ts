import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAvailableDatabases, getPool } from './db.js';
import { validateReadOnlyQuery } from './sql-validator.js';
import {
  clickHouseEnabled,
  getClickHouseServers,
  clickHouseQuery,
} from './clickhouse.js';

function textResult(value: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: `Error: ${err instanceof Error ? err.message : String(err)}`,
      },
    ],
    isError: true,
  };
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    'list_databases',
    {
      title: 'List Databases',
      description: 'List all available databases that can be queried',
      annotations: { readOnlyHint: true },
    },
    async () => {
      const databases = getAvailableDatabases();
      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify(databases, null, 2),
          },
        ],
      };
    }
  );

  server.registerTool(
    'list_tables',
    {
      title: 'List Tables',
      description: 'List all tables and views in a database',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        database: z.string().describe('Database name to list tables from'),
      }),
    },
    async ({ database }) => {
      try {
        const pool = await getPool(database);
        const result = await pool.request().query(`
          SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
          FROM INFORMATION_SCHEMA.TABLES
          ORDER BY TABLE_SCHEMA, TABLE_NAME
        `);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.recordset, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'describe_table',
    {
      title: 'Describe Table',
      description: 'Get column details for a specific table',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        database: z.string().describe('Database name'),
        table: z.string().describe('Table name'),
        schema: z
          .string()
          .optional()
          .default('dbo')
          .describe('Schema name (defaults to dbo)'),
      }),
    },
    async ({ database, table, schema }) => {
      try {
        const pool = await getPool(database);
        const result = await pool
          .request()
          .input('tableName', table)
          .input('schemaName', schema)
          .query(`
            SELECT
              COLUMN_NAME,
              DATA_TYPE,
              CHARACTER_MAXIMUM_LENGTH,
              IS_NULLABLE,
              COLUMN_DEFAULT,
              ORDINAL_POSITION
            FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_NAME = @tableName
              AND TABLE_SCHEMA = @schemaName
            ORDER BY ORDINAL_POSITION
          `);

        if (result.recordset.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No columns found for table [${schema}].[${table}] in database ${database}`,
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.recordset, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    'execute_sql',
    {
      title: 'Execute SQL',
      description: 'Execute a read-only SQL query (SELECT/WITH only)',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        database: z.string().describe('Database name to query'),
        query: z.string().describe('Read-only SQL query (SELECT or WITH/CTE only)'),
      }),
    },
    async ({ database, query }) => {
      const validation = validateReadOnlyQuery(query);
      if (!validation.valid) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Query rejected: ${validation.error}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const pool = await getPool(database);
        const result = await pool.request().query(query);
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result.recordset, null, 2),
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  if (clickHouseEnabled()) {
    registerClickHouseTools(server);
  }
}

function registerClickHouseTools(server: McpServer): void {
  server.registerTool(
    'clickhouse_list_databases',
    {
      title: 'ClickHouse: List Databases',
      description:
        'List databases on a ClickHouse server. Omit server to list the available servers.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        server: z
          .string()
          .optional()
          .describe('Server name (e.g. prod, staging). Omit to list servers.'),
      }),
    },
    async ({ server: serverName }) => {
      try {
        if (!serverName) {
          return textResult(Array.from(getClickHouseServers().keys()));
        }
        const rows = await clickHouseQuery(
          serverName,
          'SELECT name, engine FROM system.databases ORDER BY name'
        );
        return textResult(rows);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'clickhouse_list_tables',
    {
      title: 'ClickHouse: List Tables',
      description: 'List tables in a ClickHouse database',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        server: z.string().describe('Server name (e.g. prod, staging)'),
        database: z.string().describe('Database name to list tables from'),
      }),
    },
    async ({ server: serverName, database }) => {
      try {
        const rows = await clickHouseQuery(
          serverName,
          'SELECT name, engine, total_rows, total_bytes FROM system.tables WHERE database = {db:String} ORDER BY name',
          { db: database }
        );
        return textResult(rows);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'clickhouse_describe_table',
    {
      title: 'ClickHouse: Describe Table',
      description: 'Get column details for a ClickHouse table',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        server: z.string().describe('Server name (e.g. prod, staging)'),
        database: z.string().describe('Database name'),
        table: z.string().describe('Table name'),
      }),
    },
    async ({ server: serverName, database, table }) => {
      try {
        const rows = await clickHouseQuery(
          serverName,
          `SELECT name, type, default_kind, default_expression, comment, is_in_primary_key, is_in_sorting_key
           FROM system.columns
           WHERE database = {db:String} AND table = {tbl:String}
           ORDER BY position`,
          { db: database, tbl: table }
        );
        if (rows.length === 0) {
          return textResult(
            `No columns found for table ${database}.${table} on server ${serverName}`
          );
        }
        return textResult(rows);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    'clickhouse_execute_sql',
    {
      title: 'ClickHouse: Execute SQL',
      description:
        'Execute a read-only ClickHouse SQL query (SELECT/WITH only, enforced server-side with readonly=1)',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        server: z.string().describe('Server name (e.g. prod, staging)'),
        query: z.string().describe('Read-only SQL query (SELECT or WITH/CTE only)'),
        database: z
          .string()
          .optional()
          .describe('Default database for unqualified table names'),
      }),
    },
    async ({ server: serverName, query, database }) => {
      const validation = validateReadOnlyQuery(query);
      if (!validation.valid) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Query rejected: ${validation.error}`,
            },
          ],
          isError: true,
        };
      }

      try {
        const rows = await clickHouseQuery(serverName, query, {}, database);
        return textResult(rows);
      } catch (err) {
        return errorResult(err);
      }
    }
  );
}
