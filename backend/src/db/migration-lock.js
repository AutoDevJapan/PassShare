/**
 * Apply schema SQL under a Postgres session advisory lock so concurrent app
 * instances serialize DDL application.
 *
 * `CREATE TABLE IF NOT EXISTS` is not race-safe: each table's composite rowtype
 * is inserted into `pg_type`, and two instances can both pass the existence
 * check in parallel and then collide on `pg_type_typname_nsp_index` (23505).
 * Serializing on a fixed advisory lock makes migrate() idempotent under
 * concurrency (tests, multi-instance startup).
 *
 * @param {import('pg').Pool} pool
 * @param {number} lockKey Distinct fixed key per schema (connect vs auth).
 * @param {string} schemaSql Idempotent schema DDL to apply while holding the lock.
 * @returns {Promise<void>}
 */
export async function applySchemaWithAdvisoryLock(pool, lockKey, schemaSql) {
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [lockKey]);
    await client.query(schemaSql);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [lockKey]).catch(() => {});
    client.release();
  }
}
