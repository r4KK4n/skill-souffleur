const USER_ORIGINS = ['composer', 'bridge', 'sdk']

/**
 * True for a prompt the user wrote: not a typed command, not a hand-back, not from a peer or a timer.
 * The engine always sets `origin`; the test kit sets none on a plugin's prompt, and that counts as typed.
 */
export function isFromUser(e: { isMeta?: unknown; command?: unknown; origin?: { kind: string } }): boolean {
  return e.command === undefined && !e.isMeta && (e.origin === undefined || USER_ORIGINS.includes(e.origin.kind))
}

/** True when a command was typed by the user (or sent by the bridge or SDK on their behalf); a plugin's `$.command.run` is not. */
export function isUserOrigin(e: { origin?: { kind: string } }): boolean {
  return e.origin === undefined || USER_ORIGINS.includes(e.origin.kind)
}

export type ToolFields = { path?: string; command?: string; brief?: string; skill?: string; model?: string }

/** Tool arguments sit flat on `tool.call`; only string values count. */
export function toolFields(e: Readonly<Record<string, unknown>>): ToolFields {
  const out: ToolFields = {}
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
  const path = str(e.file_path)
  const command = str(e.command)
  const brief = str(e.prompt)
  const skill = str(e.skill)
  const model = str(e.model)
  if (path !== undefined) out.path = path
  if (command !== undefined) out.command = command
  if (brief !== undefined) out.brief = brief
  if (skill !== undefined) out.skill = skill
  if (model !== undefined) out.model = model
  return out
}

/** Metadata the engine puts on every `tool.call` beside the tool's own arguments (ToolCallInput, 2.1.332). */
const RESERVED = ['tool', 'tool_use_id', 'agentId', 'requestMeta']

/** Names of the arguments a tool call actually carries: set values only, without the engine's metadata keys. */
export function presentArgs(e: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(e)
    .filter(([k, v]) => !RESERVED.includes(k) && v !== undefined && v !== null && v !== '')
    .map(([k]) => k)
}
