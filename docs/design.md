# MCP → Skill 自动加载插件 详细设计

> 本文档定义 `mcp-map-skills` 插件的设计与实现，覆盖架构与逻辑，与 `mcp-map-skills.ts` 实际实现保持一致。

**目标**：当 Agent 使用某个 MCP（如 `clum`）时，自动把与该 MCP 绑定的 Skill（如 `clum-mcp`）完整加载进上下文，并保证在长对话 / compaction 后不被遗忘。

**技术栈**：TypeScript 单文件插件，OpenCode 本地插件挂载（Bun 运行时直接执行 `.ts`），**零外部依赖**（仅用 `node:fs` / `node:path` / `node:os`）。

**架构定位**：抄 `juhas96/opencode-plugin-preload-skills` 的成熟架构（触发信号 → 会话状态 → 注入），但聚焦到「MCP 工具调用」这一个触发信号，砍掉其文件类型 / 路径 / 关键词 / agent 等无关信号。

---

## 1. 背景与问题

1. **MCP 与 Skill 相互独立**：OpenCode 里 MCP（`<server>_<tool>` 工具）和 Skill（`SKILL.md`）是两套系统。模型可能直接调用 MCP 工具，而不会主动调用 `skill()` 加载对应规则。
2. **Skill 规则会被遗忘**：即使加载过，长对话中 skill 正文被推到历史深处（注意力衰减），或经 context compaction 被摘要掉（物理衰减），规则失效。
3. **目标**：把「Skill 持久规则」的职责，从"依赖模型自觉调用"改为"插件确定性注入"。

---

## 2. 需求定义（已确认）

| # | 需求 | 说明 |
|---|---|---|
| R1 | 调用 MCP 时按需加载完整 Skill | 用 MCP A → 自动加载 A 绑定的 Skill 全文（内容少、全必须，不拆层） |
| R2 | 防多轮 / compaction 遗忘 | 规则不因上下文增长或压缩而丢失 |
| R3 | 尽量省 token | 未激活的 MCP 零注入；激活后开销为常量 |
| R4 | 多信号判断，不无脑加载/忽略 | 主信号 = MCP 调用；预留扩展点 |
| R5 | 以 OpenCode 插件形式实现 | 不修改 OpenCode / OMO 核心 |

**明确约束**：
- skill 内容约 2000 token / 个，全必须，**不拆分 critical/full**；
- 规则粒度是 **MCP 级**（非全局、非单工具），因此不塞 AGENTS.md（全局污染）、不做 PreToolUse 逐工具 deny；
- 采用 **token 驱动刷新** 模式：按注意力衰减的 token 距离重注入（`refreshTokens`），长期不用自动失效省 token（`inactiveTokens`）。

---

## 3. 约束条件（技术事实）

### 3.1 OpenCode 插件 hook 能力

| Hook | 签名要点 | 对本插件的影响 |
|---|---|---|
| `tool.execute.before` | `(input: {tool, sessionID, callID}, output: {args})` | **主触发点**：按 `input.tool` 前缀匹配 + 解析 `output.args` 识别 `execute` / `skill_mcp` 间接调用 |
| `tool.execute.after` | `(input: {tool, sessionID, callID, args}, output: {...})` | 未使用（before 触发更早且已足够） |
| `experimental.chat.messages.transform` | `(input: {}, output: {messages})` | **主注入点**：splice 一条 assistant 消息（含已完成 skill ToolPart）到最新用户输入之前 |
| `experimental.chat.system.transform` | `(input: {sessionID?, model}, output: {system})` | 未使用（改用 messages.transform 注入生成点附近） |

> 关键事实：`messages.transform` 的 `input` 是空对象 `{}`，**拿不到 sessionID**。sessionID 需从 `output.messages` 最后一条消息的 `info.sessionID` 里提取。

### 3.2 关键已知坑（必须规避）

