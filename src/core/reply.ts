import { excludedIn, isTrustedRoot } from './config.ts'
import type { Config, ReplyLimits, SkillName } from './types.ts'

/** Fenced blocks; one that is never closed runs to the end of the answer. */
const FENCED = /```[\s\S]*?(?:```|(?![\s\S]))/g
const INLINE = /`[^`\n]*`/g
const HEADING = /^#{1,6}\s/

/**
 * Measures a chat reply: characters without fenced and inline code, and lines that are headings (outside fenced code).
 * `skip` is set when more than half of the answer is fenced code, or the answer is empty: such a reply is not checked at all.
 */
export function checkReply(answer: string, limits: ReplyLimits): { chars: number; headings: number; over: boolean; skip: boolean } {
  const prose = answer.replace(FENCED, '')
  const codeChars = answer.length - prose.length
  const text = prose.replace(INLINE, '')
  const headings = text.split('\n').filter((line) => HEADING.test(line)).length
  const chars = text.length
  const skip = answer.length === 0 || codeChars * 2 > answer.length
  const over = !skip && ((limits.maxChars !== undefined && chars > limits.maxChars) || (limits.headings !== undefined && headings > limits.headings))
  return { chars, headings, over, skip }
}

/** The always-on chat skill whose reply limits apply in this root: the first in config order that sets `reply`. */
export function replySkill(config: Config, root?: string): { name: SkillName; limits: ReplyLimits } | undefined {
  for (const [name, rule] of Object.entries(config.skills)) {
    if (rule.reply === undefined || rule.always !== true || rule.for !== 'chat' || excludedIn(rule, root)) continue
    if (rule.from === 'project' && !isTrustedRoot(config, root)) continue
    return { name, limits: rule.reply }
  }
  return undefined
}

/** The reminder line for the next prompt. A part whose limit is not set is left out. */
export function reminderLine(skill: SkillName, limits: ReplyLimits, r: { chars: number; headings: number }): string {
  const had: string[] = []
  const limit: string[] = []
  if (limits.maxChars !== undefined) { had.push(`${r.chars} characters`); limit.push(`${limits.maxChars} characters`) }
  if (limits.headings !== undefined) { had.push(`${r.headings} headings`); limit.push(`${limits.headings} headings`) }
  return `Souffleur: your last reply had ${had.join(' and ')} (limit ${limit.join(', ')}). Replies in this chat follow ${skill}.`
}
