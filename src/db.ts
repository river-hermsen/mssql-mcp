import sql from 'mssql';

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
    const dbList = getRequiredEnv('MSSQL_DATABASES');
    availableDatabases = dbList
      .split(',')
      .map((db) => db.trim())
      .filter((db) => db.length > 0);

    if (availableDatabases.length === 0) {
      throw new Error('MSSQL_DATABASES must contain at least one database name');
    }
  }
  return availableDatabases;
}

function buildConfig(database: string): sql.config {
  return {
    server: getRequiredEnv('MSSQL_SERVER'),
    user: getRequiredEnv('MSSQL_USER'),
    password: getRequiredEnv('MSSQL_PASSWORD'),
    database,
    port: parseInt(process.env.MSSQL_PORT || '1433', 10),
    pool: {
      max: 5,
      min: 0,
      idleTimeoutMillis: 30000,
    },
    options: {
      encrypt: true,
      trustServerCertificate: false,
      readOnlyIntent: true,
    },
    requestTimeout: 30000,
  };
}

export async function getPool(database: string): Promise<sql.ConnectionPool> {
  const databases = getAvailableDatabases();
  if (!databases.includes(database)) {
    throw new Error(
      `Database "${database}" is not in the allowed list. Available: ${databases.join(', ')}`
    );
  }

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
  const closePromises = Array.from(pools.entries()).map(async ([name, pool]) => {
    try {
      await pool.close();
      console.error(`Closed pool: ${name}`);
    } catch (err) {
      console.error(`Error closing pool ${name}:`, err);
    }
  });
  await Promise.all(closePromises);
  pools.clear();
}
