# 远程 OpenClaw(Hermes)接入方案

> 调研时间:2026-10-23(次轮修订) · 目标:把**不在本机运行**的 openclaw 接进 Agent Deck,成为一个可被派活的执行器。
> 结论基于**本机实测 + openclaw 官方仓库文档原文**。

## ⚠️ 先分清两个项目(很容易搞混)

| | **OpenClaw** | **Hermes Agent** |
|---|---|---|
| 出身 | Kimi 官方 / OpenClaw 基金会(前身 Clawdbot → Moltbot) | Nous Research, MIT |
| 仓库 | `github.com/openclaw/openclaw` | `github.com/NousResearch/hermes-agent` |
| 文档 | docs.openclaw.ai | — |
| **ACP** | ✅ `openclaw acp`,**且原生支持连远程 Gateway** | ✅ `hermes acp`(本机实测跑通) |
| 原生 runtime | Codex app-server、Copilot SDK、Claude Code CLI | Codex loop、MCP 桥、ACP adapters |

**本机跑的是 Hermes(实测对象)。目标接入的是 OpenClaw(另一个项目)。**
下面的 OpenClaw 部分依据 `github.com/openclaw/openclaw` 的 `docs/cli/acp.md`、`docs/cli/mcp.md` 原文。

---

## 一、结论先说:可行,而且比预想的简单

**关键发现:Hermes(OpenClaw)自带标准 ACP 模式,和 Kimi Code / MiniMax Code 是同一个协议。**

所以**不需要写任何协议翻译层** —— 我们现有的 ACP adapter 100% 复用,只需在 `registry.json` 里加一条记录。

### 实测证据

```
$ hermes acp --check
Hermes ACP check OK

$ hermes acp --version
0.19.0
```

用**我们自己的 `AcpSession`**(Agent Deck 网关里那一个)直接驱动:

```
命令: hermes acp
握手能力: {"capabilities":{"loadSession":true,"promptCapabilities":{"image":true},
          "sessionCapabilities":{"fork":{},"list":{},"resume":{}}},
          "agentInfo":{"name":"hermes-agent","version":"0.19.0"}}
握手成功
session/new -> {"_meta":{"hermes":{"sessionProvenance":{"acpSessionId":"...","currentHermesSessionId":"..."}}}}
session/prompt -> {"stopReason":"end_turn","usage":{"inputTokens":19129,"outputTokens":20}}
回复:应收账款按挂账时间长短分档,用来判断客户欠款多久了、风险多大。
```

**握手、session/new、session/prompt 全部一次通过,拿到正常中文回复。**

---

## 二、远程化只需要换一条命令

ACP over stdio 的本质是「stdin/stdout 讲 JSON-RPC」。SSH 的 stdin/stdout 天然就是管道:

```json
{
  "id": "openclaw",
  "name": "OpenClaw",
  "protocol": "acp",
  "cmd": ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
          "root@remote-host", "hermes", "acp"]
}
```

**零新代码。** 其余全部自动继承:

| 能力 | 怎么来的 | 是否要改代码 |
|---|---|---|
| 身份卡注入 | 走 `session/new` 的 `agent_config`(hermes 已返回 `_meta.hermes`,说明它认这个参数) | 否 |
| 免确认(不弹审批) | 我们的 client 自动回 `allow_always` | 否 |
| 路径白名单 | 网关侧 `_guard`,按 agent 可分别授权 | 否 |
| 空闲回收 / 崩溃自愈 | pool 的 idle reap + session 重建 | 否 |
| 派活 | `registry.json` 的 keywords / 身份卡 | 只加一条记录 |

**远程机器上需要做的**:
1. 装 hermes,`hermes acp --check` 通过,配好 provider 与登录态
2. `hermes serve` 如需对外服务,**只 bind 127.0.0.1**,再用 SSH 端口转发进来
3. 配好 SSH key 认证(`BatchMode=yes` 禁止交互式密码提示,避免挂死)

> Hermes 2026-06 硬化说明:`--insecure` 已废弃为 no-op,**公网 bind 永远要求 auth provider(password 或 OAuth)**。
> 官方建议就是 `127.0.0.1 + tunnel` —— 我们的 SSH 接入天然符合这个姿势。

---

## 三、唯一的真实差异:文件在哪台机器上

这是必须讲清楚的一点,别被"协议打通了"骗了。

ACP 里,`fs/read_text_file` / `fs/write_text_file` 是 **agent 向 client 请求**,client 负责实际读本地文件。
协议上完全支持远程 agent 读我们本机的文件。

