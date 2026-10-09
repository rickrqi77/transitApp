# GOLD ALERT — XAUUSD 黄金价格提醒系统

基于 **MetaTrader 5 (MQL5)** + **Cloudflare Workers / D1** + **手机网页** + **Telegram Bot** 的黄金价格提醒系统。

价格来源：**仅使用你电脑上 MT5（XMTrading）中的 XAUUSD 报价**，不使用任何第三方行情 API。

```
iPhone Safari  ──HTTPS──►  Cloudflare Worker  ◄──HTTPS──  MT5 EA (Windows)
                              │        │
                              ▼        ▼
                           Cloudflare D1    Telegram Bot ──► iPhone
```

---

## 目录结构

```
gold-alert/
├── worker/src/index.js      # Cloudflare Worker API
├── wrangler.jsonc           # Wrangler 配置
├── schema.sql               # D1 数据库结构
├── package.json
├── web/
│   ├── index.html           # 手机网页
│   ├── style.css
│   └── app.js
├── mt5/
│   └── GoldPriceAlert.mq5   # MetaTrader 5 EA（必须是 .mq5）
└── README.md
```

---

## 一、你需要准备什么

1. 一台能运行的 Windows 电脑，已安装 **MetaTrader 5**（XMTrading）
2. 一个 **Cloudflare** 账号（免费即可）
3. 一个 **Telegram** 账号
4. 一台 **iPhone**（Safari）
5. 本机安装 **Node.js**（用于部署 Worker）

> 本项目 **不使用 MT4**，EA 文件必须是 `.mq5`。

---

## 二、安装 Node.js

### Windows

1. 打开：https://nodejs.org/
2. 下载 LTS 版本并安装
3. 打开 **命令提示符 (CMD)** 或 **PowerShell**，输入：

```bash
node -v
npm -v
```

能显示版本号即可。

### macOS / Linux

```bash
node -v
npm -v
```

若没有，请从 https://nodejs.org/ 安装。

---

## 三、下载本项目并安装依赖

把 `gold-alert` 文件夹放到电脑上，进入该目录：

```bash
cd gold-alert
npm install
```

这会安装 Cloudflare 官方工具 **Wrangler**。

检查：

```bash
npx wrangler --version
```

---

## 四、登录 Cloudflare

```bash
npx wrangler login
```

浏览器会打开 Cloudflare 登录页，登录并授权。

确认登录成功：

```bash
npx wrangler whoami
```

---

## 五、创建 D1 数据库

```bash
npx wrangler d1 create gold-alert-db
```

命令成功后会输出类似：

```
[[d1_databases]]
binding = "DB"
database_name = "gold-alert-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**把 `database_id` 复制下来。**

打开 `wrangler.jsonc`，把：

```jsonc
"database_id": "REPLACE_WITH_YOUR_D1_DATABASE_ID"
```

改成你的真实 ID，例如：

```jsonc
"database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

保存文件。

---

## 六、执行数据库结构（schema.sql）

本地（可选，用于本地调试）：

```bash
npm run db:migrate:local
```

远程（正式环境，**必须执行**）：

```bash
npm run db:migrate:remote
```

或：

```bash
npx wrangler d1 execute gold-alert-db --remote --file=./schema.sql
```

---

## 七、生成并设置 API Token

API Token 用于保护接口，手机网页和 MT5 EA 都要用它。

### 生成一个随机 Token（示例）

可以自己想一串足够长的随机字符，例如：

```
gold_alert_7f3a9c2e1b8d4e6f0a5c9b2d
```

### 写入 Cloudflare Secret（正式环境）

```bash
npx wrangler secret put API_TOKEN
```

按提示粘贴你的 Token，回车。

> Token **不要**写进 HTML / JS 源码里。手机网页第一次打开时会让你手动输入，并保存在浏览器 `sessionStorage`。

---

## 八、创建 Telegram Bot 并获取 Chat ID

### 8.1 创建 Bot

