import pg from 'pg';

const { Client, Pool } = pg;

function databaseUrl(env = process.env) {
  const value = String(env.DATABASE_URL || '').trim();
  if (!value) {
    throw new Error('DATABASE_URL is required for PostgreSQL tools.');
  }
  return value;
}

function sslConfig(env = process.env) {
  const mode = String(env.POSTGRES_SSL_MODE || '').trim().toLowerCase();
  if (!mode || mode === 'disable') return undefined;
  if (mode === 'require') return { rejectUnauthorized: false };
  if (mode === 'verify-full') return { rejectUnauthorized: true };
  throw new Error('POSTGRES_SSL_MODE must be disable, require, or verify-full.');
}

export function createPostgresClient(env = process.env) {
  return new Client({
    connectionString: databaseUrl(env),
    ssl: sslConfig(env)
  });
}

export function createPostgresPool(env = process.env) {
  return new Pool({
    connectionString: databaseUrl(env),
    ssl: sslConfig(env),
    max: Number(env.POSTGRES_POOL_MAX || 10)
  });
}
