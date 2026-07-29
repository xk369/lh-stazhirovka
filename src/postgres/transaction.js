export async function runInPostgresTransaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Rollback failures must not shadow the original error; the pool will
      // discard the client on release when the transaction is in a bad state.
    }
    throw error;
  } finally {
    client.release();
  }
}
