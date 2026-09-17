import express from 'express';

import { pool } from './db.js';
import {
  POSITIONS,
  TOTAL_STEPS,
  TORQUE_MIN,
  TORQUE_MAX,
  IDEMPOTENCY_KEY_MAX_LENGTH,
} from './constants.js';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 业务错误：携带 HTTP 状态码、机器可读 code、中文原因及附加信息（如权威进度）。 */
class ApiError extends Error {
  constructor(status, code, message, extra = undefined) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function confirmationView(row) {
  return {
    id: Number(row.id),
    session_id: row.session_id,
    sequence: row.sequence,
    position: row.position,
    torque: row.torque,
    idempotency_key: row.idempotency_key,
    confirmed_at: row.confirmed_at,
  };
}

/** 由会话行推导的权威进度。 */
function progressOf(session) {
  const completed = session.status === 'completed';
  return {
    status: session.status,
    confirmed_count: session.expected_sequence - 1,
    expected_sequence: completed ? null : session.expected_sequence,
    expected_position: completed ? null : POSITIONS[session.expected_sequence - 1],
  };
}

function sessionView(session, confirmations) {
  return {
    session_id: session.id,
    created_at: session.created_at,
    positions: POSITIONS,
    torque_range: { min: TORQUE_MIN, max: TORQUE_MAX, unit: 'cN·m' },
    ...progressOf(session),
    confirmations: confirmations.map(confirmationView),
  };
}

export function createApp() {
  const app = express();
  app.use(express.json());

  // 允许跨源访问（页面默认经 web 容器同源代理 /api，此为兜底）
  app.use((req, res, next) => {
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  app.get('/healthz', async (req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ ok: true });
    } catch {
      res.status(503).json({ ok: false });
    }
  });

  // 开始新会话：固定 A1 → B2 → A3 → B1 → A2 → B3
  app.post('/api/sessions', async (req, res, next) => {
    try {
      const { rows } = await pool.query(
        `INSERT INTO sessions DEFAULT VALUES
         RETURNING id, status, expected_sequence, created_at`,
      );
      res.status(201).json(sessionView(rows[0], []));
    } catch (err) {
      next(err);
    }
  });

