import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://hub:hub@localhost:5432/hub_review',
  max: 10,
});

/**
 * 幂等结构迁移：为旧数据卷补充工单码列与唯一索引。
 * 新数据卷由 db/init.sql 建全量结构，此处为 no-op；历史会话的工单码保持 NULL，无需补值。
 */
export async function migrate() {
  await pool.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS work_order_code TEXT');
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS sessions_work_order_code_key
    ON sessions (work_order_code)
    WHERE work_order_code IS NOT NULL
  `);
}
