# mcp-map-skills

OpenCode 插件：通用的「MCP → Skill」自动加载框架。通过配置把任意 MCP 绑定到任意 Skill，当 Agent 使用某个 MCP 工具时，自动将对应 Skill 的规则全文注入到对话上下文末尾（生成点附近），确保规则不因长对话或 context compaction 被遗忘。

## 解决的问题

- **MCP 与 Skill 相互独立**：模型调用 MCP 工具（如 `clum_exec`）时不会主动加载对应 Skill（如 `clum-mcp`），导致操作规范丢失
- **规则被遗忘**：长对话中 skill 正文被推到历史深处（注意力衰减），或经 compaction 被摘要掉（物理衰减）
- **确定性注入**：由插件保证规则在场，不依赖模型自觉

## 工作原理

```
模型调用 MCP 工具（如 clum_host_list）
  → tool.execute.before 识别 MCP → 标记会话已激活
  → experimental.chat.messages.transform 注入 skill 全文到对话末尾
```

- **注入到生成点附近**：skill 内容以一条 user 消息注入到对话末尾，紧邻模型生成点（注意力权重最高）；每轮请求重新注入，不依赖历史消息保留，抗 compaction
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
  }
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `mcpSkillBindings` | `Record<string, string>` | 是 | MCP 名 → skill 名 映射。key 是 MCP 工具名的**前缀**（如 `clum` 匹配 `clum_exec`） |
| `maxTokens` | `number` | 否 | 预留字段，当前版本**未实现**截断逻辑（代码仅声明未使用，可忽略） |

### 3. 确保 Skill 存在

Skill 文件需位于以下任一目录（按优先级搜索）：

1. `<项目>/.opencode/skills/<name>/SKILL.md`
2. `<项目>/.claude/skills/<name>/SKILL.md`
3. `~/.config/opencode/skills/<name>/SKILL.md`
4. `~/.claude/skills/<name>/SKILL.md`

## 验证

1. 重启 OpenCode
2. 新会话中调用一次目标 MCP 工具（如 `clum_host_list`）
3. 观察 OpenCode 日志（日志文件，非 TUI 界面）出现 `[mcp-map-skills] 已激活 clum-mcp（MCP: clum，工具: clum_host_list）` 行
4. 后续任意消息中，模型应自动遵守 skill 规则

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

## License

MIT