| 坑 | 编号 / 状态 | 规避 |
|---|---|---|
| `tool.execute.before` 的 args 在**第二个参数** `output.args`，**不在 input 里** | #18489（open） | 插件只声明 `input` 会漏掉参数；须同时声明 `output` 才能读 `output.args` |
| `tool.definition` 对 MCP 工具**不触发** | #41297 | 不用 tool.definition 注入 |
| headless 模式（`opencode run`）下 `tool.execute.*` **不触发** | #41422（open） | 明确支持范围为 TUI 交互会话 |
| 插件注册名为 `skill` 的工具会**覆盖原生 SkillTool** | #14534 | 不注册任何名为 `skill` 的工具 |
| MCP 工具调用触发 hook 是较晚才修复的 | #2319/#2320 | 当前版本已修复，可依赖 |

### 3.3 MCP 工具名格式

- OpenCode 的 MCP 工具名格式是 `sanitize(server) + "_" + sanitize(tool)`，如 `clum_exec`、`clum_host_list`。
- `sanitize()` 把 `[^a-zA-Z0-9_-]` 替换为 `_`，**不可逆**（`my-server` 与 `my_server` 都变 `my_server`）。
- **结论**：不能从工具名"猜"server 名，必须由配置显式声明 server 前缀，用前缀匹配。

---

## 4. 社区调研结论

1. **无人做过「MCP 工具调用 → 加载 skill」**：现有插件（`opencode-plugin-preload-skills`、`opencode-agent-skills`、`auto-skill-loader`）的触发信号均为文件类型 / 路径 / 关键词 / 语义匹配，均无 MCP 信号。本方向为空白。
2. **`juhas96/opencode-plugin-preload-skills` 是完整地基**：已实现「触发 → 会话状态 → 注入」模式、token 预算、防误触发。本插件抄其架构、砍其无关信号。
3. **官方正在做 compaction-reload**：但本例用「token 驱动刷新 + 历史裁剪强制重注入」绕过对官方修复的等待。
4. **Claude Code 生态**（参考）：其「渐进披露」与「compaction 后 skill 有损摘要导致假自信失败」印证了"规则应确定性重注入而非依赖摘要"的结论。

---

## 5. 架构设计

### 5.1 总览

```
OpenCode 会话
   │
   ├─ 模型调用 MCP 工具（clum_exec / clum_host_list ...）
   │      │
   │      ▼
   │  tool.execute.before  ──识别 MCP──▶ session.activate(sessionID, "clum-mcp")
   │                                      │
   ▼                                      ▼
experimental.chat.messages.transform  ◀── 估算 token → session.advance(...)
   │                                      │
   │  读 skillLoader（.config/opencode/skills/clum-mcp/SKILL.md，带缓存）
   │                                      │
   ▼                                      ▼
splice 一条 assistant 消息（skill 工具调用结果）到最新用户输入之前  ── 按 refreshTokens 间隔刷新，紧邻生成点，抗遗忘 + 抗 compaction
```

### 5.2 模块划分（单文件分节）

| 节 | 职责 | 对应代码位置 |
|---|---|---|
| `types` | 最小类型定义（替代 `any`，保持零依赖） | `PluginContext` / `MessageInfo` / `ChatMessage` 等 |
| `config` | 加载 `.opencode/mcp-map-skills.json` 或 `~/.config/opencode/mcp-map-skills.json`，解析并严格校验绑定 | `loadConfig` |
| `skill-loader` | 定位并读取 SKILL.md（路径校验 + frontmatter 解析 + 文件采样 + 内存缓存） | `getSkill` / `findSkillFile` / `parseFrontmatter` / `listSkillFiles` |
| `session` | 会话级状态机：`Map<sessionID, Map<skillName, SkillState>>`，token/轮次驱动的激活/刷新/失效 | `SessionManager` |
| `hooks` | `tool.execute.before`（触发）+ `messages.transform`（注入） | `matchMcp` / `formatSkillOutput` |
| `plugin entry` | 插件入口：组装 config + loader + session + hooks，返回 `{ id, server }` | `createPlugin` / `export default` |

