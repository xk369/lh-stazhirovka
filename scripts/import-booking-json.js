import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPostgresClient } from '../src/postgres/connection.js';
import { importBookingState } from '../src/postgres/import-booking-state.js';

function sourceArgument(argv) {
  const index = argv.indexOf('--source');
  if (index < 0 || !argv[index + 1]) {
    throw new Error('Usage: npm run db:import-json -- --source /absolute/path/to/db.json');
  }
  return path.resolve(argv[index + 1]);
}

function recruiterIds(env = process.env) {
  return String(env.RECRUITER_TELEGRAM_IDS || '')
    .split(',')
    .map(value => value.trim())
    .filter(value => /^\d+$/.test(value));
}

const sourcePath = sourceArgument(process.argv.slice(2));
const raw = await fs.readFile(sourcePath, 'utf8');
const sourceChecksum = createHash('sha256').update(raw).digest('hex');
const sourceState = JSON.parse(raw);
const client = createPostgresClient();

try {
  await client.connect();
  const { verification } = await importBookingState(client, sourceState, {
    sourceChecksum,
    recruiterTelegramIds: recruiterIds()
  });
  console.log(JSON.stringify({
    ok: true,
    source: sourcePath,
    counts: verification.actual,
    statuses: verification.statuses
  }, null, 2));
} finally {
  await client.end();
}