**但实测发现:Hermes 自己的实现优先用自己的 Read 工具**(走它自己那台机器的文件系统),没有主动走 client 的 fs 能力。
我那次探测里 `fs 请求:无`,但它照样念出了 `AGENTS.md` 的标题 —— 因为测试是同机,掩盖了这个差异。

所以远程场景下,远程 agent 要读到**我们本机**的 uploads/outputs,三条路:

| 方案 | 做法 | 代价 | 评价 |
|---|---|---|---|
| **A1. 开关** | 查 hermes 有没有"优先用 client fs 能力"的配置 | 最小 | **先查这个** |
| **A2. 反向隧道挂 MCP** | 我们在本机跑一个 MCP server(读工作区目录),`ssh -R` 暴露给远程,再在 `session/new` 的 `mcpServers` 里声明 | 中等 | 通用解法,任何 ACP agent 都适用 |
| **A3. 职责分工** | 远程 agent 只出主意/写作/审阅,文件落地交给本机三套 | 零 | 立刻可用 |

**推荐 A3 先跑通、A2 作为增强。** 因为"远程大脑 + 本机文件"这个组合,天然适合"远程做判断、本机做交付"。

### 安全边界(必须写死)

- 远程 agent 拿到的 fs 路径**按 agent 区分**:Kimi 只读 uploads,openclaw 只写 outputs —— 我们的 `_guard` 支持按 agent 收窄白名单
- 远程 provider 凭证留在远程,不下沉到本机
- SSH 走密钥,`BatchMode=yes` 禁交互
- 远程 agent **不能**在本机执行任意命令(ACP 没这个能力,只有 fs 读写)—— 这点比 SSH 隧道安全得多

---

## 四、三条路径横向对比

| 路径 | 改动量 | 拿到的能力 | 依赖 | 适合 |
|---|---|---|---|---|
| **A. SSH + `hermes acp`** | registry 加 1 条 | **完整**:工具调用 + fs + 审批 + 流式 | SSH 通道 | ✅ **推荐** |
| B. `hermes serve` WS + 协议翻译 | 300~500 行双向翻译 | 完整 | 依赖 hermes 私有协议,升级会碎 | 不想依赖 SSH 时 |
| C. `hermes proxy`(OpenAI 兼容) | 写 1 个 adapter | **只有文本**,拿不到工具执行/文件 | HTTP | 只想加"另一个大脑" |

**路径 B 的坑**:`/api/ws` 跑的是 hermes 自己的 `tui_gateway.dispatch` 协议(给它的 dashboard 用),**不是 ACP**。翻译层要跟着它的私有协议走,版本一升就可能碎。
**路径 A 没这个问题** —— `hermes acp` 是对外承诺的 ACP 契约。

---

## 五、落地清单

1. 远程机装 hermes,`hermes acp --check` 通过,配好 provider
2. SSH key 互通,验证 `ssh -T host 'hermes acp'` 能起来
3. `registry.json` 加 openclaw 条目(带 `key`/`logo`/`identity`/`keywords`)
4. 身份卡照常在网页左栏「团队」里编辑
5. 派活:说"让 OpenClaw 审一下这个方案",它会被选中
6. 需要它读本机文件时,再上 A2(反向隧道 MCP)

**风险与已知代价**:
- 远程 agent 慢(多一跳网络 + 远端模型延迟)
- SSH 断了 → ACP 进程死 → pool 自动重建(已实测过 kill 自愈路径)
- 它和 Kimi 若共用 provider,会抢配额
- Hermes 的 ACP 只声明了 `promptCapabilities.image`,没有 audio —— 能力矩阵会自动反映出来,不会误导用户

---

## 六、附:调研过程中的关键事实

| 事实 | 出处 |
|---|---|
| Hermes Agent v0.19.0,Python,pip 安装 | `hermes version` |
| `hermes acp` = ACP over stdio,给 VS Code / Zed / JetBrains 用 | `hermes acp --help` |
| `hermes serve --port --host` = JSON-RPC/WebSocket gateway,给桌面 app 和 **remote clients** | `hermes serve --help` |
| WS 端点 `/api/ws`(JSON-RPC,驱动 `tui_gateway.dispatch`)、`/api/pty`、`/api/pub`、`/api/events`、`/api/console` | `hermes_cli/web_server.py` |
| HTTP API `/api/chat`、`/api/files/*`、`/api/fs/*`、`/api/git/*` | 同上 |
| `--insecure` 已废弃为 no-op;2026-06 硬化后公网 bind 永远要 auth provider | `hermes serve --help` |
| 源码里确有 `acp_adapter/`(server/session/permissions/auth/events)与 `acp_registry/` | `~/.hermes/hermes-agent/` |
| `hermes proxy` = 本地 OpenAI 兼容代理 | `hermes --help` |
| 本机已有 hermes 在跑(gateway,496MB),可直接当"外部 agent"做同机验证 | `ps` |


