import { chromium } from 'playwright';

import { assert, assertEqual } from './helpers.js';

const POSITIONS = ['A1', 'B2', 'A3', 'B1', 'A2', 'B3'];

/** 页面测试：用真实 Chromium 驱动工位页面。 */
export async function runBrowser(webBase, apiBase, t) {
  const browser = await chromium.launch({ args: ['--no-sandbox'] });

  async function newSessionPage() {
    const page = await browser.newPage();
    page.setDefaultTimeout(20000);
    await page.goto(`${webBase}/`);
    await page.click('#btn-new');
    await page.waitForSelector('#work-panel:not([hidden])');
    return page;
  }

  async function confirmCurrent(page, torque) {
    await page.fill('#torque-input', String(torque));
    await page.click('#btn-submit');
  }

  async function currentPosition(page) {
    return (await page.textContent('#current-position')).trim();
  }

  async function serverState(page) {
    const sessionId = await page.evaluate((k) => localStorage.getItem(k), 'hub_review.session_id');
    assert(sessionId, '页面应已保存会话编号');
    const r = await fetch(`${apiBase}/api/sessions/${sessionId}`);
    assertEqual(r.status, 200, '读取会话状态码');
    return r.json();
  }

  try {
    await t.test('页面依次完成六颗螺栓并显示「轮毂复核完成」', async () => {
      const page = await newSessionPage();
      for (let i = 0; i < 6; i += 1) {
        assertEqual(await currentPosition(page), POSITIONS[i], `第 ${i + 1} 步应复核 ${POSITIONS[i]}`);
        await confirmCurrent(page, 4500);
        if (i < 5) {
          await page.waitForFunction(
            (pos) => document.getElementById('current-position').textContent.trim() === pos,
            POSITIONS[i + 1],
          );
        }
      }
      await page.waitForSelector('#done-banner:not([hidden])');
      const banner = await page.textContent('#done-banner');
      assert(banner.includes('轮毂复核完成'), '应显示完成横幅');
      assertEqual(await page.locator('#confirm-table tbody tr').count(), 6, '应列出六条确认');
      const st = await serverState(page);
      assertEqual(st.status, 'completed', '服务端状态应为完成');
      await page.close();
    });

    await t.test('越界扭矩被页面拒绝：显示原因并停留在当前螺栓', async () => {
      const page = await newSessionPage();
      await confirmCurrent(page, 5000);
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('拒绝'));
      const err = await page.textContent('#error');
      assert(err.includes('4800'), '拒绝原因应说明合格范围');
      assertEqual(await currentPosition(page), 'A1', '仍停留在 A1');
      await confirmCurrent(page, 4199);
      await page.waitForFunction(() => document.getElementById('error').textContent.includes('拒绝'));
      assertEqual(await currentPosition(page), 'A1', '再次拒绝后仍停留在 A1');
      const st = await serverState(page);
      assertEqual(st.confirmations.length, 0, '服务端无确认记录');
      await page.close();
    });

    await t.test('刷新页面后从服务端恢复权威进度', async () => {
      const page = await newSessionPage();
      await confirmCurrent(page, 4500);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      await confirmCurrent(page, 4600);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );
      await page.reload();
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'A3',
      );
      assertEqual(await page.locator('#bolt-list li.done').count(), 2, '应有两颗已确认');
      await page.close();
    });

    await t.test('网络中断时页面以同一幂等键自动重试，服务端不重复记录', async () => {
      const page = await newSessionPage();
      let aborted = 0;
      await page.route('**/api/sessions/*/confirmations', async (route) => {
        if (aborted < 2) {
          aborted += 1;
          await route.abort();
        } else {
          await route.continue();
        }
      });
      await confirmCurrent(page, 4500);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
        null,
        { timeout: 30000 },
      );
      assertEqual(aborted, 2, '应发生了两次网络中断重试');
      const st = await serverState(page);
      assertEqual(st.confirmations.length, 1, '重试不产生重复确认');
      await page.close();
    });

    await t.test('响应缓慢时触屏连点只记录一次确认', async () => {
      const page = await newSessionPage();
      await page.route('**/api/sessions/*/confirmations', async (route) => {
        await new Promise((r) => setTimeout(r, 800));
        await route.continue();
      });
      await page.fill('#torque-input', '4500');
      await page.click('#btn-submit');
      await page.click('#btn-submit', { force: true }).catch(() => {});
      const st1 = await serverState(page);
      await page.waitForFunction(
        () => document.getElementById('current-position').textContent.trim() === 'B2',
      );
      const st = await serverState(page);
      assertEqual(st.confirmations.length, 1, '连点只落库一次');
      assert(st1.confirmations.length <= 1, '提交中不应出现重复记录');
      await page.close();
    });

    await t.test('完成后刷新仍显示完成状态，且不再出现提交表单', async () => {
      const page = await newSessionPage();
      for (let i = 0; i < 6; i += 1) {
        await page.waitForFunction(
          (pos) => document.getElementById('current-position').textContent.trim() === pos,
          POSITIONS[i],
        );
        await confirmCurrent(page, 4500);
        if (i < 5) {
          await page.waitForFunction(
            (pos) => document.getElementById('current-position').textContent.trim() === pos,
            POSITIONS[i + 1],
          );
        }
      }
      await page.waitForSelector('#done-banner:not([hidden])');
      await page.reload();
      await page.waitForSelector('#done-banner:not([hidden])');
      assert(await page.isHidden('#work-panel'), '完成后不应再显示提交表单');
      await page.close();
    });
  } finally {
    await browser.close();
  }
}
