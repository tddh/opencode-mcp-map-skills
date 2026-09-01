// 单文件（非多文件）实现：OpenCode 会将 plugins 目录下每个 .ts 独立作为插件加载，
// 多文件相对 import 存在加载歧义风险。逻辑模块对应 docs/design.md，本文件按
// types / config / skill-loader / session / hooks 分节。

import { readFileSync, existsSync, readdirSync } from "node:fs"
import { join, resolve, dirname } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// types（最小类型定义，保持零外部依赖，仅声明本插件依赖的字段）
// ---------------------------------------------------------------------------

type LogFn = (level: "info" | "warn", message: string, extra?: unknown) => void

interface PluginContext {
  directory?: string
  client?: {
    app?: {
      log?: (input: {
        body: { service: string; level: string; message: string; extra?: unknown }
      }) => void
    }
  }
}

interface ToolBeforeInput {
  tool?: string
  sessionID?: string
}

// tool.execute.before 的第二个参数：完整工具参数在此（input 里拿不到 args）
interface ToolBeforeOutput {
  args?: unknown
}

interface MessageInfo {
  sessionID?: string
  id?: string
  role?: string
  providerID?: string
  modelID?: string
  error?: unknown
}

interface MessagePart {
  type?: string
  text?: string
  synthetic?: boolean
  id?: string
  sessionID?: string
  messageID?: string
  metadata?: Record<string, unknown>
}

interface ChatMessage {
  info?: MessageInfo
  parts?: MessagePart[]
}

interface TransformOutput {
  messages?: ChatMessage[]
}

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

interface McpMapConfig {
  mcpSkillBindings: Record<string, string>
  refreshTokens: number
  inactiveTokens: number
  inactiveTurns: number
}

const DEFAULT_REFRESH_TOKENS = 20000
const DEFAULT_INACTIVE_TOKENS = 60000
const DEFAULT_INACTIVE_TURNS = 3

function positiveNumber(v: unknown): number | null {
  return typeof v === "number" && v > 0 && Number.isFinite(v) ? v : null
}

function loadConfig(projectDir: string, log: LogFn): McpMapConfig | null {
  const candidates = [
    join(projectDir, ".opencode", "mcp-map-skills.json"),
    join(homedir(), ".config", "opencode", "mcp-map-skills.json"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(p, "utf-8"))
        const bindings =
          parsed && typeof parsed === "object"
            ? (parsed as Record<string, unknown>).mcpSkillBindings
            : undefined
        // 严格校验：必须是普通对象（排除 null/数组/字符串），且每个 value 都是 string
        if (
          bindings &&
          typeof bindings === "object" &&
          !Array.isArray(bindings) &&
          Object.values(bindings as Record<string, unknown>).every(
            (v) => typeof v === "string",
          )
        ) {
          const cfg = parsed as Record<string, unknown>
          return {
            mcpSkillBindings: bindings as Record<string, string>,
            refreshTokens: positiveNumber(cfg.refreshTokens) ?? DEFAULT_REFRESH_TOKENS,
            inactiveTokens: positiveNumber(cfg.inactiveTokens) ?? DEFAULT_INACTIVE_TOKENS,
            inactiveTurns: positiveNumber(cfg.inactiveTurns) ?? DEFAULT_INACTIVE_TURNS,
          }
        }
        log("warn", `配置的 mcpSkillBindings 字段无效（需为 string→string 映射）: ${p}`)
        return null
      } catch (e) {
        log("warn", `配置解析失败: ${p}`, e)
        return null
      }
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// skill-loader
// ---------------------------------------------------------------------------

interface LoadedSkill {
  name: string // frontmatter 里的 name（缺失时回退到配置名）
  content: string // 剥离 frontmatter 后的正文（原样保留，不 trim）
  sourcePath: string // SKILL.md 绝对路径
  dir: string // SKILL.md 所在目录
}

function searchDirs(projectDir: string): string[] {
  return [
    join(projectDir, ".opencode", "skills"),
    join(projectDir, ".claude", "skills"),
    join(homedir(), ".config", "opencode", "skills"),
    join(homedir(), ".claude", "skills"),
  ]
}

function findSkillFile(name: string, projectDir: string): string | null {
  // 防御路径遍历：skill 名不允许含上级引用或路径分隔符
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return null
  for (const dir of searchDirs(projectDir)) {
    const p = join(dir, name, "SKILL.md")
    if (existsSync(p)) return p
  }
  return null
}

function parseFrontmatter(raw: string): { name: string | null; content: string } {
  if (raw.startsWith("---")) {
    const m = raw.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?/)
    if (m) {
      const nameMatch = m[1].match(/^name:\s*["']?([^"'\r\n]+)["']?\s*$/m)
      return { name: nameMatch ? nameMatch[1].trim() : null, content: raw.slice(m[0].length) }
    }
  }
  return { name: null, content: raw }
}

