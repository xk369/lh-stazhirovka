import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createPostgresClient } from '../src/postgres/connection.js';
import { importInterviewState } from '../src/postgres/import-interview-state.js';

function sourceArgument(argv) {
  const index = argv.indexOf('--source');
  if (index < 0 || !argv[index + 1]) {
    throw new Error('Usage: npm run db:import-interviews-json -- --source /absolute/path/to/interviews.json');
  }
  return path.resolve(argv[index + 1]);
}

const sourcePath = sourceArgument(process.argv.slice(2));
const raw = await fs.readFile(sourcePath, 'utf8');
const sourceChecksum = createHash('sha256').update(raw).digest('hex');
const sourceState = JSON.parse(raw);
const client = createPostgresClient();

try {
  await client.connect();
  const { verification, profiles } = await importInterviewState(client, sourceState, {
    sourceChecksum
  });
  console.log(JSON.stringify({
    ok: true,
    source: sourcePath,
    profiles: {
      inserted: profiles.inserted,
      reused: profiles.reused
    },
    counts: verification.actual
  }, null, 2));
} finally {
  await client.end();
}
