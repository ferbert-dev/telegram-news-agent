import { Pool, types } from "pg";

types.setTypeParser(types.builtins.INT8, (value) => Number(value));

function positiveInteger(value, name, fallback) {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  const parsed = Number(normalized);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

export function getDatabaseConfig(env = process.env) {
  const connectionString = env.DATABASE_URL?.trim();
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }

  return {
    connectionString,
    max: positiveInteger(env.DATABASE_POOL_MAX, "DATABASE_POOL_MAX", 4),
    connectionTimeoutMillis: positiveInteger(
      env.DATABASE_CONNECT_TIMEOUT_MS,
      "DATABASE_CONNECT_TIMEOUT_MS",
      5_000,
    ),
    idleTimeoutMillis: positiveInteger(
      env.DATABASE_IDLE_TIMEOUT_MS,
      "DATABASE_IDLE_TIMEOUT_MS",
      30_000,
    ),
    allowExitOnIdle: true,
  };
}

export function createDatabaseClient(config = getDatabaseConfig()) {
  return new Pool(config);
}

export async function closeDatabaseClient(client) {
  await client.end();
}
