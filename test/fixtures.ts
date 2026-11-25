import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const EVENT_NAMES = [
  'session.start',
  'prompt.submit',
  'tool.call',
  'skill.prompt',
  'command.run',
  'session.compact.before',
  'session.compact.after',
] as const

export type EventName = (typeof EVENT_NAMES)[number]

/** Where a prompt came from, for example `{ kind: 'sdk' }` or `{ kind: 'peer' }`. */
export type Origin = { kind: string }

export type SessionStartInput = {
  cwd: string
  surface: string | null
  isInteractive: boolean
  version: { version: string; base: string }
}

/** `text` is cut at 80 characters. `command` is set when the user typed `/name`. */
export type PromptSubmitInput = {
  text: string
  origin: Origin
  isMeta?: boolean
  command?: { name: string; args: string }
}

/** Tool arguments sit flat beside `tool`. `agentId` is set for a subagent's calls. */
export type ToolCallInput = {
  tool: string
  tool_use_id: string
  agentId?: string
  [argument: string]: unknown
}

/** The skill text is reduced to its length and its first and last characters. */
export type SkillPromptInput = { skill: string; len: number; head: string; tail: string }

export type CommandRunInput = { command: string; args: string }

/** `session.compact.before` and `.after` are the two halves of one hook. */
export type CompactInput = { trigger: string }

export type InputByEvent = {
  'session.start': SessionStartInput
  'prompt.submit': PromptSubmitInput
  'tool.call': ToolCallInput
  'skill.prompt': SkillPromptInput
  'command.run': CommandRunInput
  'session.compact.before': CompactInput
  'session.compact.after': CompactInput
}

export type FixtureEvent = {
  [E in EventName]: { event: E; at: number; session: string; input: InputByEvent[E] }
}[EventName]

export type FixtureFile = { claudeCode: string; events: FixtureEvent[] }

export function loadFixtureFile(name: string): FixtureFile {
  const path = join(import.meta.dirname, 'fixtures', `${name}.json`)
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureFile
}

export function loadFixture(name: string): FixtureEvent[] {
  return loadFixtureFile(name).events
}