function getSkill(
  name: string,
  projectDir: string,
  cache: Map<string, LoadedSkill>,
  log: LogFn,
): LoadedSkill | null {
  const cached = cache.get(name)
  if (cached) return cached

  const path = findSkillFile(name, projectDir)
  if (!path) return null

  try {
    const raw = readFileSync(path, "utf-8")
    const { name: fmName, content } = parseFrontmatter(raw)
    const skill: LoadedSkill = {
      name: fmName ?? name,
      content,
      sourcePath: path,
      dir: dirname(path),
    }
    cache.set(name, skill)
    return skill
  } catch (e) {
    log("warn", `读取 SKILL.md 失败: ${name}`, e)
    return null
  }
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

interface SkillState {
  mcpName: string // 触发该 skill 的 MCP 名（如 "clum"），用于注入时标注来源
  lastActiveAt: number // 上次被对应 MCP 触发的对话 token 位置
  lastActiveTurn: number // 上次被对应 MCP 触发的对话轮次（messages.transform 次数）
  lastInjectedAt: number | null // 上次注入的对话 token 位置（null = 尚未注入）
}

interface InjectCandidate {
  name: string // skill 名
  mcpName: string // 触发它的 MCP 名
}

class SessionManager {
  // 会话数上限：超出时清理最早激活的会话。OpenCode 无可靠的 session 结束 hook，
  // 只能按插入顺序近似清理；个人使用中会话数量级极小，通常不会触发。
  private static readonly MAX_SESSIONS = 1000
  private sessions = new Map<string, Map<string, SkillState>>()
  // 每个会话「上次 messages.transform 估算的对话总 token」，作为 before 激活时的近似位置
  private lastToken = new Map<string, number>()
  // 每个会话已经历的 messages.transform 轮次，用于轮次维度的失效判断
  private lastTurn = new Map<string, number>()

  activate(sessionId: string, skillName: string, mcpName: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Map())
      if (this.sessions.size > SessionManager.MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value
        if (oldest !== undefined) this.sessions.delete(oldest)
      }
    }
    const skills = this.sessions.get(sessionId)!
    const approx = this.lastToken.get(sessionId) ?? 0
    const turn = this.lastTurn.get(sessionId) ?? 0
    const existing = skills.get(skillName)
    if (existing) {
      existing.lastActiveAt = approx // 再次触发 → 仅刷新活跃位置，不强制重注入
      existing.lastActiveTurn = turn
      existing.mcpName = mcpName
    } else {
      skills.set(skillName, { mcpName, lastActiveAt: approx, lastActiveTurn: turn, lastInjectedAt: null })
    }
  }

  // 每轮 messages.transform 调用：推进时间线，返回本轮需要注入的 skill 名
  advance(
    sessionId: string,
    currentToken: number,
    refreshTokens: number,
    inactiveTokens: number,
    inactiveTurns: number,
  ): InjectCandidate[] {
    const turn = (this.lastTurn.get(sessionId) ?? 0) + 1
    this.lastTurn.set(sessionId, turn)
    this.lastToken.set(sessionId, currentToken)
    const skills = this.sessions.get(sessionId)
    if (!skills) return []

    const toInject: InjectCandidate[] = []
    for (const [name, st] of skills) {
      // 历史被裁剪：当前 token 回退到激活位置之前 → 重置基准 + 强制重注入
      //（skill 内容很可能已被裁掉，这是防 compaction 遗忘的关键分支）
      if (currentToken < st.lastActiveAt) {
        st.lastActiveAt = currentToken
        st.lastInjectedAt = null
        toInject.push({ name, mcpName: st.mcpName })
        continue
      }
      // 失效（轮次）：连续 inactiveTurns 轮未再次触发 → 释放，省 token
      if (turn - st.lastActiveTurn > inactiveTurns) {
        skills.delete(name)
        continue
      }
      // 失效（token）：连续 inactiveTokens 未触发 → 释放，省 token
      if (currentToken - st.lastActiveAt > inactiveTokens) {
        skills.delete(name)
        continue
      }
      // 刷新：从未注入过，或距离上次注入已满 refreshTokens（注意力随 token 衰减）
      const lastInjected = st.lastInjectedAt
      if (lastInjected === null || currentToken - lastInjected >= refreshTokens) {
        st.lastInjectedAt = currentToken
        toInject.push({ name, mcpName: st.mcpName })
      }
    }
    if (skills.size === 0) {
      this.sessions.delete(sessionId)
      this.lastToken.delete(sessionId)
      this.lastTurn.delete(sessionId)
    }
    return toInject
  }
}