  // 读取权威进度（页面刷新后以此为准）
  app.get('/api/sessions/:id', async (req, res, next) => {
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const s = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
      if (s.rowCount === 0) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const c = await pool.query(
        'SELECT * FROM confirmations WHERE session_id = $1 ORDER BY sequence',
        [id],
      );
      res.json(sessionView(s.rows[0], c.rows));
    } catch (err) {
      next(err);
    }
  });

  // 提交一次复核确认。校验顺序：幂等 → 序号（迟到/越序）→ 位置 → 扭矩。
  // 任何失败都不推进进度、不消耗幂等键。
  app.post('/api/sessions/:id/confirmations', async (req, res, next) => {
    const client = await pool.connect();
    try {
      const { id } = req.params;
      if (!UUID_RE.test(id)) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const body = req.body ?? {};
      const { session_id, sequence, position, torque, idempotency_key } = body;

      if (session_id !== id) {
        throw new ApiError(400, 'invalid_body', '会话编号与请求路径不一致');
      }
      if (!Number.isInteger(sequence) || sequence < 1) {
        throw new ApiError(400, 'invalid_body', 'sequence 必须为从 1 开始的整数序号');
      }
      if (typeof position !== 'string' || !POSITIONS.includes(position)) {
        throw new ApiError(
          400,
          'invalid_body',
          `position 必须为位置码之一：${POSITIONS.join('、')}`,
        );
      }
      if (!Number.isInteger(torque)) {
        throw new ApiError(400, 'invalid_body', 'torque 必须为整数（单位 cN·m）');
      }
      if (
        typeof idempotency_key !== 'string' ||
        idempotency_key.length === 0 ||
        idempotency_key.length > IDEMPOTENCY_KEY_MAX_LENGTH
      ) {
        throw new ApiError(
          400,
          'invalid_body',
          `idempotency_key 必须为 1–${IDEMPOTENCY_KEY_MAX_LENGTH} 字符的字符串`,
        );
      }

      await client.query('BEGIN');
      // 会话行锁：同一会话的提交串行化，配合唯一约束兜底并发重试
      const sres = await client.query(
        'SELECT * FROM sessions WHERE id = $1 FOR UPDATE',
        [id],
      );
      if (sres.rowCount === 0) {
        throw new ApiError(404, 'session_not_found', '会话不存在');
      }
      const session = sres.rows[0];
      const progress = progressOf(session);

      // 1) 幂等键优先：已落库的确认事件决定重试语义
      const eres = await client.query(
        'SELECT * FROM confirmations WHERE session_id = $1 AND idempotency_key = $2',
        [id, idempotency_key],
      );
      if (eres.rowCount > 0) {
        const existing = eres.rows[0];
        const identical =
          existing.sequence === sequence &&
          existing.position === position &&
          existing.torque === torque;
        if (!identical) {
          throw new ApiError(
            409,
            'idempotency_conflict',
            '幂等键已被使用且载荷不一致，判定为冲突，未推进',
            { existing: confirmationView(existing), progress },
          );
        }
        await client.query('COMMIT');
        return res.status(200).json({
          replayed: true,
          confirmation: confirmationView(existing),
          progress,
        });
      }

      // 2) 序号检查：较小为迟到，较大为越序
      const expected = session.expected_sequence;
      if (sequence < expected) {
        throw new ApiError(
          409,
          'late_sequence',
          `序号 ${sequence} 已被确认过，属于迟到响应，未推进`,
          { progress },
        );
      }
      if (sequence > expected) {
        throw new ApiError(
          409,
          'out_of_order_sequence',
          `序号 ${sequence} 越过当前期待序号 ${expected}，属于越序，未推进`,
          { progress },
        );
      }

      // 3) 位置码必须与当前期待步骤对应
      const requiredPosition = POSITIONS[sequence - 1];
      if (position !== requiredPosition) {
        throw new ApiError(
          422,
          'position_mismatch',
          `位置码 ${position} 与第 ${sequence} 步要求的位置 ${requiredPosition} 不符，未推进`,
          { progress },
        );
      }

      // 4) 扭矩须在合格范围内（含边界）
      if (torque < TORQUE_MIN || torque > TORQUE_MAX) {
        throw new ApiError(
          422,
          'torque_out_of_range',
          `扭矩 ${torque} cN·m 超出合格范围 ${TORQUE_MIN}–${TORQUE_MAX} cN·m，未推进`,
          { progress },
        );
      }

      const ins = await client.query(
        `INSERT INTO confirmations (session_id, sequence, position, torque, idempotency_key)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [id, sequence, position, torque, idempotency_key],
      );
      const newStatus = sequence === TOTAL_STEPS ? 'completed' : 'in_progress';
      const upd = await client.query(
        `UPDATE sessions
         SET expected_sequence = $1, status = $2, updated_at = now()
         WHERE id = $3 RETURNING *`,
        [sequence + 1, newStatus, id],
      );
      await client.query('COMMIT');
      res.status(201).json({
        replayed: false,
        confirmation: confirmationView(ins.rows[0]),
        progress: progressOf(upd.rows[0]),
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      next(err);
    } finally {
      client.release();
    }
  });

  app.use((req, res) => {
    res.status(404).json({ error: { code: 'not_found', message: '接口不存在' } });
  });

  // 统一错误出口：业务错误按码返回，其余为 500
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res
        .status(err.status)
        .json({ error: { code: err.code, message: err.message }, ...(err.extra ?? {}) });
    }
    if (err?.type === 'entity.parse.failed' || err?.type === 'entity.too.large') {
      return res
        .status(400)
        .json({ error: { code: 'invalid_body', message: '请求体不是合法 JSON' } });
    }
    console.error(err);
    res.status(500).json({ error: { code: 'internal_error', message: '服务器内部错误' } });
  });

  return app;
}
