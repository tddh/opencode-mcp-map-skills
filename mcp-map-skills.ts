// 单文件（非多文件）实现：OpenCode 会将 plugins 目录下每个 .ts 独立作为插件加载，
// 多文件相对 import 存在加载歧义风险。逻辑模块对应 docs/design.md，本文件按
// config / skill-loader / session / hooks 分节。

import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

// ---------------------------------------------------------------------------
// logger（通过 ctx.client.app.log 写入 OpenCode 日志，不污染 TUI 界面）
// ---------------------------------------------------------------------------

type LogFn = (level: "info" | "warn", message: string, extra?: unknown) => void

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

interface McpMapConfig {
  mcpSkillBindings: Record<string, string>
  maxTokens?: number
}

function loadConfig(projectDir: string, log: LogFn): McpMapConfig | null {
  const candidates = [
    join(projectDir, ".opencode", "mcp-map-skills.json"),
    join(homedir(), ".config", "opencode", "mcp-map-skills.json"),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      try {
        const parsed = JSON.parse(readFileSync(p, "utf-8"))
        if (parsed && typeof parsed.mcpSkillBindings === "object") {
          return parsed as McpMapConfig
        }
        log("warn", `配置缺少 mcpSkillBindings 字段: ${p}`)
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
  name: string
  content: string
  tokenCount: number
  sourcePath: string
}

const skillCache = new Map<string, LoadedSkill>()

function searchDirs(projectDir: string): string[] {
  return [
    join(projectDir, ".opencode", "skills"),
    join(projectDir, ".claude", "skills"),
    join(homedir(), ".config", "opencode", "skills"),
    join(homedir(), ".claude", "skills"),
  ]
}

function findSkillFile(name: string, projectDir: string): string | null {
  for (const dir of searchDirs(projectDir)) {
    const p = join(dir, name, "SKILL.md")
    if (existsSync(p)) return p
  }
  return null
}

function stripFrontmatter(raw: string): string {
  if (raw.startsWith("---")) {
    const m = raw.match(/^---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/)
    if (m) return raw.slice(m[0].length)
  }
  return raw
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function getSkill(name: string, projectDir: string, log: LogFn): LoadedSkill | null {
  const cached = skillCache.get(name)
  if (cached) return cached

  const path = findSkillFile(name, projectDir)
  if (!path) return null

  try {
    const raw = readFileSync(path, "utf-8")
    const skill: LoadedSkill = {
      name,
      content: stripFrontmatter(raw).trim(),
      tokenCount: estimateTokens(raw),
      sourcePath: path,
    }
    skillCache.set(name, skill)
    return skill
  } catch (e) {
    log("warn", `读取 SKILL.md 失败: ${name}`, e)
    return null
  }
}

// ---------------------------------------------------------------------------
// session
// ---------------------------------------------------------------------------

class SessionManager {
  private sessions = new Map<string, Set<string>>()

  activate(sessionId: string, skillName: string): void {
    if (!this.sessions.has(sessionId)) {
      this.sessions.set(sessionId, new Set())
    }
    this.sessions.get(sessionId)!.add(skillName)
  }

  getActivated(sessionId: string): string[] {
    const set = this.sessions.get(sessionId)
    return set ? [...set] : []
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

function formatSkill(skill: LoadedSkill): string {
  return `<preloaded-skill name="${skill.name}" source="${skill.sourcePath}">\n${skill.content}\n</preloaded-skill>`
}

function wrap(parts: string[]): string {
  return `<preloaded-skills>\n以下 skill 已因使用对应 MCP 而自动加载，请始终遵守其中的规则：\n\n${parts.join("\n\n")}\n</preloaded-skills>`
}

// ---------------------------------------------------------------------------
// plugin entry
// ---------------------------------------------------------------------------

const createPlugin = async (ctx: any) => {
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

  if (!config) {
    log("warn", "未找到配置（.opencode/mcp-map-skills.json 或 ~/.config/opencode/mcp-map-skills.json），插件不生效")
    return {}
  }

  return {
    "tool.execute.before": async (input: any) => {
      const { tool, sessionID } = input
      if (!sessionID) return

      const mcp = matchMcp(tool, config.mcpSkillBindings)
      if (!mcp) return

      const skillName = config.mcpSkillBindings[mcp]
      const skill = getSkill(skillName, projectDir, log)
      if (!skill) {
        log("warn", `找不到 skill "${skillName}"（MCP: ${mcp}），跳过`)
        return
      }

      sessionManager.activate(sessionID, skillName)
      log("info", `已激活 ${skillName}（MCP: ${mcp}，工具: ${tool}）`)
    },

    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      const messages = output.messages
      if (!messages || messages.length === 0) return

      // messages.transform 的 input 是 {}，无法直接拿到 sessionID，
      // 从最后一条消息的 info 里提取（所有消息都自带 sessionID）
      const last = messages[messages.length - 1]
      const sessionID = last?.info?.sessionID
      if (!sessionID) return

      const names = sessionManager.getActivated(sessionID)
      if (names.length === 0) return

      const parts: string[] = []
      for (const name of names) {
        const skill = getSkill(name, projectDir, log)
        if (skill) parts.push(formatSkill(skill))
      }
      if (parts.length === 0) return

      // 注入到对话末尾：push 一条 user 消息，内容是 skill 全文，
      // 使 skill 位于生成点附近（注意力就近），而非 system prompt 开头
      const info = {
        ...last.info,
        id: `mcp-map-skills-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        role: "user",
      }
      messages.push({ info, parts: [{ type: "text", text: wrap(parts) }] })
    },
  }
}

export default {
  id: "mcp-map-skills",
  server: createPlugin,
}
