const USER_ORIGINS = ['composer', 'bridge', 'sdk']

/**
 * True for a prompt the user wrote: not a typed command, not a hand-back, not from a peer or a timer.
 * The engine always sets `origin`; the test kit sets none on a plugin's prompt, and that counts as typed.
 * This differs from `isUserOrigin` on purpose: a prompt without an origin cannot change state (it only
 * feeds the model), while a command can, so a command without an origin fails closed.
 */
export function isFromUser(e: { isMeta?: unknown; command?: unknown; origin?: { kind: string } }): boolean {
  return e.command === undefined && !e.isMeta && (e.origin === undefined || USER_ORIGINS.includes(e.origin.kind))
}

/**
 * Origins whose prompt starts a model turn of the main session without being the person's: another session's message
 * (a subagent's hand-back arrives as `peer`), a background task's notification, a schedule, a channel, a coordinator's
 * hand-off. Left out: `observer` and `observer-activity` (an agent's loop); `plugin` (a mod's own `$.prompt.submit`; it
 * does start a turn, but none is seen yet, and the tool-call path still covers it); `unclassified` (idle notices and
 * delivery receipts, which start no turn, share it with turns the engine could not classify, and the two cannot be told apart).
 */
const TURN_ORIGINS = ['peer', 'peer-send-message', 'task-notification', 'scheduled-trigger', 'projects-relay', 'channel', 'coordinator', 'slack-ping', 'auto-continuation']

/**
 * True for a prompt that is not the person's but starts a main-session turn: it takes the reload request after a compaction.
 * `isMeta` does not matter (the recorded hand-back is meta); `turnId` marks a prompt delivered into a running turn, which
 * starts none, and a command is the person's own business.
 */
export function startsTurn(e: { isMeta?: unknown; command?: unknown; turnId?: unknown; origin?: { kind: string } }): boolean {
  return e.command === undefined && e.turnId === undefined && e.origin !== undefined && TURN_ORIGINS.includes(e.origin.kind)
}

/**
 * True when a command comes from the person: typed (`composer`), sent through the bridge, or run by the SDK host.
 * `sdk` counts because the SDK host is the person's own program. A plugin's `$.command.run`, the model and
 * every other kind do not.
 * A missing `origin` is not the person's: the engine always stamps one, so a command without it is
 * unattested and fails closed. This is the only guard in front of the verbs that change state
 * (`update`, `accept`, `pause`, ...). The test world sets `origin: { kind: 'composer' }`.
 */
export function isUserOrigin(e: { origin?: { kind: string } }): boolean {
  return e.origin !== undefined && USER_ORIGINS.includes(e.origin.kind)
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