---

# 修订:OpenClaw(不是 Hermes)—— 官方文档原文依据

## 一、结论:**能,而且零翻译层**

`docs/cli/acp.md` 原文:

> `openclaw acp` speaks ACP over stdio for IDEs and **forwards prompts to the Gateway over WebSocket**,
> keeping ACP sessions mapped to Gateway session keys.

用法(原文):
```bash
openclaw acp
# Remote Gateway
openclaw acp --url wss://gateway-host:18789 --token <token>
# Remote Gateway (token from file)
openclaw acp --url wss://gateway-host:18789 --token-file ~/.openclaw/gateway.token
```

**所以注册进 Agent Deck 就是一条记录:**
```json
{
  "id": "openclaw", "name": "OpenClaw", "protocol": "acp",
  "cmd": ["openclaw","acp","--url","wss://<host>:18789","--token-file","/path/to/oc.token"]
}
```
我们的 `AcpSession` 是标准的 ACP client,`initialize / newSession / prompt` 在 OpenClaw 桥上**全部 Implemented**
(官方兼容矩阵原文)。身份卡注入、免确认审批、路径白名单、崩溃自愈、空闲回收 —— **全部零改动继承**。

## 二、但有三个硬限制(官方兼容矩阵原文,必须提前知道)

| ACP 能力 | OpenClaw 桥状态 | 对我们的影响 |
|---|---|---|
| `initialize` / `newSession` / `prompt` / `cancel` | Implemented | ✅ 核心链路没问题 |
| Thought streaming | Implemented | ✅ 思考过程能流式 |
| Tool streaming | Partial | ⚠️ 有工具名和文件路径,**没有结构化 diff** |
| Exec approvals | Partial | ✅ **会回传 `session/request_permission`** → 我们的自动放行能用 |
| Session modes | Partial | ⚠️ 只暴露 thought level / tool verbosity / reasoning / usage / elevated actions;**模型选择和 exec host 不能通过 ACP 配** |
| **`fs/read_text_file` / `fs/write_text_file`** | **Unsupported** | ❌ **远程 openclaw 读不到我们本机的 uploads/outputs** |
| **Per-session `mcpServers`** | **Unsupported** | ❌ 桥模式拒绝每会话注入 MCP;要让它用我们的工具得在 **Gateway 侧**配 |

> **"远程大脑 + 本机文件"这个组合,走 `openclaw acp` 桥是做不到的** —— 它只会用自己那台机器的文件系统。
> 想让它读写本机文件,只有两条:① 在 Gateway 侧配 outbound MCP(指向我们) ② 改成"远程只出主意、本机落地文件"的职责分工。

## 三、落地路径(按实际可行性排序)

### 路径 A:Gateway 已可从公网访问(有公网 IP / 内网穿透)
→ **今天就能接**。registry 加一条上面那个记录即可,零翻译层。
→ 前提:① `wss://host:18789` 我们能连上 ② 有 token

### 路径 B:Gateway 只在本机(127.0.0.1:18789),但具备本地执行命令权限
→ **反向 SSH 隧道**(方向是"他连我们",不需要给我们服务器权限):
```bash
ssh -N -R 18789:127.0.0.1:18789 ubuntu@<thailand>
```
→ 我们这边连 `ws://127.0.0.1:18789`(经隧道),或直接用 `wss://` + 现有 TLS。
→ 本服务器本来就跑着 frp(端口 7000/19080),也可以走 frp。

### 路径 C:完全碰不到那台机器
→ 走 chat 渠道(openclaw 支持 WhatsApp / Telegram / Discord / Slack / Signal / 微信 / IMAP 邮件)
→ 我们发任务给它、它回结果。拿不到工具流式细节和文件操作。
→ 或 `openclaw mcp serve`:让**它**当 MCP server,我们做 MCP client 去调它 —— 但仍要求它的 MCP 端口可达。

## 四、部署前需要确认的三件事

1. openclaw 装在哪台机器?**能不能执行命令**?
2. 那个机器的 Gateway(默认 18789)**现在能不能从公网访问**?
3. "没有服务器访问权限"是指不能 SSH 进去,**还是那台机器根本不受你控制**(比如官方托管的网页版)?
   → 若是后者,只有路径 C 可走。