### 5.3 数据流

```
[配置加载一次]
  mcpSkillBindings: { "clum": "clum-mcp" }  ── 启动时读入，常驻内存

[触发阶段，每个 MCP 调用]
  tool.execute.before(tool="clum_exec", sessionID=xxx)
    → matchMcp(tool) 命中 "clum"
    → getSkill("clum-mcp")（首次读盘，之后缓存）
    → session.activate(sessionID, "clum-mcp")

[注入阶段，每个 LLM 请求]
  messages.transform(output.messages)
    → 从最后一条消息 info 提取 sessionID
    → session.advance(...) 返回本轮需注入的 skill
    → 逐个取 skill 全文
    → 构造 skill 工具调用结果（<skill_content> 原生格式），splice 一条 assistant 消息到最新用户输入之前
```

### 5.4 文件结构

```
mcp_map_skills/
├── docs/
│   └── design.md                  # 本文档
├── mcp-map-skills.ts              # 插件（单文件，逻辑分 6 节对应 5.2）
│                                  #   - types / config / skill-loader / session / hooks / plugin entry
└── mcp-map-skills.example.json    # 配置示例（复制为 mcp-map-skills.json 使用）
```

> **落地说明**：逻辑上 5 模块，落地为**单文件**——因为 OpenCode 本地插件目录会将每个 `.ts` 文件独立作为插件加载，多文件相对 import 存在加载歧义风险（juhas96 是 npm 打包才用多文件，本地挂载用单文件最稳）。

> 挂载方式：本地插件放 `.opencode/plugins/`（项目级）或 `~/.config/opencode/plugins/`（全局），OpenCode 启动时自动加载其中的 `.ts` / `.js` 文件，无需打包、无需改 opencode.json 的 plugin 数组。

### 5.5 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 运行时 | TypeScript 直接执行 | OpenCode 内置 Bun 运行时，本地插件直接跑 .ts |
| 依赖 | **零外部依赖** | 仅用 node 内置模块，无需构建工具链 |
| SKILL.md 解析 | 自实现轻量 frontmatter 剥离 | 聚焦版不需要 full YAML；避免依赖 OMO 内部包（非稳定 API） |
| 挂载 | 本地目录（`~/.config/opencode/plugins/`） | 不走 npm 发布流程，便于迭代 |

---

## 6. 逻辑设计

### 6.1 配置 schema

文件：`.opencode/mcp-map-skills.json`（项目级）或 `~/.config/opencode/mcp-map-skills.json`（全局）。

```json
{
  "mcpSkillBindings": {
    "clum": "clum-mcp"
  },
  "refreshTokens": 20000,
  "inactiveTokens": 60000,
  "inactiveTurns": 3
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mcpSkillBindings` | `Record<string, string>` | 是 | MCP 名 → skill 名 的映射。key 是 MCP 工具名的**前缀**（如 `clum` 匹配 `clum_exec`） |
| `refreshTokens` | `number` | 否 | 活跃 skill 每累积这么多 token 重新注入一次（刷新注意力），默认 20000 |
| `inactiveTokens` | `number` | 否 | 距离上次 MCP 触发超过这个 token 量则失效，默认 60000 |
| `inactiveTurns` | `number` | 否 | 距离上次 MCP 触发连续这么多轮（LLM 请求）未再次触发则失效，默认 3 |

### 6.2 数据模型（TypeScript）

