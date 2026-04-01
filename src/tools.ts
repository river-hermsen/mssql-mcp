import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { getAvailableDatabases, getPool } from './db.js';
import { validateReadOnlyQuery } from './sql-validator.js';

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
}
