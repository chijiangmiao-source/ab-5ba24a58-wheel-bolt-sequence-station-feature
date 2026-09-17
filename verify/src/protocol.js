import pg from 'pg';

import { assert, assertEqual, assertRejects } from './helpers.js';

const POSITIONS = ['A1', 'B2', 'A3', 'B1', 'A2', 'B3'];

let keySeq = 0;
const key = (tag) => `proto-${tag}-${process.pid}-${Date.now()}-${(keySeq += 1)}`;

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
}