```typescript
// config
interface McpMapConfig {
  mcpSkillBindings: Record<string, string>   // "clum" -> "clum-mcp"
  refreshTokens: number   // 默认 20000
  inactiveTokens: number  // 默认 60000
  inactiveTurns: number   // 默认 3
}

// skill-loader
interface LoadedSkill {
  name: string          // frontmatter 里的 name（缺失时回退到配置名）
  content: string       // SKILL.md 剥离 frontmatter 后的正文（原样，不 trim）
  sourcePath: string    // SKILL.md 绝对路径，用于日志
  dir: string           // SKILL.md 所在目录
}

// session
interface SkillState {
  mcpName: string           // 触发该 skill 的 MCP 名（如 "clum"），用于注入时标注来源
  lastActiveAt: number      // 上次被 MCP 触发的 token 位置
  lastActiveTurn: number    // 上次被 MCP 触发的轮次（messages.transform 次数）
  lastInjectedAt: number | null // 上次注入的 token 位置（null = 尚未注入）
}

interface InjectCandidate {
  name: string          // skill 名
  mcpName: string       // 触发它的 MCP 名
}

class SessionManager { // MAX_SESSIONS = 1000
  // Map<sessionID, Map<skillName, SkillState>>；另按 sessionID 记录 lastToken 与 lastTurn
  activate(sessionId, skillName, mcpName): void
  advance(sessionId, currentToken, refreshTokens, inactiveTokens, inactiveTurns): InjectCandidate[]
}
```

### 6.3 MCP 识别逻辑（`resolveMcp`）

**输入**：`tool`（工具名）+ `args`（`output.args` 完整参数）；**输出**：命中的 MCP 名列表（空 = 非目标调用）。

```
function resolveMcp(tool, args, bindings) -> string[]:
  # 路径 1：直接前缀匹配（覆盖直接 MCP 调用 + 新版 code-mode 子调用重触发）
  direct = matchMcp(tool, bindings)          # tool === server 或 tool.startsWith(server + "_")
  if direct: return [direct]

  if !args or typeof args != "object": return []
  obj = args as object

  # 路径 2：execute（code-mode 沙箱）——旧版不重触发子 hook，解析 code 兜底
  if tool == "execute":
    code = obj.code
    if typeof code != "string": return []
    found = []
    for server in keys(bindings):
      if code 匹配 /tools\.<server>(?:\.|\[)/:  found.push(server)
    return found

  # 路径 3：skill_mcp（oh-my-openagent 插件）——内部直连绝不重触发，读 mcp_name
  if tool == "skill_mcp":
    mcpName = obj.mcp_name
    if typeof mcpName == "string" and bindings[mcpName]: return [mcpName]
    return []

  return []
```

**关键设计点**：
- **路径 1** 沿用 `matchMcp` 的显式前缀匹配（规避 sanitize 不可逆、`_` 分隔符防误匹配）。新版 opencode 的 code-mode 子调用会以子工具名（`clum_exec`）重新触发本 hook，自动落入此路径；
- **路径 2** 是旧版兜底：旧版 code-mode 不重触发子 hook，只在外层触发 `tool === "execute"`，需用正则扫描 `args.code` 里的 `tools.<server>.` / `tools.<server>[` 调用（`context7["query-docs"]` 这类带连字符工具名用方括号访问，故同时匹配 `.` 与 `[`）；
- **路径 3** 是确定性缺口：`skill_mcp` 内部用自己的 MCP client 直连、**不经过 opencode 工具循环**，绝不重触发子 hook，只能读 `args.mcp_name`（server 名，如 `"clum"`）与 `args.tool_name`；
- 三条路径均返回 `string[]`，`execute` 的 code 里若同时调用多个 MCP（`tools.clum.*` + `tools.context7.*`），一次性全部命中。

### 6.4 Skill 加载逻辑（`skill-loader`）

搜索路径（按优先级）：

1. `<项目>/.opencode/skills/<name>/SKILL.md`
2. `<项目>/.claude/skills/<name>/SKILL.md`
3. `~/.config/opencode/skills/<name>/SKILL.md`
4. `~/.claude/skills/<name>/SKILL.md`

加载流程：

