# mcp-map-skills

OpenCode 插件：通用的「MCP → Skill」自动加载框架。通过配置把任意 MCP 绑定到任意 Skill，当 Agent 使用某个 MCP 工具时，自动将对应 Skill 的规则全文以「原生 skill 工具调用结果」形态注入到最新用户输入之前（紧邻生成点），确保规则不因长对话或 context compaction 被遗忘。

## 解决的问题

- **MCP 与 Skill 相互独立**：模型调用 MCP 工具（如 `clum_exec`）时不会主动加载对应 Skill（如 `clum-mcp`），导致操作规范丢失
- **规则被遗忘**：长对话中 skill 正文被推到历史深处（注意力衰减），或经 compaction 被摘要掉（物理衰减）
- **确定性注入**：由插件保证规则在场，不依赖模型自觉

## 工作原理

```
模型调用 MCP 工具（如 clum_host_list）
  → tool.execute.before 识别 MCP → 标记 skill 激活
  → messages.transform 按 token 间隔，构造「skill 工具调用结果」注入到最新用户输入之前
```

`tool.execute.before` 识别 MCP 时覆盖三种调用路径（`input.tool` 前缀 + `output.args` 参数）：

| 调用方式 | 顶层工具名 | 识别依据 |
|---|---|---|
| 直接调用 MCP 工具 | `clum_exec` | `input.tool` 前缀匹配 |
| 经 `execute` 沙箱间接调用 | `execute` | 解析 `output.args.code` 里的 `tools.clum.` / `tools.clum[` 调用 |
| 经 `skill_mcp` 插件间接调用 | `skill_mcp` | 读 `output.args.mcp_name`（如 `"clum"`） |

> 新版 opencode 的 code-mode 子调用会以子工具名（`clum_exec`）重新触发 hook，自动落入第一行；旧版无此行为，靠第二行兜底。`skill_mcp` 内部直连、绝不重触发，只能靠第三行。

- **原生 skill 形态注入**：注入的是一条 assistant 消息 + 已完成的 `skill` ToolPart（正文原样、零转义零截断），与模型真的调用 `skill(name=...)` 工具后的消息形态完全一致
- **token 驱动刷新**：skill 每累积 `refreshTokens`（默认 20000）token 才重新注入一次——注意力随 token 数量衰减（而非轮数），在尚未明显衰减前不重复注入，省 token
- **自动失效**：连续 `inactiveTurns`（默认 3）轮、或连续 `inactiveTokens`（默认 60000）token 未再触发对应 MCP，skill 自动失效、停止注入（任一先到即失效）
- **抗 compaction**：检测到对话历史被裁剪（token 回退）时强制重注入
- **按会话隔离**：session A 激活的 skill 不影响 session B
- **未激活零开销**：没用任何 MCP 时不注入任何内容

## 安装

### 1. 挂载插件

将 `mcp-map-skills.ts` 复制或 symlink 到 OpenCode 的全局 plugins 目录：

```bash
ln -s "$(pwd)/mcp-map-skills.ts" ~/.config/opencode/plugins/mcp-map-skills.ts
```

OpenCode 启动时自动加载 `~/.config/opencode/plugins/` 下的 `.ts` 文件，无需修改 `opencode.json`。

### 2. 配置文件

创建 `~/.config/opencode/mcp-map-skills.json`（全局）或 `<项目>/.opencode/mcp-map-skills.json`（项目级）：

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
|------|------|------|------|
| `mcpSkillBindings` | `Record<string, string>` | 是 | MCP 名 → skill 名 映射。key 是 MCP 工具名的**前缀**（如 `clum` 匹配 `clum_exec`） |
| `refreshTokens` | `number` | 否 | 活跃 skill 每累积这么多 token 重新注入一次（刷新注意力），默认 20000 |
| `inactiveTokens` | `number` | 否 | 距离上次 MCP 触发超过这个 token 量则失效（停止注入），默认 60000 |
| `inactiveTurns` | `number` | 否 | 距离上次 MCP 触发连续这么多轮（LLM 请求）未再次触发则失效（停止注入），默认 3 |

### 3. 确保 Skill 存在

Skill 文件需位于以下任一目录（按优先级搜索）：

1. `<项目>/.opencode/skills/<name>/SKILL.md`
2. `<项目>/.claude/skills/<name>/SKILL.md`
3. `~/.config/opencode/skills/<name>/SKILL.md`
4. `~/.claude/skills/<name>/SKILL.md`

## 验证

1. 重启 OpenCode
2. 新会话中调用一次目标 MCP 工具（如 `clum_host_list`）
3. 观察 OpenCode 日志（日志文件，非 TUI 界面）出现两条：`[mcp-map-skills] 已激活 clum-mcp（MCP: clum，工具: clum_host_list）` 和 `[mcp-map-skills] 已注入 1 个 skill（clum-mcp）`
4. 后续任意消息中，模型应自动遵守 skill 规则（上下文里能看到 `<skill_content name="clum-mcp">` 即注入成功）

## 配置任意 MCP 映射

框架本身是通用的——`mcpSkillBindings` 里**任意 MCP 前缀 → 任意 Skill** 均可映射，一个配置文件覆盖所有需要的 MCP，代码零改动：

```json
{
  "mcpSkillBindings": {
    "clum": "clum-mcp",
    "context7": "context7-usage",
    "github": "github-workflow",
    "playwright": "browser-testing"
  }
}
```

## 项目结构

```
mcp_map_skills/
├── docs/
│   └── design.md                  # 详细设计方案（架构 + 逻辑 + ADR）
├── mcp-map-skills.ts              # 插件本体（单文件）
├── mcp-map-skills.example.json    # 配置模板
└── README.md                      # 本文档
```

## 技术约束

- **仅支持 TUI 交互模式**：headless 模式（`opencode run`）下 `tool.execute.*` 不触发（OpenCode issue #41422）
- **MCP 工具名不可逆**：OpenCode 对 MCP 工具名做 sanitize（`-`/`.` → `_`），因此配置中必须显式声明 server 前缀，不能从工具名反解
- **不注册 `skill` 工具**：规避 OpenCode issue #14534（双缓存分歧）
- **间接调用的识别依赖 `output.args`**：`tool.execute.before` 的工具参数在第二个参数 `output.args`（非 `input`）。`execute` 沙箱路径靠正则解析 `code`，`skill_mcp` 路径靠 `mcp_name`——若未来 OpenCode 改变这两者的参数结构，识别可能失效

## License

MIT