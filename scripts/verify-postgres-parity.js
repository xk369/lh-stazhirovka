import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createPostgresClient } from '../src/postgres/connection.js';
import {
  readBookingStateFromPostgres,
  verifyBookingStateParity
} from '../src/postgres/read-booking-state.js';

function sourceArgument(argv) {
  const index = argv.indexOf('--source');
  if (index < 0 || !argv[index + 1]) {
    throw new Error('Usage: npm run db:verify-parity -- --source /absolute/path/to/db.json');
  }
  return path.resolve(argv[index + 1]);
}

const sourcePath = sourceArgument(process.argv.slice(2));
const sourceState = JSON.parse(await fs.readFile(sourcePath, 'utf8'));
const client = createPostgresClient();

try {
  await client.connect();
  const postgresState = await readBookingStateFromPostgres(client);
  const summary = verifyBookingStateParity(sourceState, postgresState);
  console.log(JSON.stringify({ ok: true, source: sourcePath, ...summary }, null, 2));
} finally {
  await client.end();
}
