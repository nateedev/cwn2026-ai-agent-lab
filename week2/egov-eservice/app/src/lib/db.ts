import pg from 'pg';

// bigint/count → number · date (1082) → สตริง YYYY-MM-DD ไม่ให้เลื่อนตามเขตเวลา
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? 'postgres://egov:egov@localhost:5432/egov',
  max: 20,
});

export type Queryable = Pick<pg.Pool, 'query'>;

export async function query<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query<T>(sql, params)).rows;
}
export async function one<T extends pg.QueryResultRow = any>(sql: string, params: unknown[] = []): Promise<T | null> {
  return (await pool.query<T>(sql, params)).rows[0] ?? null;
}
/** ทำงานใน transaction เดียว */
export async function tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await fn(c);
    await c.query('COMMIT');
    return r;
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}
/** ตัวนับเลขรันต่อเนื่องแบบ atomic: nextNumber('case') คืนเลขถัดไป (หลัง seed counters.case=30 → 31) */
export async function nextNumber(name: string, c: Queryable = pool): Promise<number> {
  const r = await c.query(
    `INSERT INTO counters(name,value) VALUES ($1,1)
     ON CONFLICT (name) DO UPDATE SET value = counters.value + 1 RETURNING value`, [name]);
  return r.rows[0].value as number;
}