1. 打开 Telegram，搜索 `@BotFather`
2. 发送 `/newbot`
3. 按提示设置名称
4. BotFather 会给你一个 **Bot Token**，形如：`123456789:AAH...`
5. **妥善保存**，不要发给别人，不要写进网页或 EA

### 8.2 获取 Chat ID

1. 用你的 iPhone 打开刚创建的 Bot，点 **Start**
2. 随便发一条消息给 Bot（例如：`hi`）
3. 在浏览器打开（把 `BOT_TOKEN` 换成你的）：

```
https://api.telegram.org/botBOT_TOKEN/getUpdates
```

4. 在返回的 JSON 里找到 `"chat":{"id": 数字`，那个数字就是 **Chat ID**  
   （个人号一般是正数，例如 `123456789`）

### 8.3 把 Telegram 信息写入 Cloudflare Secret

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
```

粘贴 Bot Token。

```bash
npx wrangler secret put TELEGRAM_CHAT_ID
```

粘贴 Chat ID。

> Telegram Bot Token **只会**存在 Cloudflare Worker Secret 中。  
> 不会出现在 HTML、JavaScript、MT5 EA、API 响应里。

---

## 九、部署 Worker

```bash
npm run deploy
```

或：

```bash
npx wrangler deploy
```

成功后会显示类似：

```
Published gold-alert
  https://gold-alert.<你的子域>.workers.dev
```

**记下这个网址**，后面手机和 MT5 都要用。

假设你的地址是：

```
https://gold-alert.xxxxx.workers.dev
```

则：

- 手机网页：`https://gold-alert.xxxxx.workers.dev/`
- API 根地址：`https://gold-alert.xxxxx.workers.dev`

---

## 十、手机网页使用方法（iPhone Safari）

1. Safari 打开：`https://gold-alert.xxxxx.workers.dev/`
2. 输入你刚才设置的 **API Token**，点「解锁」
3. 页面会显示：
   - **GOLD ALERT**
   - XAUUSD 当前价格（来自 EA 上传的 MT5 价格）
   - EA 在线 / 离线状态
4. 设置间隔（例如 `5`）
5. 可「设定」生成上下各 5 档 + 当前整数价（最多 11 个）
6. 点「保存设置」

### 功能说明

| 功能 | 说明 |
|------|------|
| 当前价格 | 最近一次 EA 上传的 MT5 XAUUSD 价格 |
| EA 状态 | `last_seen` 超过约 15 秒 → 🔴 离线 |
| 自动生成 ±5档 | 以当前 EA 价格为中心，上下各 5 个（不含当前价） |
| 保存设置 | 写入 D1，EA 约 3 秒内自动同步 |
| 全部清除 | 删除全部提醒 |

> 网页关闭后，EA **继续工作**。重新打开网页会从 API 读取最新状态。

---

## 十一、安装 MT5 EA（重要）

### 11.1 复制文件

1. 打开 MetaTrader 5
2. 菜单：**文件 → 打开数据文件夹**
3. 进入：`MQL5 / Experts`
4. 把本项目的 `mt5/GoldPriceAlert.mq5` 复制进去

### 11.2 用 MetaEditor 编译

1. 在 MT5 中按 **F4** 打开 MetaEditor  
   （或：工具 → MetaQuotes Language Editor）
2. 在左侧导航找到 `Experts / GoldPriceAlert.mq5`
3. 打开后按 **F7**（Compile）编译
4. 下方应显示 `0 error(s)`
5. 回到 MT5，在「导航」→「Expert Advisors」中应出现 **GoldPriceAlert**

> Cursor / 本开发环境 **无法直接编译 MQL5**。  
> 必须在 Windows 上的 **MetaEditor** 中编译。

### 11.3 允许 WebRequest（必须做，否则 EA 无法联网）

1. MT5 菜单：**工具 → 选项**
2. 打开 **Expert Advisors**（智能交易）
3. 勾选：**允许算法交易**（Allow Algo Trading）
4. 勾选：**允许 WebRequest 访问下列 URL**（Allow WebRequest for listed URL）
5. 在列表中 **添加你的 Worker 地址**，例如：

