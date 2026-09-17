'use strict';

/*
 * 轮毂复核工位页面逻辑。
 *
 * 重试语义（与 README 一致）：
 * - 每次“用户提交意图”生成一个幂等键；网络异常导致的自动重试复用同一键，
 *   服务端据此去重：同键同载荷返回原确认，同键不同载荷判定冲突。
 * - 任何确定性拒绝（迟到/越序/位置不符/扭矩越界等）都不重试，
 *   展示拒绝原因并重新拉取服务端权威进度对齐页面。
 * - 页面刷新后从服务端重新读取进度；完成判定只以服务端状态为准。
 */

const SESSION_KEY = 'hub_review.session_id';
const REQUEST_TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 6; // 首次 + 5 次自动重试（同一幂等键）

const $ = (id) => document.getElementById(id);

const state = {
  sessionId: localStorage.getItem(SESSION_KEY),
  view: null, // 服务端权威进度
  busy: false, // 是否有提交在途（含自动重试）
  opening: false, // 是否有「打开复核」请求在途
};

function uuid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  // 非安全上下文（如内网 http）下的退化实现
  const b = window.crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function showNotice(msg) {
  $('notice').textContent = msg || '';
}

function showError(msg) {
  $('error').textContent = msg || '';
}

function showEntryError(msg) {
  $('entry-error').textContent = msg || '';
}

function clearMessages() {
  showNotice('');
  showError('');
}

