# 轮毂复核工位（hub-review）

触屏工位 + API 的真实联调项目：操作工按固定顺序 **A1 → B2 → A3 → B1 → A2 → B3** 逐颗复核轮毂的六颗螺栓，服务端以 PostgreSQL 持久化会话与**不可变确认事件**，只有在六次有效确认全部落库后才判定「轮毂复核完成」。

工位支持两种进入方式：**输入/扫码轮毂工单码后「打开复核」**（同一事务内已绑定则返回原会话、未绑定才创建，换班/清理浏览器/多台触屏切换后按同一码即可接续权威进度），或沿用旧的「开始新会话」（不绑定工单码）。

针对现场两类典型故障做了明确的协议设计：

- **触屏重试 / 网络重试导致同一颗螺栓被记两次** → 幂等键去重：同一幂等键 + 完全相同载荷的重试返回**原确认**，不产生第二条记录；
- **迟到的旧响应错误推进下一步** → 序号守卫：小于当前期待序号的按**迟到**拒绝，大于的按**越序**拒绝，任何失败都不推进进度。

## 目录结构

```
├── docker-compose.yml   # db / api / web / verify 四个服务
├── db/init.sql          # 建表 + 唯一约束 + 不可变触发器（postgres 首次启动执行）
├── api/                 # Express API：会话与确认事件（Node 20）
├── web/                 # 工位页面（nginx 托管静态页，/api 反向代理到 api）
└── verify/              # 一次性验收服务：协议用例 + 真实浏览器（Playwright/Chromium）操作用例
```

## 运行

```bash
docker compose up --build -d db api web
# 工位页面：http://localhost:${WEB_PORT:-8080}
# API：     http://localhost:${API_PORT:-3000}
```

宿主端口由环境变量覆盖（见 `.env.example`）：

```bash
WEB_PORT=9000 API_PORT=9001 docker compose up --build -d db api web
```

## 一次性验收（verify）

`verify` 是一次性服务：等待 api/web 健康后跑完全部用例并退出，退出码即验收结果。

```bash
# 方式一：起全栈并跟随 verify 的退出码（验收结束自动停掉全部容器）
docker compose up --build --exit-code-from verify

# 方式二：应用已在跑，单独执行验收
docker compose up --build -d db api web
docker compose run --rm verify
```

验收覆盖：

- **协议用例**（直连 API）：固定顺序与边界扭矩（4200/4800 含边界合格）、同键同载荷重放、同键不同载荷 409、迟到 409、越序 409、位置不符 422、扭矩越界/非整数拒绝、未知会话 404、缺字段/会话编号不一致 400、并发同键只落库一次、确认事件在数据库层不可 UPDATE/DELETE；
- **工单码用例**（直连 API）：首开创建并从第一颗开始、重复打开与带空白码均命中同一会话、完成两步后按码接续第三颗、并发首开只产生一个会话、非法码 400 及中文原因、数据库对非空工单码强制唯一且历史空值无需补值、旧客户端无请求体创建并完成六步；
- **页面用例**（真实 Chromium 驱动页面）：六步完成并显示「轮毂复核完成」、越界扭矩被拒绝且停留在当前螺栓、刷新后从服务端恢复权威进度、网络中断时页面以同一幂等键自动重试且服务端不重复记录、慢响应下触屏连点只记录一次、完成后刷新仍保持完成态、工单码首开后跨浏览器按同码接续、非法工单码停留在进入区并显示原因、打开工单暂时失败不覆盖本地已有会话。

