# 轮毂复核工位（hub-review）

触屏工位 + API 的真实联调项目：操作工按固定顺序 **A1 → B2 → A3 → B1 → A2 → B3** 逐颗复核轮毂的六颗螺栓，服务端以 PostgreSQL 持久化会话与**不可变确认事件**，只有在六次有效确认全部落库后才判定「轮毂复核完成」。

为避免换班、清理浏览器或多台触屏切换后找不到正在复核的轮毂，会话支持**可选的工单码绑定**：操作工在进入区输入或扫码工单码后「打开复核」，服务端按工单码返回已绑定会话（未绑定时才创建），页面随后复用同一条六步确认、重试与完成展示链路；刷新或跨设备进入均读取服务端权威进度。

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

- **协议用例**（直连 API）：固定顺序与边界扭矩（4200/4800 含边界合格）、同键同载荷重放、同键不同载荷 409、迟到 409、越序 409、位置不符 422、扭矩越界/非整数拒绝、未知会话 404、缺字段/会话编号不一致 400、并发同键只落库一次、确认事件在数据库层不可 UPDATE/DELETE、工单码首次打开/同码再开/trim 后保存与去重、非法工单码 422、并发打开同码只建一个会话、非空工单码数据库唯一约束、旧客户端无请求体创建并完成六步；
- **页面用例**（真实 Chromium 驱动页面）：六步完成并显示「轮毂复核完成」、越界扭矩被拒绝且停留在当前螺栓、刷新后从服务端恢复权威进度、网络中断时页面以同一幂等键自动重试且服务端不重复记录、慢响应下触屏连点只记录一次、完成后刷新仍保持完成态、工单码进入新工单从第一颗开始且另一浏览器输入同码接续第三颗、非法工单码停留在进入区并显示原因。

## API 协议

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/sessions` | 开始新会话（固定顺序 A1→B2→A3→B1→A2→B3），返回 `201` 与初始进度 |
| POST | `/api/work-orders/{code}/session` | 按工单码打开复核：返回该码已绑定会话（`200`），未绑定时创建（`201`） |
| GET | `/api/sessions/{id}` | 读取权威进度（页面刷新后以此为准） |
| POST | `/api/sessions/{id}/confirmations` | 提交一次复核确认 |
| GET | `/healthz` | 健康检查 |

### 工单码绑定（可选）

- 工单码按**去除首尾空白后的值**校验并保存：须为 1–64 个字符且不含空白/控制字符，否则 `422 invalid_work_order_code`，页面停留在进入区并显示原因；
- `POST /api/work-orders/{code}/session` 在**同一事务**内先查后建：已绑定时返回原会话（`200`，`created: false`），尚未绑定时才创建（`201`，`created: true`），响应体即服务端权威进度；
- 数据库对**非空工单码**建唯一索引（`sessions_work_order_code_key`，部分索引 `WHERE work_order_code IS NOT NULL`），配合 `INSERT ... ON CONFLICT DO NOTHING`，两个终端并发打开同一码只会得到**同一会话**；
- 会话响应新增 `work_order_code` 字段（未绑定为 `null`）；旧的无请求体创建接口、按编号读取与确认协议保持不变，历史会话的工单码为 `NULL`，无需补值（旧数据卷由 API 启动时的幂等迁移补充该列与索引）。

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

- 工位以**工单码进入复核**：在进入区输入或扫码工单码后「打开复核」，也可选择开始无工单会话；进入后复用同一条六步确认链路；
- 工单码非法时页面停留在进入区并显示服务端返回的原因；查询或创建暂时失败（网络异常/5xx）时不覆盖本地已有会话；
- 每次「用户提交意图」生成一个幂等键；**网络异常（超时/断连）的自动重试复用同一键**（指数退避，最多 6 次），因此重试永远不会把同一颗螺栓记两次；
- 收到确定性拒绝（4xx）不重试，展示拒绝原因并重新拉取权威进度对齐页面；
- 提交在途时禁用提交按钮，避免触屏连点产生并发提交；
- 刷新页面后重新 `GET` 权威进度；换班/清理浏览器/跨触屏后在进入区输入同一工单码即恢复服务端权威进度；「轮毂复核完成」只在服务端状态为 `completed`（即六次有效确认全部落库）时显示，否则稳定停留在当前螺栓。

## 数据模型

- `sessions(id, status, expected_sequence, work_order_code, created_at, updated_at)`：`expected_sequence` 单调递增（1→7），只在有效确认落库的同一事务中推进；`work_order_code` 可空，非空时全局唯一（部分唯一索引）；
- `confirmations(id, session_id, sequence, position, torque, idempotency_key, confirmed_at)`：不可变事件，唯一约束 `(session_id, sequence)`、`(session_id, idempotency_key)`。

重置数据：`docker compose down -v`（清空数据卷后 `db/init.sql` 会重新执行）。