```
getSkill(name, cache):
  if cache.has(name): return cache.get(name)   # 内存缓存，避免重复读盘
  path = findSkillFile(name)                    # 按上表顺序找
  if not path: return null                      # 找不到 → 上层警告后跳过
  raw = readFile(path)
  { fmName, content } = parseFrontmatter(raw)   # 解析 frontmatter 拿 name + 剥离正文
  skill = { name: fmName ?? name, content, sourcePath: path, dir: dirname(path) }
  cache.set(name, skill)
  return skill
```

### 6.5 会话状态机

```
状态：session 级，Map<sessionID, Map<skillName, SkillState>>

  [未激活]  ──tool.execute.before 命中 MCP──▶  [已激活]
                 set.add(skillName)

  有「失效」路径（轮次与 token 并行，任一先到即失效）：
  连续超 inactiveTurns 轮未触发，或连续超 inactiveTokens token 未触发，则自动反激活。
  防御性兜底：会话数超 MAX_SESSIONS(=1000) 时清理最早激活的会话
  （OpenCode 无可靠的 session 结束 hook，无法精确清理；个人使用量级极小，通常不触发）
```

### 6.6 `tool.execute.before` 处理流程

```
输入: (input: { tool, sessionID, callID }, output: { args })
输出: （不改动）

1  if !sessionID or !tool: return               # 防御
2  mcps = resolveMcp(tool, output.args, config.mcpSkillBindings)
3  if mcps.empty: return                        # 非目标 MCP，忽略
4  for mcp in mcps:
5    skillName = config.mcpSkillBindings[mcp]
6    skill = getSkill(skillName)
7    if !skill:
         log.warn("找不到 skill ...", { mcp, skillName })
         continue                              # 加载失败 → 警告后继续
8    session.activate(sessionID, skillName, mcp)
9    log.info("已激活 {skillName}（MCP: {mcp}，工具: {tool}）")
```

> 注：`tool.execute.before` 在「工具真正执行前」触发，比 `after` 更早地把 skill 标记为激活，使紧接着的下一个 LLM 请求就能注入。`execute`（code-mode）在子工具逐个执行时还会以子工具名各触发一次本 hook（新版），与路径 2 的兜底解析共存、幂等无害。

### 6.7 `experimental.chat.messages.transform` 处理流程

```
输入: {}                                        # 空对象，无 sessionID / model
输出: { messages: [...] }

1  if !messages or messages.empty: return
2  last = messages[last]
3  sessionID = last.info.sessionID               # 从最后一条消息 info 提取
4  if !sessionID: return                         # 防御
5  names = session.advance(sessionID, currentToken, refreshTokens, inactiveTokens, inactiveTurns)
6  if names.empty: return                        # 未激活任何 MCP → 零注入
7  toolParts = []
8  for { name } in names:
       skill = getSkill(name)
       if skill: toolParts.push(构造 completed skill ToolPart，output = formatSkillOutput(skill))
9  if toolParts.empty: return
10 构造一条 role="assistant" 的消息（parts = toolParts），splice(-1, 0) 插到 messages 倒数第二位（最新用户输入之前）
```

**关键点**：
- **注入到最新用户输入之前**，而非 system prompt 开头：skill 位于**生成点附近**（只隔一条真实用户消息，注意力就近），比 system 开头的注入更不容易被注意力衰减。
- **模拟 skill 工具调用结果**：注入的是一条 assistant 消息 + 已完成（completed）的 `skill` ToolPart，skill 全文放在 `state.output`——与模型真的调用 `skill(name=...)` 工具后的消息形态完全一致，走原生 tool result 通道。`role` 必须是 assistant（否则 `toModelMessagesEffect` 不识别 tool part），`error` 必须清空（否则该消息被跳过）。
- **按 token 间隔才插入一条新消息**：因为旧的历史会被截断 / compaction，token 衰减或历史裁剪时才重新注入，才能保证 skill 始终在场。这是抗遗忘的核心。
- token 成本近似常量：每轮插入一条（已激活 skill 合计），旧的一条会被历史窗口剔除。

