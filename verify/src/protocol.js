import pg from 'pg';

import { assert, assertEqual, assertRejects } from './helpers.js';

const POSITIONS = ['A1', 'B2', 'A3', 'B1', 'A2', 'B3'];

let keySeq = 0;
const key = (tag) => `proto-${tag}-${process.pid}-${Date.now()}-${(keySeq += 1)}`;
const woCode = (tag) => `WO-${tag}-${process.pid}-${Date.now()}-${(keySeq += 1)}`;

async function createSession(base) {
  const r = await fetch(`${base}/api/sessions`, { method: 'POST' });
  assertEqual(r.status, 201, '创建会话状态码');
  return r.json();
}

async function getSession(base, id) {
  const r = await fetch(`${base}/api/sessions/${id}`);
  assertEqual(r.status, 200, '读取会话状态码');
  return r.json();
}

async function openWorkOrder(base, code) {
  const r = await fetch(`${base}/api/work-orders/${encodeURIComponent(code)}/session`, {
    method: 'POST',
  });
  return { status: r.status, body: await r.json() };
}

async function postConf(base, sid, payload) {
  const r = await fetch(`${base}/api/sessions/${sid}/confirmations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sid, ...payload }),
  });
  return { status: r.status, body: await r.json() };
}

/** 协议测试：直接针对 API 的 HTTP 语义。 */
export async function runProtocol(base, t) {
  await t.test('健康检查返回 200', async () => {
    const r = await fetch(`${base}/healthz`);
    assertEqual(r.status, 200);
  });

  await t.test('新会话固定顺序 A1→B2→A3→B1→A2→B3，边界扭矩 4200/4800 均合格', async () => {
    const s = await createSession(base);
    assertEqual(s.expected_sequence, 1, '初始期待序号');
    assertEqual(s.expected_position, 'A1', '初始期待位置');
    assertEqual(JSON.stringify(s.positions), JSON.stringify(POSITIONS), '固定复核顺序');
    const torques = [4200, 4800, 4200, 4800, 4500, 4600];
    for (let i = 0; i < 6; i += 1) {
      const r = await postConf(base, s.session_id, {
        sequence: i + 1,
        position: POSITIONS[i],
        torque: torques[i],
        idempotency_key: key('happy'),
      });
      assertEqual(r.status, 201, `第 ${i + 1} 步状态码`);
      assertEqual(r.body.replayed, false, `第 ${i + 1} 步非重放`);
      assertEqual(r.body.confirmation.sequence, i + 1, `第 ${i + 1} 步序号`);
    }
    const st = await getSession(base, s.session_id);
    assertEqual(st.status, 'completed', '六步后完成');
    assertEqual(st.confirmations.length, 6, '六条确认事件');
    assertEqual(st.expected_sequence, null, '完成后无期待序号');
  });

  await t.test('同一幂等键+完全相同载荷重试：返回原确认且不推进', async () => {
    const s = await createSession(base);
    const payload = { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('replay') };
    const r1 = await postConf(base, s.session_id, payload);
    assertEqual(r1.status, 201);
    const r2 = await postConf(base, s.session_id, payload);
    assertEqual(r2.status, 200, '重试应返回 200');
    assertEqual(r2.body.replayed, true, '应标记为重放');
    assertEqual(r2.body.confirmation.id, r1.body.confirmation.id, '应返回原确认事件');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 1, '只记录一次');
    assertEqual(st.expected_sequence, 2, '推进到第 2 步后不重复推进');
  });

  await t.test('同一幂等键+不同载荷：返回 409 冲突且不推进', async () => {
    const s = await createSession(base);
    const k = key('conflict');
    await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4500, idempotency_key: k });
    const r = await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4600, idempotency_key: k });
    assertEqual(r.status, 409, '冲突状态码');
    assertEqual(r.body.error.code, 'idempotency_conflict', '冲突错误码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 1, '冲突不产生新记录');
    assertEqual(st.expected_sequence, 2, '冲突不推进');
  });

  await t.test('较小序号视为迟到：409 且不推进', async () => {
    const s = await createSession(base);
    await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('late0') });
    const r = await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('late1') });
    assertEqual(r.status, 409);
    assertEqual(r.body.error.code, 'late_sequence', '迟到错误码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 1, '迟到不产生新记录');
    assertEqual(st.expected_sequence, 2, '迟到不推进');
  });

  await t.test('较大序号视为越序：409 且不推进', async () => {
    const s = await createSession(base);
    const r = await postConf(base, s.session_id, { sequence: 3, position: 'A3', torque: 4500, idempotency_key: key('ooo') });
    assertEqual(r.status, 409);
    assertEqual(r.body.error.code, 'out_of_order_sequence', '越序错误码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 0, '越序不产生记录');
    assertEqual(st.expected_sequence, 1, '越序不推进');
  });

  await t.test('位置码与当前期待步骤不符：422 且不推进', async () => {
    const s = await createSession(base);
    const r = await postConf(base, s.session_id, { sequence: 1, position: 'B2', torque: 4500, idempotency_key: key('pos') });
    assertEqual(r.status, 422);
    assertEqual(r.body.error.code, 'position_mismatch', '位置错误码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 0, '位置不符不产生记录');
  });

  await t.test('扭矩越界（4199/4801）与非整数：拒绝且不推进', async () => {
    const s = await createSession(base);
    for (const torque of [4199, 4801]) {
      const r = await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque, idempotency_key: key('range') });
      assertEqual(r.status, 422, `扭矩 ${torque} 状态码`);
      assertEqual(r.body.error.code, 'torque_out_of_range', '扭矩错误码');
    }
    const frac = await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4500.5, idempotency_key: key('frac') });
    assertEqual(frac.status, 400, '非整数扭矩状态码');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 0, '非法扭矩不产生记录');
    assertEqual(st.expected_sequence, 1, '非法扭矩不推进');
  });

  await t.test('未知会话：读取与提交均返回 404', async () => {
    const id = '00000000-0000-0000-0000-000000000000';
    const g = await fetch(`${base}/api/sessions/${id}`);
    assertEqual(g.status, 404);
    const r = await postConf(base, id, { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('404') });
    assertEqual(r.status, 404);
  });

  await t.test('缺少必填字段或会话编号与路径不一致：400', async () => {
    const s = await createSession(base);
    const missing = await fetch(`${base}/api/sessions/${s.session_id}/confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: s.session_id, sequence: 1, position: 'A1' }),
    });
    assertEqual(missing.status, 400, '缺字段状态码');
    const mismatched = await fetch(`${base}/api/sessions/${s.session_id}/confirmations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: '00000000-0000-0000-0000-000000000000',
        sequence: 1,
        position: 'A1',
        torque: 4500,
        idempotency_key: key('mismatch'),
      }),
    });
    assertEqual(mismatched.status, 400, '会话编号不一致状态码');
  });

  await t.test('并发相同请求（触屏连点）：只记录一次确认', async () => {
    const s = await createSession(base);
    const payload = { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('race') };
    const [a, b] = await Promise.all([
      postConf(base, s.session_id, payload),
      postConf(base, s.session_id, payload),
    ]);
    const codes = [a.status, b.status].sort();
    assertEqual(JSON.stringify(codes), JSON.stringify([200, 201]), '并发应为一个 201 一个 200');
    assertEqual(a.body.confirmation.id, b.body.confirmation.id, '并发返回同一确认事件');
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations.length, 1, '并发只落库一次');
  });

  await t.test('确认事件不可变：数据库层拒绝 UPDATE/DELETE', async () => {
    const s = await createSession(base);
    await postConf(base, s.session_id, { sequence: 1, position: 'A1', torque: 4500, idempotency_key: key('immut') });
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL || 'postgres://hub:hub@db:5432/hub_review',
    });
    await client.connect();
    try {
      await assertRejects(
        () => client.query('UPDATE confirmations SET torque = 4999'),
        'UPDATE 应被触发器拒绝',
      );
      await assertRejects(
        () => client.query('DELETE FROM confirmations'),
        'DELETE 应被触发器拒绝',
      );
    } finally {
      await client.end();
    }
    const st = await getSession(base, s.session_id);
    assertEqual(st.confirmations[0].torque, 4500, '原始扭矩未被篡改');
  });

  await t.test('工单首次打开创建会话并从第一颗开始；完成两步后同码再开接续第三颗', async () => {
    const code = woCode('open');
    const first = await openWorkOrder(base, code);
    assertEqual(first.status, 201, '首次打开应创建会话');
    assertEqual(first.body.created, true, '首次打开应标记为新建');
    assertEqual(first.body.work_order_code, code, '应返回所开工单码');
    assertEqual(first.body.expected_sequence, 1, '新工单从第 1 步开始');
    assertEqual(first.body.expected_position, 'A1', '新工单从第一颗 A1 开始');
    assertEqual(first.body.confirmed_count, 0, '新工单无已确认记录');

    for (let i = 0; i < 2; i += 1) {
      const r = await postConf(base, first.body.session_id, {
        sequence: i + 1,
        position: POSITIONS[i],
        torque: 4500,
        idempotency_key: key('wo-prog'),
      });
      assertEqual(r.status, 201, `第 ${i + 1} 步确认状态码`);
    }

    const again = await openWorkOrder(base, code);
    assertEqual(again.status, 200, '再次打开应返回已绑定会话');
    assertEqual(again.body.created, false, '再次打开不应重复创建');
    assertEqual(again.body.session_id, first.body.session_id, '同一工单码只能得到同一会话');
    assertEqual(again.body.confirmed_count, 2, '应携带已确认两颗的服务端进度');
    assertEqual(again.body.expected_sequence, 3, '应接续第 3 步');
    assertEqual(again.body.expected_position, 'A3', '应接续第三颗 A3');

    const st = await getSession(base, first.body.session_id);
    assertEqual(st.work_order_code, code, '按编号读取应返回绑定的工单码');
  });

  await t.test('工单码按去除首尾空白后的值保存并去重', async () => {
    const code = woCode('trim');
    const padded = await openWorkOrder(base, `  ${code}  `);
    assertEqual(padded.status, 201, '带首尾空白的首次打开状态码');
    assertEqual(padded.body.work_order_code, code, '保存的应是去除首尾空白后的值');
    const plain = await openWorkOrder(base, code);
    assertEqual(plain.status, 200, 'trim 后同值应命中同一会话');
    assertEqual(plain.body.session_id, padded.body.session_id, 'trim 后同值应得到同一会话');
  });

  await t.test('非法工单码：空白、超长、含空白字符均 422 且不建会话', async () => {
    for (const bad of ['   ', 'A'.repeat(65), 'AB CD', 'AB\tCD']) {
      const r = await openWorkOrder(base, bad);
      assertEqual(r.status, 422, `工单码 ${JSON.stringify(bad)} 状态码`);
      assertEqual(r.body.error.code, 'invalid_work_order_code', '非法工单码错误码');
    }
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL || 'postgres://hub:hub@db:5432/hub_review',
    });
    await client.connect();
    try {
      const { rows } = await client.query(
        "SELECT count(*)::int AS n FROM sessions WHERE work_order_code = $1 OR work_order_code = ''",
        ['A'.repeat(65)],
      );
      assertEqual(rows[0].n, 0, '非法工单码不应产生会话记录');
    } finally {
      await client.end();
    }
  });

  await t.test('两个终端并发首次打开同一工单码：只产生一个会话', async () => {
    const code = woCode('race');
    const [a, b] = await Promise.all([openWorkOrder(base, code), openWorkOrder(base, code)]);
    const codes = [a.status, b.status].sort();
    assertEqual(JSON.stringify(codes), JSON.stringify([200, 201]), '并发应为一个 201 一个 200');
    assertEqual(a.body.session_id, b.body.session_id, '并发打开应得到同一会话');
    assertEqual(
      [a.body.created, b.body.created].filter(Boolean).length,
      1,
      '并发打开应只有一次标记为新建',
    );
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL || 'postgres://hub:hub@db:5432/hub_review',
    });
    await client.connect();
    try {
      const { rows } = await client.query(
        'SELECT count(*)::int AS n FROM sessions WHERE work_order_code = $1',
        [code],
      );
      assertEqual(rows[0].n, 1, '数据库中该工单码只应有一个会话');
    } finally {
      await client.end();
    }
  });

  await t.test('数据库对非空工单码强制唯一，历史空值会话不受影响', async () => {
    const code = woCode('db');
    const client = new pg.Client({
      connectionString: process.env.DATABASE_URL || 'postgres://hub:hub@db:5432/hub_review',
    });
    await client.connect();
    try {
      const { rows: nullRows } = await client.query(
        'INSERT INTO sessions DEFAULT VALUES RETURNING id',
      );
      const { rows: nullRows2 } = await client.query(
        'INSERT INTO sessions DEFAULT VALUES RETURNING id',
      );
      await client.query('INSERT INTO sessions (work_order_code) VALUES ($1)', [code]);
      await assertRejects(
        () => client.query('INSERT INTO sessions (work_order_code) VALUES ($1)', [code]),
        '重复非空工单码应被唯一约束拒绝',
      );
      await client.query('DELETE FROM sessions WHERE id = ANY($1::uuid[])', [
        [nullRows[0].id, nullRows2[0].id],
      ]);
      await client.query('DELETE FROM sessions WHERE work_order_code = $1', [code]);
    } finally {
      await client.end();
    }
  });

  await t.test('旧客户端：无请求体创建、按编号读取并完成原有六步流程', async () => {
    const s = await createSession(base);
    assertEqual(s.work_order_code, null, '旧接口创建的会话不绑定工单码');
    assertEqual(s.expected_sequence, 1, '旧接口会话从第 1 步开始');
    for (let i = 0; i < 6; i += 1) {
      const r = await postConf(base, s.session_id, {
        sequence: i + 1,
        position: POSITIONS[i],
        torque: 4500,
        idempotency_key: key('legacy'),
      });
      assertEqual(r.status, 201, `旧客户端第 ${i + 1} 步状态码`);
    }
    const st = await getSession(base, s.session_id);
    assertEqual(st.status, 'completed', '旧客户端六步后应完成');
    assertEqual(st.confirmations.length, 6, '旧客户端应有六条确认');
    assertEqual(st.work_order_code, null, '旧客户端会话保持无工单码');
  });
}