## API 协议

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/work-orders/{code}/session` | 按工单码打开复核：同一事务内已绑定则返回原会话（`200`），尚未绑定才创建（`201`） |
| POST | `/api/sessions` | 开始新会话（固定顺序 A1→B2→A3→B1→A2→B3，不绑定工单码），返回 `201` 与初始进度 |
| GET | `/api/sessions/{id}` | 读取权威进度（页面刷新后以此为准） |
| POST | `/api/sessions/{id}/confirmations` | 提交一次复核确认 |
| GET | `/healthz` | 健康检查 |

### 工单码进入

- 工单码按**去除首尾空白后的值**校验并保存：须为 1–64 个字符（字母、数字及 `- _ .`），不含空白；非法时返回 `400 invalid_work_order_code` 与可直接展示的中文原因；
- 数据库对**非空工单码**建唯一约束（部分唯一索引），历史未绑定记录（`NULL`）无需补值、可存在多条；
- 两个终端并发打开同一码时，由唯一约束 + `ON CONFLICT` 在同一事务内兜底，**只能得到同一会话**；
- 刷新（按会话编号 `GET`）或跨设备进入（按工单码 `POST`）均读取服务端权威进度。

确认请求体：

```json
{
  "session_id": "会话编号（须与路径一致）",
  "sequence": 1,
  "position": "A1",
  "torque": 4500,
  "idempotency_key": "客户端为本次提交意图生成的唯一键"
}
```

- `sequence`：从 1 开始的整数序号；`position`：位置码；`torque`：整数（cN·m），合格范围 **4200–4800 含边界**；`idempotency_key`：1–128 字符。
- 成功：`201` `{ replayed: false, confirmation, progress }`；重放：`200` `{ replayed: true, confirmation, progress }`。
- 失败：`{ error: { code, message }, progress }`，`message` 为可直接展示的中文原因，`progress` 为当前权威进度。

### 重试语义（核心）

服务端对 `POST /confirmations` 按以下顺序判定，**任何失败都不推进进度、不消耗幂等键**：

1. **幂等键优先**（键已落库时）：
   - 载荷（序号/位置/扭矩）完全相同 → `200` 返回**原确认事件**（`replayed: true`），不重复记录；
   - 载荷不同 → `409 idempotency_conflict`，返回已存在的确认，未推进。
2. **序号守卫**（键未见过时）：
   - `sequence < 当前期待序号` → `409 late_sequence`（迟到响应，拒绝）；
   - `sequence > 当前期待序号` → `409 out_of_order_sequence`（越序，拒绝）。
3. **位置校验**：位置码与当前期待步骤不符 → `422 position_mismatch`。
4. **扭矩校验**：超出 4200–4800（含边界）→ `422 torque_out_of_range`；非整数等非法请求体 → `400 invalid_body`；未知会话 → `404 session_not_found`。

并发与一致性：同一会话的提交在事务内以 `SELECT ... FOR UPDATE` 行锁串行化；`(session_id, sequence)` 与 `(session_id, idempotency_key)` 唯一约束兜底，因此并发重试/触屏连点最多落库一条确认。确认事件表由触发器禁止 `UPDATE/DELETE`，是只增不改的事件日志。

页面侧约定：

- 进入区输入或扫码工单码后点击「打开复核」，成功后复用当前六步确认、重试与完成展示链路；**工单码非法时停留在进入区并显示原因**，查询或创建暂时失败时**不覆盖本地已有会话**；
- 每次「用户提交意图」生成一个幂等键；**网络异常（超时/断连）的自动重试复用同一键**（指数退避，最多 6 次），因此重试永远不会把同一颗螺栓记两次；
- 收到确定性拒绝（4xx）不重试，展示拒绝原因并重新拉取权威进度对齐页面；
- 提交在途时禁用提交按钮，避免触屏连点产生并发提交；
- 刷新页面后重新 `GET` 权威进度；「轮毂复核完成」只在服务端状态为 `completed`（即六次有效确认全部落库）时显示，否则稳定停留在当前螺栓。

## 数据模型

- `sessions(id, work_order_code, status, expected_sequence, created_at, updated_at)`：`work_order_code` 可空（`NULL` 表示未绑定，历史记录无需补值），非空值全局唯一；`expected_sequence` 单调递增（1→7），只在有效确认落库的同一事务中推进；
- `confirmations(id, session_id, sequence, position, torque, idempotency_key, confirmed_at)`：不可变事件，唯一约束 `(session_id, sequence)`、`(session_id, idempotency_key)`。

重置数据：`docker compose down -v`（清空数据卷后 `db/init.sql` 会重新执行）。