`formatSkillOutput(skill)`（完全复刻原生 SkillTool 的 output 格式，正文原样不转义）：

```
<skill_content name="clum-mcp">
# Skill: clum-mcp

{content.trim()}

Base directory for this skill: /path/to/clum-mcp
Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.
Note: file list is sampled.

<skill_files>
<file>/path/to/clum-mcp/helper.sh</file>
</skill_files>
</skill_content>
```

对应 ToolPart：

```
{
  type: "tool", tool: "skill", callID: "<唯一ID>",
  state: {
    status: "completed",
    input: { name: "clum-mcp" },
    output: "<上面 formatSkillOutput 的结果>",
    title: "Loaded skill: clum-mcp",
    metadata: { name: "clum-mcp", dir: "/path/to/clum-mcp" },
    time: { start, end },          // 无 compacted 字段，否则 output 被清空
  }
}
```

### 6.8 边界条件与异常处理

| 场景 | 处理 |
|---|---|
| `messages.transform` 拿不到 sessionID | 直接 return（无会话无状态） |
| 未配置 `mcpSkillBindings` | 一切 hook 直接短路，零开销 |
| 配置了但 skill 文件不存在 | `tool.execute.before` 记 warn 日志，不标记激活（下次调用会重试） |
| 同一 MCP 反复调用 | 刷新该 skill 的 `lastActiveAt` 与 `lastActiveTurn`（延长活跃期），不强制重复注入 |
| 多个 MCP 激活 | 全部作为多个 ToolPart 注入到同一条 assistant 消息 |
| skill 名含 `..` / `/` / `\` | `findSkillFile` 直接 return null，防御路径遍历 |
| 对话历史被裁剪（token 回退） | `advance` 检测 `currentToken < lastActiveAt`，重置基准 + 强制重注入 |
| headless 模式 | `tool.execute.*` 不触发（#41422），功能静默失效——文档标注"仅支持 TUI 交互" |

### 6.9 省 token 策略

1. **未激活零成本**：没用任何 MCP 的会话，`messages.transform` 直接 return，0 额外 token。
2. **按会话隔离**：session A 激活了 clum，只影响 session A；session B 完全不受影响。
3. **token 驱动刷新**：仅每累积 refreshTokens 才重新注入一次，而非每轮，大幅降低长对话平均开销。
4. **自动失效**：连续 inactiveTurns 轮、或连续 inactiveTokens token 未触发的 skill 自动释放（任一先到即失效），不再产生注入成本。
5. **不重复读盘**：skill 内容内存缓存，注入阶段零 IO。

### 6.10 防遗忘机制（回应 R2）

- **注意力衰减**：skill 正文注入到**最新用户输入之前**（生成点附近），且每累积 refreshTokens 重新注入，不在注意力衰减区停留过久。
- **物理衰减 / compaction**：`advance` 检测 token 回退（历史被裁剪）时强制重注入，compaction 无法永久剪掉它。**无需** `experimental.session.compacting` 的额外补偿逻辑。

---

## 7. 关键决策记录（ADR 摘要）

| # | 决策 | 备选 | 理由 |
|---|---|---|---|
| D1 | 走 `tool.execute.before` 触发（而非 after） | after | 只按 tool 前缀匹配、不需要 args；before 触发更早，skill 激活后紧接着的请求即可注入 |
| D2 | `messages.transform` 注入最新用户输入之前（而非 system.transform 注入 system 最前） | system.transform | 注入到生成点附近，注意力权重更高；垫在输入前避免规则被当作最新指令；messages.transform 的 input 拿不到 sessionID 但可从消息 info 提取，可行 |
| D3 | 自解析 SKILL.md，不依赖 OMO 内部 API | 复用 `resolveSkillContentAsync` | OMO 内部包非稳定公共 API，聚焦版逻辑简单，自解析更可控 |
| D4 | 本地目录挂载，不发 npm | npm 发布 | 个人使用、快速迭代；本地 `.ts` 直接跑 |
| D5 | 不注册 `skill` 同名工具 | — | 规避 #14534 双缓存分歧 |
| D6 | token 驱动刷新（每 refreshTokens 重注入）而非每轮注入 | 每轮全量注入 | 注意力随 token 数量衰减而非轮数；每轮注入在长对话中浪费严重，token 间隔注入匹配衰减速率 |
| D7 | inactiveTokens 自动失效 | 注入后常驻到 compaction（社区默认） | 社区无「停用」先例，但常驻在超大上下文场景浪费严重；token 失效是对官方行为的改进 |
| D8 | inactiveTurns 轮次失效（与 token 失效并行，任一先到即失效） | 仅按 token 失效 | 偶然调用一次 MCP 后，若后续连续几轮未再用，token 阈值（60000）太宽松、skill 长时间在场浪费 token；轮次阈值更快释放 |
| D9 | 以原生 skill 工具调用结果形态注入（assistant + completed ToolPart） | 构造 user 消息注入（`<preloaded-skill>` 包裹） | 与模型真的调 `skill` 工具后的消息形态一致，走原生 tool result 通道；正文零转义零截断；user 消息注入的祈使式包裹易触发模型注入防御 |
| D10 | 识别三条 MCP 触发路径（直接前缀 / execute code / skill_mcp mcp_name） | 仅前缀匹配（旧） | Agent 会经 `execute` 沙箱或 `skill_mcp` 插件间接调 MCP，顶层工具名不再是 `clum_exec`，单靠前缀匹配漏判；`tool.execute.before` 的 `output.args` 可读完整参数，据此补齐两条间接路径 |

---

## 8. 已知坑清单（实现时必须遵守）

1. `tool.execute.before` 的 args 在第二个参数 `output.args`（不在 `input` 里，见 #18489）→ 插件必须声明 `output` 才能读参数；只声明 `input` 会漏掉 `execute` / `skill_mcp` 的间接调用。
2. `tool.definition` 对 MCP 不触发（#41297）→ 不用它注入。
3. headless 不触发 `tool.execute.*`（#41422）→ 支持范围 = TUI。
4. 不注册 `skill` 工具（#14534）。
5. MCP 工具名前缀不可逆（sanitize）→ 配置显式声明前缀。
6. 默认导出必须是 `{ id, server }` 结构（OpenCode v1 loader 对 raw function 默认导出会遍历具名导出并报错）。
7. `messages.transform` 的 `input` 是空对象 → sessionID 必须从 `output.messages` 最后一条的 `info.sessionID` 提取，不能依赖 `input.sessionID`。
8. `execute`（code-mode）旧版不重触发子工具 hook → 需解析 `args.code`；新版会以子工具名重触发（`code-mode.ts#L134-145`），两条路径幂等共存。
9. `skill_mcp`（oh-my-openagent 插件）内部用自有 client 直连、绝不重触发子工具 hook → 只能读 `args.mcp_name` / `args.tool_name`。

---

## 9. 里程碑与验收

- **M1（最小闭环）**：单文件插件 + 配置，实现 `clum → clum-mcp` 单映射，能"调 clum 后每轮对话里（最新用户输入之前）出现 clum-mcp 全文"。
  - 验收：开新会话 → 调一次 `clum_host_list` → 日志出现 `已激活` 与 `已注入` 两条；模型上下文里能看到 `<skill_content name="clum-mcp">`。
- **M2（边界加固）**：多 MCP 映射 + 加载失败警告 + 日志 + 路径校验。
- **M3（验证）**：构造"长对话 + 触发 compaction + 再用 clum"场景，确认规则仍在场。
- **M4（交付）**：`README.md` + 使用说明。