```
https://gold-alert.xxxxx.workers.dev
```

6. 点「确定」

> 不要假设 WebRequest 默认可用。不加 URL 会出现错误 **4060**。

### 11.4 挂载 EA 到黄金图表

1. 打开 XMTrading 的黄金图表（可能是 `XAUUSD` / `GOLD` / `XAUUSD#` 等）
2. 把 **GoldPriceAlert** 拖到图表上
3. 在参数里设置：

| 参数 | 示例 | 说明 |
|------|------|------|
| `InpApiBaseUrl` | `https://gold-alert.xxxxx.workers.dev` | **不要**末尾斜杠 |
| `InpApiToken` | （你的 API Token） | 与 Cloudflare Secret 相同 |
| `InpSymbol` | （留空） | 留空 = 使用当前图表品种 |
| `InpSyncSeconds` | `3` | 每 3 秒同步服务器 |
| `InpEnableTelegram` | `true` | 触发后通知 Cloudflare 发 Telegram |

4. 勾选「允许算法交易」
5. 确认 MT5 顶部「Algo Trading」按钮为 **绿色开启**

### 11.5 查看日志

打开 MT5 下方 **「专家」(Experts)** 标签，应看到类似：

```
[GoldAlert] EA initialized
[GoldAlert] Symbol: XAUUSD
[GoldAlert] API connected
[GoldAlert] Config version: 1
[GoldAlert] Loaded 0 alerts
[GoldAlert] Price: 3978.25
```

若出现：

```
[GoldAlert] ERROR: WebRequest failed. Error=4060
```

说明 URL 未加入白名单，请回到 **11.3** 重新配置。

---

## 十二、本地开发（可选）

```bash
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 填入 API_TOKEN / TELEGRAM_* 

npm run db:migrate:local
npm run dev
```

浏览器打开 Wrangler 提示的本地地址（通常是 `http://127.0.0.1:8787`）。

---

## 十三、API 一览

所有接口都需要 Header：

```
Authorization: Bearer <API_TOKEN>
```

| 方法 | 路径 | 用途 |
|------|------|------|
| GET | `/api/status` | 当前价格、EA 在线状态 |
| GET | `/api/alerts` | 提醒列表 |
| POST | `/api/alerts` | 保存提醒（最多 11） |
| DELETE | `/api/alerts/:id` | 删除单个提醒 |
| POST | `/api/alerts/auto` | 按当前 EA 价格自动生成 ±5 档 |
| POST | `/api/ea/heartbeat` | EA 心跳 + 上传价格 |
| GET | `/api/config` | EA 拉取提醒配置（含 version） |
| POST | `/api/alert-trigger` | EA 通知触发 → Worker 发 Telegram |
| GET/POST | `/api/settings` | 间隔等设置 |

### 自动生成示例

当前价 `4181.2`，先取整数 `4181` 作为基数，间隔 `5`，生成 11 档：

```
4156  4161  4166  4171  4176
4181   ← 当前整数价，默认不触发
4186  4191  4196  4201  4206
```

---

## 十四、突破逻辑说明

对每个提醒价 `P`：

- **上涨穿越**：上一价 `< P` 且 当前价 `>= P` → 发送 ↑ 上涨
- **下跌穿越**：上一价 `> P` 且 当前价 `<= P` → 发送 ↓ 下跌

触发后，价格继续停在同一侧 **不会重复提醒**。  
必须重新穿越到另一侧后，才允许同方向再次提醒。

服务器也会：

1. 拒绝同一 `alert_id` 的同方向连续触发
2. 当价格回到另一侧时重新解锁（通过 heartbeat）
3. 短时间防抖，避免重复发送

Telegram 消息示例：

```
3983.25 _ 3983.31
```

---

## 十五、验收测试清单

按顺序做：

