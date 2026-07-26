import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createPostgresClient } from '../src/postgres/connection.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.resolve(__dirname, '../db/migrations');

function checksum(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function migrationFiles() {
  return (await fs.readdir(migrationsDir))
    .filter(file => /^\d+_.+\.sql$/.test(file))
    .sort((left, right) => left.localeCompare(right));
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function applyMigration(client, name) {
  const sql = await fs.readFile(path.join(migrationsDir, name), 'utf8');
  const sqlChecksum = checksum(sql);
  const applied = await client.query(
    'SELECT checksum FROM schema_migrations WHERE name = $1',
    [name]
  );

  if (applied.rowCount) {
    if (applied.rows[0].checksum !== sqlChecksum) {
      throw new Error(`Migration ${name} was changed after it was applied.`);
    }
    return 'already_applied';
  }

  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
      [name, sqlChecksum]
    );
    await client.query('COMMIT');
    return 'applied';
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

const client = createPostgresClient();

try {
  await client.connect();
  await ensureMigrationTable(client);
  for (const file of await migrationFiles()) {
    const result = await applyMigration(client, file);
    console.log(`${file}: ${result}`);
  }
} finally {
  await client.end();
}