// ---------------------------------------------------------------------------
// hooks
// ---------------------------------------------------------------------------

function matchMcp(tool: string, bindings: Record<string, string>): string | null {
  for (const server of Object.keys(bindings)) {
    if (tool === server || tool.startsWith(server + "_")) {
      return server
    }
  }
  return null
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// 识别触发 skill 的 MCP 名，返回命中列表（空 = 非目标调用）。
// 三条路径：
//   1. 直接 MCP 调用（clum_exec 等）→ 前缀匹配；新版 opencode 的 code-mode 子调用会以子工具名重触发本 hook，同样走这里
//   2. execute（code-mode 沙箱）→ 旧版不重触发子 hook，需解析 args.code 里的 tools.<server>. 调用兜底
//   3. skill_mcp（oh-my-openagent 插件）→ 内部用自有 client 直连、绝不重触发，需读 args.mcp_name
function resolveMcp(tool: string, args: unknown, bindings: Record<string, string>): string[] {
  const direct = matchMcp(tool, bindings)
  if (direct) return [direct]

  if (!args || typeof args !== "object") return []
  const obj = args as Record<string, unknown>

  if (tool === "execute") {
    const code = obj.code
    if (typeof code !== "string") return []
    const found: string[] = []
    for (const server of Object.keys(bindings)) {
      const re = new RegExp(`tools\\.${escapeRegExp(server)}(?:\\.|\\[)`)
      if (re.test(code)) found.push(server)
    }
    return found
  }

  if (tool === "skill_mcp") {
    const mcpName = obj.mcp_name
    if (typeof mcpName === "string" && bindings[mcpName]) return [mcpName]
    return []
  }

  return []
}

// 采样 skill 目录下的非 SKILL.md 文件（对齐原生 SkillTool 的 ripgrep 采样行为）
function listSkillFiles(dir: string, limit = 10): string[] {
  const result: string[] = []
  const walk = (d: string): void => {
    if (result.length >= limit) return
    let entries
    try {
      entries = readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (result.length >= limit) return
      const p = join(d, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name !== "SKILL.md") result.push(resolve(p))
    }
  }
  walk(dir)
  return result
}

// 完全复刻原生 SkillTool 的 output 格式（skill_content 包裹 + 正文原样 + 目录/文件清单）
function formatSkillOutput(skill: LoadedSkill): string {
  return [
    `<skill_content name="${skill.name}">`,
    `# Skill: ${skill.name}`,
    "",
    skill.content.trim(),
    "",
    `Base directory for this skill: ${skill.dir}`,
    "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
    "Note: file list is sampled.",
    "",
    "<skill_files>",
    listSkillFiles(skill.dir)
      .map((file) => `<file>${file}</file>`)
      .join("\n"),
    "</skill_files>",
    "</skill_content>",
  ].join("\n")
}

// 估算当前对话累计 token（chars/4，生态事实标准）。用于衡量 skill 距离生成点的
// 注意力距离，而非精确 token 数，粗略估算已足够。
function estimateContextTokens(messages: ChatMessage[]): number {
  let chars = 0
  for (const msg of messages) {
    const parts = msg.parts
    if (!parts) continue
    for (const part of parts) {
      if (typeof part.text === "string") chars += part.text.length
    }
  }
  return Math.ceil(chars / 4)
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

const createPlugin = async (ctx: PluginContext) => {
  const projectDir: string = ctx.directory ?? process.cwd()

  const log: LogFn = (level, message, extra) => {
    const fullMessage = `[mcp-map-skills] ${message}`
    if (ctx.client?.app?.log) {
      ctx.client.app.log({ body: { service: "mcp-map-skills", level, message: fullMessage, extra } })
    } else {
      const fn = level === "warn" ? console.warn : console.log
      fn(fullMessage, extra ?? "")
    }
  }

  const config = loadConfig(projectDir, log)
  const sessionManager = new SessionManager()
  const skillCache = new Map<string, LoadedSkill>()

  if (!config) {
    log("warn", "未找到配置（.opencode/mcp-map-skills.json 或 ~/.config/opencode/mcp-map-skills.json），插件不生效")
    return {}
  }

  return {
    "tool.execute.before": async (input: ToolBeforeInput, output: ToolBeforeOutput) => {
      const { tool, sessionID } = input
      if (!sessionID || !tool) return

      const mcps = resolveMcp(tool, output?.args, config.mcpSkillBindings)
      if (mcps.length === 0) return

      for (const mcp of mcps) {
        const skillName = config.mcpSkillBindings[mcp]
        const skill = getSkill(skillName, projectDir, skillCache, log)
        if (!skill) {
          log("warn", `找不到 skill "${skillName}"（MCP: ${mcp}），跳过`)
          continue
        }
        sessionManager.activate(sessionID, skillName, mcp)
        log("info", `已激活 ${skillName}（MCP: ${mcp}，工具: ${tool}）`)
      }
    },

    "experimental.chat.messages.transform": async (_input: unknown, output: TransformOutput) => {
      const messages = output?.messages
      if (!messages || messages.length === 0) return

      const last = messages[messages.length - 1]
      const sessionID = last?.info?.sessionID
      if (!sessionID) return

      const currentToken = estimateContextTokens(messages)
      const names = sessionManager.advance(
        sessionID,
        currentToken,
        config.refreshTokens,
        config.inactiveTokens,
        config.inactiveTurns,
      )
      if (names.length === 0) return

      const now = Date.now()
      const messageId = `mcp-map-skills-${now}-${Math.random().toString(36).slice(2)}`
      const textParts: MessagePart[] = []
      const injectedNames: string[] = []
      for (const { name } of names) {
        const skill = getSkill(name, projectDir, skillCache, log)
        if (!skill) continue
        injectedNames.push(skill.name)
        textParts.push({
          id: `mcp-map-skills-part-${now}-${Math.random().toString(36).slice(2)}`,
          sessionID,
          messageID: messageId,
          type: "text",
          text: formatSkillOutput(skill),
          synthetic: true,
        })
      }
      if (textParts.length === 0) return

      // 构造 assistant 消息 + synthetic 文本 part，把 skill 全文注入到「最后一条 user 消息之前」。
      // role 必须用 assistant 而非 user：user 会让 LLM 把 skill 内容误当作用户输入。
      // 旧版伪造 completed ToolPart（callID 无配对 tool call）序列化时被丢弃，是「不生效」根因；
      // text part 一定进入 LLM 上下文，synthetic 标记为合成消息（非真实对话内容）。
      const info: MessageInfo = {
        id: messageId,
        role: "assistant",
        sessionID,
      }
      let lastUserIndex = -1
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i]?.info?.role === "user") {
          lastUserIndex = i
          break
        }
      }
      if (lastUserIndex === -1) {
        messages.push({ info, parts: textParts })
      } else {
        messages.splice(lastUserIndex, 0, { info, parts: textParts })
      }
      log("info", `已注入 ${textParts.length} 个 skill（${injectedNames.join(", ")}）`)
    },
  }
}

export default {
  id: "mcp-map-skills",
  server: createPlugin,
}
