import assert from 'node:assert/strict';
import test from 'node:test';
import { runInPostgresTransaction } from '../src/postgres/transaction.js';

function trackingPool({ queryImpl } = {}) {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (queryImpl) return queryImpl(sql, params);
      return { rowCount: 0, rows: [] };
    },
    release() {
      calls.push({ sql: 'RELEASE' });
    }
  };
  return {
    calls,
    async connect() {
      calls.push({ sql: 'CONNECT' });
      return client;
    }
  };
}

test('runInPostgresTransaction wraps work in BEGIN/COMMIT and releases the client', async () => {
  const pool = trackingPool();
  const result = await runInPostgresTransaction(pool, async client => {
    await client.query('SELECT 1');
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.deepEqual(pool.calls.map(call => call.sql), [
    'CONNECT',
    'BEGIN',
    'SELECT 1',
    'COMMIT',
    'RELEASE'
  ]);
});

test('runInPostgresTransaction rolls back and rethrows when the work throws', async () => {
  const pool = trackingPool();
  await assert.rejects(
    () => runInPostgresTransaction(pool, async () => {
      throw new Error('domain failure');
    }),
    /domain failure/
  );
  assert.deepEqual(pool.calls.map(call => call.sql), [
    'CONNECT',
    'BEGIN',
    'ROLLBACK',
    'RELEASE'
  ]);
});

test('runInPostgresTransaction still releases the client if ROLLBACK itself fails', async () => {
  const pool = trackingPool({
    queryImpl: sql => {
      if (sql === 'ROLLBACK') throw new Error('rollback broken');
      return { rowCount: 0, rows: [] };
    }
  });
  await assert.rejects(
    () => runInPostgresTransaction(pool, async () => {
      throw new Error('domain failure');
    }),
    /domain failure/
  );
  assert.deepEqual(pool.calls.map(call => call.sql), [
    'CONNECT',
    'BEGIN',
    'ROLLBACK',
    'RELEASE'
  ]);
});