async function fetchJson(path, options) {
  const res = await fetch(`/api${path}`, options);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

/** 从服务端重新读取权威进度并渲染。 */
async function refresh() {
  if (!state.sessionId) {
    state.view = null;
    render();
    return;
  }
  try {
    const { status, body } = await fetchJson(`/sessions/${state.sessionId}`);
    if (status === 404) {
      localStorage.removeItem(SESSION_KEY);
      state.sessionId = null;
      state.view = null;
      showNotice('原会话已不存在，请开始新会话');
    } else if (status === 200) {
      state.view = body;
    } else {
      showError('读取进度失败，请稍后点击「刷新进度」');
    }
  } catch {
    showError('无法连接服务器，页面进度可能不是最新');
  }
  render();
}

async function startSession() {
  if (state.busy || state.opening) return;
  clearMessages();
  showEntryError('');
  try {
    const { status, body } = await fetchJson('/sessions', { method: 'POST' });
    if (status !== 201) throw new Error(`HTTP ${status}`);
    state.sessionId = body.session_id;
    localStorage.setItem(SESSION_KEY, state.sessionId);
    state.view = body;
    $('torque-input').value = '';
    showNotice('新会话已开始，请按顺序复核六颗螺栓');
  } catch {
    showError('创建会话失败，请重试');
  }
  render();
}

/**
 * 以工单码打开复核：服务端在同一事务内返回已绑定会话，未绑定才创建。
 * 非法工单码停留在进入区并显示原因；查询/创建暂时失败时不覆盖本地已有会话。
 */
async function openWorkOrder() {
  if (state.busy || state.opening) return;
  const code = $('work-order-input').value.trim();
  showEntryError('');
  if (code === '') {
    showEntryError('请输入或扫描工单码');
    return;
  }

  state.opening = true;
  render();
  try {
    const { status, body } = await fetchJson(
      `/work-orders/${encodeURIComponent(code)}/session`,
      { method: 'POST' },
    );
    if (status === 200 || status === 201) {
      state.sessionId = body.session_id;
      localStorage.setItem(SESSION_KEY, state.sessionId);
      state.view = body;
      $('torque-input').value = '';
      $('work-order-input').value = '';
      clearMessages();
      showNotice(
        status === 201
          ? `工单 ${body.work_order_code} 已绑定新会话，请从第一颗开始复核`
          : `已接入工单 ${body.work_order_code} 的复核（已确认 ${body.confirmed_count} / 6）`,
      );
    } else if (status === 400) {
      // 非法工单码：停留在进入区，展示服务端给出的原因，不影响已有会话
      showEntryError((body && body.error && body.error.message) || '工单码非法');
    } else {
      // 暂时失败：不覆盖本地已有会话
      showEntryError('暂时无法打开该工单，请稍后重试；当前会话不受影响');
    }
  } catch {
    showEntryError('网络异常，未能打开工单；当前会话不受影响');
  } finally {
    state.opening = false;
    render();
  }
}

/** 提交当前螺栓的复核确认；网络异常时以同一幂等键自动重试。 */
async function submitConfirmation() {
  if (state.busy || !state.view || state.view.status !== 'in_progress') return;

  const raw = $('torque-input').value.trim();
  const torque = Number(raw);
  if (raw === '' || !Number.isInteger(torque)) {
    showError('请输入整数扭矩值（cN·m）');
    return;
  }

  clearMessages();
  // 一次提交意图 = 一个幂等键；自动重试不得更换
  const attempt = {
    session_id: state.sessionId,
    sequence: state.view.expected_sequence,
    position: state.view.expected_position,
    torque,
    idempotency_key: uuid(),
  };

  state.busy = true;
  render();
  try {
    for (let i = 1; i <= MAX_ATTEMPTS; i += 1) {
      try {
        const res = await fetch(`/api/sessions/${state.sessionId}/confirmations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(attempt),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = await res.json().catch(() => null);
        if (res.ok) {
          await refresh();
          $('torque-input').value = '';
          showNotice(
            body && body.replayed
              ? `第 ${attempt.sequence} 步已确认（网络重试，服务端去重）`
              : `第 ${attempt.sequence} 步确认成功`,
          );
          return;
        }
        // 确定性拒绝：不重试，展示原因并以权威进度对齐
        const message = (body && body.error && body.error.message) || `HTTP ${res.status}`;
        showError(`第 ${attempt.sequence} 步被拒绝：${message}`);
        await refresh();
        return;
      } catch {
        if (i === MAX_ATTEMPTS) {
          showError('网络异常，多次重试仍失败；请检查网络后重新提交');
          await refresh(); // 之前的尝试可能已落库，以服务端为准
          return;
        }
        const delay = Math.min(500 * 2 ** (i - 1), 4000);
        showNotice(`网络异常，${delay / 1000}s 后自动重试（第 ${i} 次）…`);
        await sleep(delay);
      }
    }
  } finally {
    state.busy = false;
    render();
  }
}

function render() {
  const view = state.view;

  $('work-order-code').textContent = (view && view.work_order_code) || '—';
  $('session-id').textContent = state.sessionId ? state.sessionId.slice(0, 8) : '—';
  $('session-id').title = state.sessionId || '';
  $('start-hint').hidden = Boolean(view);

  const list = $('bolt-list');
  list.textContent = '';
  if (view) {
    view.positions.forEach((pos, i) => {
      const li = document.createElement('li');
      const confirmed = view.confirmations[i];
      const cls = confirmed ? 'done' : i === view.confirmed_count && view.status === 'in_progress' ? 'current' : 'pending';
      li.className = cls;
      const posSpan = document.createElement('span');
      posSpan.className = 'pos';
      posSpan.textContent = pos;
      const meta = document.createElement('span');
      meta.className = 'meta';
      meta.textContent = confirmed
        ? `✓ ${confirmed.torque} cN·m`
        : cls === 'current'
          ? '待复核'
          : `第 ${i + 1} 步`;
      li.append(posSpan, meta);
      list.appendChild(li);
    });
    $('progress-text').textContent = `已确认 ${view.confirmed_count} / 6`;
  } else {
    $('progress-text').textContent = '';
  }

  const inProgress = Boolean(view) && view.status === 'in_progress';
  $('work-panel').hidden = !inProgress;
  if (inProgress) {
    $('current-position').textContent = view.expected_position;
    $('current-seq').textContent = String(view.expected_sequence);
  }

  const completed = Boolean(view) && view.status === 'completed';
  $('done-banner').hidden = !completed;
  if (completed) {
    const tbody = $('confirm-table').querySelector('tbody');
    tbody.textContent = '';
    for (const c of view.confirmations) {
      const tr = document.createElement('tr');
      for (const text of [
        c.sequence,
        c.position,
        c.torque,
        new Date(c.confirmed_at).toLocaleString('zh-CN', { hour12: false }),
        `${c.idempotency_key.slice(0, 8)}…`,
      ]) {
        const td = document.createElement('td');
        td.textContent = text;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  $('btn-submit').disabled = state.busy || !inProgress;
  $('torque-input').disabled = state.busy || !inProgress;
  $('btn-refresh').disabled = state.busy;
  $('btn-new').disabled = state.busy || state.opening;
  $('btn-open').disabled = state.busy || state.opening;
  $('work-order-input').disabled = state.opening;
}

window.addEventListener('DOMContentLoaded', () => {
  $('btn-new').addEventListener('click', startSession);
  $('btn-open').addEventListener('click', openWorkOrder);
  $('btn-refresh').addEventListener('click', refresh);
  $('btn-submit').addEventListener('click', submitConfirmation);
  $('work-order-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') openWorkOrder();
  });
  $('torque-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submitConfirmation();
  });
  refresh();
});