| # | 测试 | 期望结果 |
|---|------|----------|
| 1 | EA 挂载并联网 | 网页显示 🟢 EA 在线 + 当前价 |
| 2 | 手机添加 `4000` 并保存 | EA 日志出现同步到 4000 |
| 3 | 点「自动生成 ±5档」 | 生成 10 个价格 |
| 4 | 间隔改为 `10` 再生成 | 间隔为 10 |
| 5 | 删除一个价格并保存 | EA 约 3 秒内同步 |
| 6 | 价格向上穿越 | Telegram 收到 ↑ 上涨 |
| 7 | 价格向下穿越 | Telegram 收到 ↓ 下跌 |
| 8 | 同侧持续波动 | **不**重复发送 |
| 9 | 重新穿越 | 可再次提醒 |
| 10 | 关闭手机网页 | EA 仍继续工作 |
| 11 | 关闭 EA，等 >15 秒 | 网页 🔴 EA 离线 |
| 12 | 重启 EA | 网页恢复 🟢 EA 在线 |

---

## 十六、常见问题

### Q: WebRequest Error=4060

在 MT5：**工具 → 选项 → Expert Advisors**，把 Worker URL 加入白名单。

### Q: 如何远程暂停 EA 提醒？

电脑上的 MT5 无法从网页直接关闭。网页有 **暂停提醒 / 恢复提醒**：暂停后 EA 仍上传价格（显示在线），但约 3 秒内不再触发 Telegram。恢复后继续按已选中的价格提醒。

### Q: 网页显示 EA 离线

1. 确认 EA 已挂载且 Algo Trading 为绿色  
2. 确认 `InpApiBaseUrl` / `InpApiToken` 正确  
3. 查看 Experts 日志是否有 WebRequest 错误  

### Q: 收不到 Telegram

1. 确认已 `wrangler secret put TELEGRAM_BOT_TOKEN` 和 `TELEGRAM_CHAT_ID`  
2. 确认你已给 Bot 发过 `/start`  
3. 用 EA 触发一次，看 Worker 日志：`npx wrangler tail`  

### Q: XM 黄金不是叫 XAUUSD？

把 EA 拖到实际黄金图表上，`InpSymbol` **留空**即可自动使用图表品种。

### Q: EA 日志会不会把硬盘写满？

默认不会。心跳和报价不再每 3 秒写日志，只在启动、配置变化、触发提醒或出错时记录。  
MT5 日志在数据文件夹的 `Logs` / `MQL5\Logs`，通常按天分文件。旧日志可手动删除。需要详细报价日志时，把 EA 参数 `InpVerboseLog` 设为 `true`。

### Q: 手机 Token 忘了？

Token 存在 Cloudflare Secret 中。你可以用原来的字符串重新输入；若忘记，重新 `secret put API_TOKEN` 并同步更新 EA 参数。

---

## 十七、安全说明

- API 全部需要 Token，不是公开接口
- 手机网页 **不硬编码** Token（手动输入后存 sessionStorage）
- Telegram Bot Token **仅**存于 Cloudflare Worker Secret
- EA **不包含** Telegram Token；触发后由 Cloudflare 代发

---

## 十八、部署检查清单（快速版）

1. ✅ `npm install`
2. ✅ `npx wrangler login`
3. ✅ `npx wrangler d1 create gold-alert-db` → 写入 `wrangler.jsonc`
4. ✅ `npm run db:migrate:remote`
5. ✅ `npx wrangler secret put API_TOKEN`
6. ✅ `npx wrangler secret put TELEGRAM_BOT_TOKEN`
7. ✅ `npx wrangler secret put TELEGRAM_CHAT_ID`
8. ✅ `npm run deploy`
9. ✅ Safari 打开 Worker 网址，输入 Token
10. ✅ MT5 编译 `GoldPriceAlert.mq5`
11. ✅ MT5 允许 WebRequest URL
12. ✅ 挂载 EA，开启 Algo Trading
13. ✅ 按第十五节做验收测试

---

祝挂单愉快。有问题先看 MT5 **Experts** 日志和 `npx wrangler tail`。
