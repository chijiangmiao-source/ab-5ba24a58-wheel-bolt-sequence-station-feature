-- 轮毂复核工位：会话与不可变确认事件
-- 该脚本由 postgres 容器在空数据卷首次启动时执行（docker-entrypoint-initdb.d）。

CREATE TABLE sessions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  status            TEXT NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress', 'completed')),
  -- 下一个期待的序号（从 1 开始）；六步全部确认后为 7，仅服务端可推进
  expected_sequence INTEGER NOT NULL DEFAULT 1
                    CHECK (expected_sequence BETWEEN 1 AND 7),
  -- 可选的轮毂工单码绑定；未绑定的旧会话为 NULL，无需补值
  work_order_code   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 非空工单码全局唯一：同一工单码只能绑定一个会话（并发打开由 ON CONFLICT 兜底）
CREATE UNIQUE INDEX sessions_work_order_code_key
  ON sessions (work_order_code)
  WHERE work_order_code IS NOT NULL;

CREATE TABLE confirmations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES sessions (id),
  sequence        INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 6),
  position        TEXT NOT NULL CHECK (position IN ('A1', 'B2', 'A3', 'B1', 'A2', 'B3')),
  torque          INTEGER NOT NULL CHECK (torque BETWEEN 4200 AND 4800),
  idempotency_key TEXT NOT NULL,
  confirmed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- 同一会话内：每个序号至多一条确认；每个幂等键至多绑定一条确认
  UNIQUE (session_id, sequence),
  UNIQUE (session_id, idempotency_key)
);

-- 确认事件不可变：数据库层拒绝任何 UPDATE / DELETE
CREATE OR REPLACE FUNCTION confirmations_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'confirmations 为不可变事件表，禁止 %', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER confirmations_no_update
  BEFORE UPDATE ON confirmations
  FOR EACH ROW EXECUTE FUNCTION confirmations_immutable();

CREATE TRIGGER confirmations_no_delete
  BEFORE DELETE ON confirmations
  FOR EACH ROW EXECUTE FUNCTION confirmations_immutable();
