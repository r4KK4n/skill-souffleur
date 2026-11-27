import { AUDIENCES } from './types.ts'
import type { Audience, Config, Need, Match, Mode, NeedName, Note, Origin, ReplyLimits, Rule, SkillName, SkillRule } from './types.ts'

type FileConfig = {
  mode?: Mode
  trustProjects?: string[]
  skills: Record<SkillName, SkillRule>
  needs: Record<NeedName, Need>
  rules: Rule[]
  notes: Note[]
  learn?: { skills: boolean }
  notices?: boolean
  update?: 'notify' | 'auto' | 'off'
  updateSigner?: string
  /** Every skill and need key the file spells out, valid or not, for clash checks. */
  skillKeys: string[]
  needKeys: string[]
  /** Raw per-project blocks of the user file by normalised root; each is parsed only for the root that is open. */
  projects: Record<string, unknown>
}

class SchemaError extends Error {}

const NAME = /^[A-Za-z0-9:_-]{1,64}$/
const MAX_SHOWN = 80

const hasLineBreak = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) === 10 || c.charCodeAt(0) === 13 || c.charCodeAt(0) === 0x2028 || c.charCodeAt(0) === 0x2029)

/** Quotes file-supplied text for an error message, cut to 80 characters. */
function show(v: unknown): string {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? String(v)
  return JSON.stringify(s.length > MAX_SHOWN ? `${s.slice(0, MAX_SHOWN)}...` : s)
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function check(ok: boolean, where: string, problem: string): void {
  if (!ok) throw new SchemaError(`${where}: ${problem}`)
}

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) check(allowed.includes(key), where, `unknown key ${show(key)}`)
}

/** A project root without trailing slashes (`/` stays), so `where` compares by name. */
export const normRoot = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, '') || '/' : p)

/** C0 and C1 controls, line separators and bidirectional controls: none belong in text that reaches the model or a dialog. */
export function hasControl(s: string): boolean {
  return [...s].some((c) => {
    const n = c.charCodeAt(0)
    return n < 0x20 || (n >= 0x7f && n <= 0x9f) || n === 0x2028 || n === 0x2029 || (n >= 0x202a && n <= 0x202e) || (n >= 0x2066 && n <= 0x2069) || n === 0x200e || n === 0x200f
  })
}

/** Entries per list, also in a project block. */
export const MAX_LIST = 20
/** Project blocks read from the user file. */
export const MAX_PROJECT_ROOTS = 50
const MAX_TOOL = 100
const MAX_GLOB = 200
/** A project file is untrusted input: it may define this many skills and needs. */
export const MAX_PROJECT_SKILLS = 20
export const MAX_PROJECT_NEEDS = 10

/** True when the skill is switched off in this main repository root (`notIn`, compared without trailing slashes like `where`). */
export const excludedIn = (rule: Pick<SkillRule, 'notIn'>, root: string | undefined): boolean =>
  root !== undefined && (rule.notIn ?? []).some((p) => normRoot(p) === normRoot(root))

/** True when `root` is one of the trusted project roots, compared without trailing slashes like `where`. */
export const isTrustedRoot = (config: Pick<Config, 'trustProjects'>, root: string | undefined): boolean =>
  root !== undefined && config.trustProjects.some((p) => normRoot(p) === normRoot(root))

/** A list of at most 20 one-line strings, each at most `max` characters. */
function stringList(v: unknown, where: string, max = MAX_GLOB): string[] {
  check(Array.isArray(v) && v.every((s) => typeof s === 'string'), where, 'must be a list of strings')
  const list = v as string[]
  check(list.length <= MAX_LIST, where, `must hold at most ${MAX_LIST} items`)
  for (const item of list) check(item.length <= max && !hasControl(item), where, `items must be one line of at most ${max} characters without control characters`)
  return [...list]
}

function checkGlob(glob: string, where: string): void {
  check(glob.length > 0, where, 'glob must not be empty')
  const bad = /[{}[\]!]/.exec(glob)
  check(bad === null, where, `glob ${show(glob)} uses "${bad?.[0]}"; only *, ** and ? are supported`)
}

function parseMatch(v: unknown, where: string): Match {
  check(isObject(v), where, 'must be an object')
  const obj = v as Record<string, unknown>
  onlyKeys(obj, ['tools', 'paths'], where)
  const match: Match = { tools: stringList(obj.tools, `${where}.tools`, MAX_TOOL) }
  check(match.tools.length > 0, `${where}.tools`, 'must not be empty')
  if (obj.paths !== undefined) {
    match.paths = stringList(obj.paths, `${where}.paths`)
    check(match.paths.length > 0, `${where}.paths`, 'must not be empty')
    for (const glob of match.paths) checkGlob(glob, `${where}.paths`)
  }
  return match
}


const ABSOLUTE = /^(\/|[A-Za-z]:[\\/])/
const isAbsolutePath = (v: unknown, max: number): v is string => typeof v === 'string' && ABSOLUTE.test(v) && !hasControl(v) && v.length <= max

const SOURCE = /^(skill(:[A-Za-z0-9:_-]{1,64})?|slip|user)$/
const FIELD = /^[A-Za-z0-9_]{1,40}$/
const ENTRY_ID = /^[A-Za-z0-9:_-]{1,64}$/
const MAX_NOTE = 500

function entryCommon(obj: Record<string, unknown>, where: string): { id: string; source: string; where?: string } {
  check(typeof obj.id === 'string' && ENTRY_ID.test(obj.id) && obj.id !== '__proto__', `${where}.id`, `must be a name of letters, digits, ":", "_" or "-", got ${show(obj.id)}`)
  const out: { id: string; source: string; where?: string } = { id: obj.id as string, source: 'user' }
  if (obj.source !== undefined) {
    check(typeof obj.source === 'string' && SOURCE.test(obj.source), `${where}.source`, `must be "user", "slip" or "skill:<name>", got ${show(obj.source)}`)
    out.source = obj.source as string
  }
  if (obj.where !== undefined) {
    check(isAbsolutePath(obj.where, 500), `${where}.where`, 'must be an absolute one-line path')
    out.where = normRoot(obj.where as string)
  }
  return out
}

/** One rule entry: exactly one kind. Throws a SchemaError that names the problem. */
export function parseRuleEntry(v: unknown, where: string): Rule {
  check(isObject(v), where, 'must be an object')
  const obj = v as Record<string, unknown>
  onlyKeys(obj, ['id', 'where', 'source', 'before', 'skill', 'field', 'after', 'evidence'], where)
  const rule: Rule = entryCommon(obj, where)
  const kinds = [obj.before !== undefined && obj.skill !== undefined, obj.before !== undefined && obj.field !== undefined, obj.after !== undefined && obj.evidence !== undefined].filter(Boolean).length
  const keys = ['before', 'skill', 'field', 'after', 'evidence'].filter((k) => obj[k] !== undefined).length
  check(kinds === 1 && keys === 2, where, 'needs exactly one of: before + skill, before + field, after + evidence')
  if (obj.before !== undefined) rule.before = parseMatch(obj.before, `${where}.before`)
  check(!(obj.skill !== undefined && rule.before?.tools.includes('Skill')), `${where}.before`, 'a skill rule cannot gate the Skill tool: it would block loading its own skill')
  if (obj.skill !== undefined) {
    check(typeof obj.skill === 'string' && NAME.test(obj.skill) && obj.skill !== '__proto__', `${where}.skill`, `must be a skill name, got ${show(obj.skill)}`)
    rule.skill = obj.skill as string
  }
  if (obj.field !== undefined) {
    check(typeof obj.field === 'string' && FIELD.test(obj.field), `${where}.field`, `must be a field name, got ${show(obj.field)}`)
    rule.field = obj.field as string
  }
  if (obj.after !== undefined) rule.after = parseMatch(obj.after, `${where}.after`)
  if (obj.evidence !== undefined) {
    check(isObject(obj.evidence), `${where}.evidence`, 'must be an object')
    const ev = obj.evidence as Record<string, unknown>
    onlyKeys(ev, ['tool', 'command'], `${where}.evidence`)
    check(typeof ev.tool === 'string' && ev.tool.length > 0 && ev.tool.length <= MAX_TOOL && !hasControl(ev.tool), `${where}.evidence.tool`, `must be a one-line string of at most ${MAX_TOOL} characters`)
    const evidence: { tool: string; command?: string } = { tool: ev.tool as string }
    if (ev.command !== undefined) {
      check(typeof ev.command === 'string' && ev.command.length <= MAX_GLOB && !hasControl(ev.command), `${where}.evidence.command`, `must be a one-line string of at most ${MAX_GLOB} characters`)
      checkGlob(ev.command as string, `${where}.evidence.command`)
      evidence.command = ev.command as string
    }
    rule.evidence = evidence
  }
  return rule
}

/** One note entry. `needs` are the need names the file defines. */
export function parseNoteEntry(v: unknown, where: string, needs: readonly string[]): Note {
  check(isObject(v), where, 'must be an object')
  const obj = v as Record<string, unknown>
  onlyKeys(obj, ['id', 'text', 'need', 'where', 'source'], where)
  const note: Note = { ...entryCommon(obj, where), text: '' }
  check(typeof obj.text === 'string' && obj.text.trim().length >= 1 && obj.text.length <= MAX_NOTE && !hasControl(obj.text), `${where}.text`, `must be one line of 1 to ${MAX_NOTE} characters`)
  note.text = (obj.text as string).trim()
  if (obj.need !== undefined) {
    check(typeof obj.need === 'string' && needs.includes(obj.need), `${where}.need`, `must name a need of the file, got ${show(obj.need)}`)
    note.need = obj.need as string
  }
  return note
}

/** Checks an entry a proposal brings, with the same rules the file is read by. */
export function checkEntry(kind: 'rule' | 'note', value: unknown, needs: readonly string[]): { entry?: Rule | Note; error?: string } {
  try {
    return { entry: kind === 'rule' ? parseRuleEntry(value, 'rule') : parseNoteEntry(value, 'note', needs) }
  } catch (e) {
    if (e instanceof SchemaError) return { error: e.message }
    throw e
  }
}

function parseName(name: string, kind: 'skill' | 'need'): void {
  check(NAME.test(name) && name !== '__proto__', `${kind} ${show(name)}`, 'name must match [A-Za-z0-9:_-] and be 1 to 64 characters')
}

const FOR_ERROR = 'must be one of chat, readers, users, work; ignored'
const isAudience = (v: unknown): v is Audience => typeof v === 'string' && (AUDIENCES as readonly string[]).includes(v)

/** Parses one need: the old string form (counts as `work`) or `{ for, what }`. */
function parseNeed(value: unknown, name: string, soft: (m: string) => void): Need {
  const where = `need ${show(name)}`
  let what: unknown = value
  let audience: Audience = 'work'
  if (isObject(value)) {
    onlyKeys(value, ['for', 'what'], where)
    if (isAudience(value.for)) {
      audience = value.for
      if (audience === 'chat') soft(`${name}.for: a chat need starts only with /souffleur need, never by itself`)
    }
    else soft(`${name}.for: must be one of chat, readers, users, work; counted as work`)
    what = value.what
  }
  check(typeof what === 'string', where, isObject(value) ? '"what" must be a string' : 'must be a string or { "for", "what" }')
  const text = what as string
  check(text.length >= 1 && text.length <= 200 && !hasLineBreak(text), where, 'text must be one line of 1 to 200 characters')
  return isObject(value) ? { for: audience, what: text } : { for: 'work', what: text, noAudience: true }
}

/** `{ maxChars: 200-20000, headings: 0-20 }`, both optional; anything else is soft-rejected whole. */
function parseReply(v: unknown, where: string, soft: (m: string) => void): ReplyLimits | undefined {
  if (!isObject(v)) return void soft(`${where}: must be an object with maxChars and headings; ignored`)
  const unknown = Object.keys(v).filter((k) => k !== 'maxChars' && k !== 'headings')
  if (unknown.length) return void soft(`${where}: unknown key ${show(unknown[0])}; ignored`)
  const out: ReplyLimits = {}
  const int = (value: unknown, lo: number, hi: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi
  if (v.maxChars !== undefined) {
    if (!int(v.maxChars, 200, 20000)) return void soft(`${where}.maxChars: must be an integer from 200 to 20000; ignored`)
    out.maxChars = v.maxChars
  }
  if (v.headings !== undefined) {
    if (!int(v.headings, 0, 20)) return void soft(`${where}.headings: must be an integer from 0 to 20; ignored`)
    out.headings = v.headings
  }
  if (out.maxChars === undefined && out.headings === undefined) return void soft(`${where}: needs maxChars or headings; ignored`)
  return out
}

function parseRule(v: unknown, where: string, source: Origin, soft: (m: string) => void, name: string): Omit<SkillRule, 'from'> {
  check(isObject(v), where, 'must be an object')
  const obj = v as Record<string, unknown>
  onlyKeys(obj, ['always', 'startup', 'need', 'gate', 'duty', 'for', 'notIn', 'reply'], where)
  const rule: Omit<SkillRule, 'from'> = {}
  if (obj.always !== undefined) {
    check(typeof obj.always === 'boolean', `${where}.always`, 'must be true or false')
    rule.always = obj.always as boolean
  }
  if (obj.startup !== undefined) {
    check(obj.startup === 'injected', `${where}.startup`, 'must be "injected"')
    rule.startup = 'injected'
  }
  if (obj.need !== undefined) {
    check(typeof obj.need === 'string' && NAME.test(obj.need) && obj.need !== '__proto__', `${where}.need`, `must be a need name, got ${show(obj.need)}`)
    rule.need = obj.need as string
  }
  check(!(rule.always === true && rule.need !== undefined), where, '"always" and "need" cannot be combined')
  check(rule.always === true || rule.need !== undefined || rule.startup !== undefined, where, 'needs one of "always", "need" or "startup"')
  if (obj.for !== undefined) {
    if (!isAudience(obj.for)) soft(`${name}.for: ${FOR_ERROR}`)
    else if (rule.always !== true) soft(`${name}.for: only for always-on skills; ignored`)
    else rule.for = obj.for
  }
  if (obj.reply !== undefined) {
    if (rule.always !== true || rule.for !== 'chat') soft(`${name}.reply: only for an always-on skill with "for": "chat"; ignored`)
    else {
      const reply = parseReply(obj.reply, `${name}.reply`, soft)
      if (reply !== undefined) rule.reply = reply
    }
  }
  if (obj.notIn !== undefined) {
    const list = obj.notIn
    if (source === 'project') soft(`${name}.notIn is only allowed in the user config; ignored`)
    else if (Array.isArray(list) && list.length <= MAX_LIST && list.every((p) => isAbsolutePath(p, MAX_GLOB))) rule.notIn = (list as string[]).map(normRoot)
    else soft(`${name}.notIn: must be a list of at most ${MAX_LIST} absolute paths; ignored`)
  }
  if (obj.gate !== undefined) {
    rule.gate = parseMatch(obj.gate, `${where}.gate`)
    check(!rule.gate.tools.includes('Skill'), `${where}.gate`, 'a gate cannot name the Skill tool: it would block loading its own skill')
  }
  if (obj.duty !== undefined) {
    check(isObject(obj.duty), `${where}.duty`, 'must be an object')
    const duty = obj.duty as Record<string, unknown>
    onlyKeys(duty, ['after', 'evidence'], `${where}.duty`)
    const after = parseMatch(duty.after, `${where}.duty.after`)
    if (!after.tools.some((t) => ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(t))) soft(`${name}.duty.after.tools: needs Write, Edit, MultiEdit or NotebookEdit; the duty never opens`)
    check(isObject(duty.evidence), `${where}.duty.evidence`, 'must be an object')
    const ev = duty.evidence as Record<string, unknown>
    onlyKeys(ev, ['tool', 'command'], `${where}.duty.evidence`)
    check(typeof ev.tool === 'string' && ev.tool.length > 0 && ev.tool.length <= MAX_TOOL && !hasControl(ev.tool), `${where}.duty.evidence.tool`, `must be a one-line string of at most ${MAX_TOOL} characters`)
    const evidence: { tool: string; command?: string } = { tool: ev.tool as string }
    if (ev.command !== undefined) {
      check(typeof ev.command === 'string' && ev.command.length <= MAX_GLOB && !hasControl(ev.command), `${where}.duty.evidence.command`, `must be a one-line string of at most ${MAX_GLOB} characters`)
      checkGlob(ev.command as string, `${where}.duty.evidence.command`)
      evidence.command = ev.command as string
    }
    rule.duty = { after, evidence }
  }
  return rule
}

/** Parses one file. Whole-file problems throw; entry problems are collected and the entry dropped. */
function parseFile(text: string, source: Origin, errors: string[], extraNeeds: readonly string[] = []): FileConfig {
  const label = `${source} config`
  const fail = (message: string): void => void errors.push(`${label}: ${message}`)
  let data: unknown
  try {
    data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch (e) {
    throw new SchemaError(`invalid JSON (${show((e as Error).message)})`)
  }
  check(isObject(data), 'top level', 'must be an object')
  const obj = data as Record<string, unknown>
  const file: FileConfig = { skills: {}, needs: {}, rules: [], notes: [], skillKeys: [], needKeys: [], projects: {} }

  for (const key of Object.keys(obj)) {
    if (key === 'skills' || key === 'needs') continue
    if (key === 'mode' || key === 'trustProjects' || key === 'rules' || key === 'notes' || key === 'learn' || key === 'notices' || key === 'update' || key === 'updateSigner' || key === 'projects') {
      if (source === 'project') fail(`${key} is only allowed in the user config; ignored`)
      continue
    }
    fail(`unknown top-level key ${show(key)}; ignored`)
  }

  if (source === 'user' && obj.mode !== undefined) {
    if (obj.mode === 'observe' || obj.mode === 'enforce') file.mode = obj.mode
    else fail('mode: must be "observe" or "enforce"; ignored')
  }
  if (source === 'user' && obj.trustProjects !== undefined) {
    const list = obj.trustProjects
    if (Array.isArray(list) && list.every((p) => typeof p === 'string' && /^(\/|[A-Za-z]:[\\/])/.test(p))) {
      file.trustProjects = (list as string[]).map(normRoot)
    } else {
      fail('trustProjects: must be a list of absolute paths; ignored')
    }
  }

  if (source === 'user' && obj.projects !== undefined) {
    if (!isObject(obj.projects)) fail('projects: must be an object; ignored')
    else {
      const entries = Object.entries(obj.projects)
      if (entries.length > MAX_PROJECT_ROOTS) fail(`projects: at most ${MAX_PROJECT_ROOTS} roots are read; the rest are ignored`)
      for (const [root, block] of entries.slice(0, MAX_PROJECT_ROOTS)) {
        if (!isAbsolutePath(root, MAX_GLOB)) errors.push(`projects[${show(root)}]: the root must be an absolute path; block ignored`)
        else if (Object.hasOwn(file.projects, normRoot(root))) errors.push(`projects[${show(root)}]: the root is listed twice; the later block is ignored`)
        else file.projects[normRoot(root)] = block
      }
    }
  }

  if (source === 'user' && obj.notices !== undefined) {
    if (typeof obj.notices === 'boolean') file.notices = obj.notices
    else fail('notices: must be true or false; ignored')
  }
  if (source === 'user' && obj.update !== undefined) {
    if (obj.update === 'notify' || obj.update === 'auto' || obj.update === 'off') file.update = obj.update
    else fail('update: must be "notify", "auto" or "off"; ignored')
  }
  if (source === 'user' && obj.updateSigner !== undefined) {
    if (typeof obj.updateSigner === 'string' && /^(ssh-|ecdsa-|sk-)\S+[ \t]+\S+(?:[ \t].*)?$/.test(obj.updateSigner) && !hasLineBreak(obj.updateSigner) && !/[\u0000-\u0008\u000a-\u001f\u007f]/.test(obj.updateSigner)) file.updateSigner = obj.updateSigner
    else fail('updateSigner: must be an SSH public key line; ignored')
  }
  if (source === 'user' && obj.learn !== undefined) {
    const l = obj.learn
    if (isObject(l) && Object.keys(l).every((k) => k === 'skills') && (l.skills === undefined || typeof l.skills === 'boolean')) file.learn = { skills: l.skills !== false }
    else fail('learn: must be { "skills": true or false }; ignored')
  }

  for (const [kind, key] of [['skill', 'skills'], ['need', 'needs']] as const) {
    const section = obj[key]
    if (section === undefined) continue
    if (!isObject(section)) {
      fail(`${key}: must be an object; ignored`)
      continue
    }
    const cap = source === 'project' ? (kind === 'skill' ? MAX_PROJECT_SKILLS : MAX_PROJECT_NEEDS) : Infinity
    const entries = Object.entries(section)
    if (entries.length > cap) fail(`${key}: at most ${cap} ${key} are read from a project file; the rest are ignored`)
    for (const [name, value] of entries.slice(0, cap)) {
      if (kind === 'need' && name === 'none') {
        fail('none: "none" is reserved; need dropped')
        continue
      }
      ;(kind === 'skill' ? file.skillKeys : file.needKeys).push(name)
      try {
        parseName(name, kind)
        if (kind === 'skill') {
          file.skills[name] = { from: source, ...parseRule(value, `skill ${show(name)}`, source, fail, name) }
        } else {
          file.needs[name] = parseNeed(value, name, fail)
        }
      } catch (e) {
        if (!(e instanceof SchemaError)) throw e
        fail(`${e.message}; entry dropped`)
      }
    }
  }

  if (source === 'user') {
    const ids = new Set<string>()
    for (const [kind, key] of [['rule', 'rules'], ['note', 'notes']] as const) {
      const list = obj[key]
      if (list === undefined) continue
      if (!Array.isArray(list)) {
        fail(`${key}: must be a list; ignored`)
        continue
      }
      for (const [i, value] of list.entries()) {
        try {
          const label = `${kind} ${i + 1}`
          const entry = kind === 'rule' ? parseRuleEntry(value, label) : parseNoteEntry(value, label, [...Object.keys(file.needs), ...extraNeeds])
          check(!ids.has(entry.id), label, `id ${show(entry.id)} is already used`)
          ids.add(entry.id)
          if (kind === 'rule') file.rules.push(entry as Rule)
          else file.notes.push(entry as Note)
        } catch (e) {
          if (!(e instanceof SchemaError)) throw e
          fail(`${e.message}; entry dropped`)
        }
      }
    }
  }
  return file
}

type Block = { blocked: string[]; blockedSkills: string[]; ownSkills: string[]; ownNotes: string[]; ownRules: string[]; ignored: string[] }

/** The names of a block's list (`block`, `ignored`): the first 20 entries, each invalid name dropped with its own error, so a typo never unblocks the rest. */
function nameList(v: unknown, where: string, errors: string[]): string[] {
  if (!Array.isArray(v)) {
    errors.push(`${where}: must be a list of names; ignored`)
    return []
  }
  if (v.length > MAX_LIST) errors.push(`${where}: at most ${MAX_LIST} names are read; the rest are ignored`)
  const out: string[] = []
  for (const n of v.slice(0, MAX_LIST)) {
    if (typeof n === 'string' && NAME.test(n) && n !== '__proto__') {
      if (!out.includes(n)) out.push(n)
    } else errors.push(`${where}: ${show(n)} is not a valid name; ignored`)
  }
  return out
}

/**
 * Applies the block of `root` to the user file: removes the blocked skills, notes and rules as if the file did not have them,
 * then adds the block's own entries, which may not reuse a name or id of what is left of the standard.
 * Errors name the entry and carry no "user config" label. Returns undefined when the root has no usable block.
 */
function applyBlock(user: FileConfig, root: string, errors: string[]): Block | undefined {
  const raw = user.projects[root]
  if (raw === undefined) return undefined
  const W = `projects[${JSON.stringify(root)}]`
  if (!isObject(raw)) {
    errors.push(`${W}: must be an object; block ignored`)
    return undefined
  }
  for (const key of Object.keys(raw)) if (!['block', 'skills', 'needs', 'notes', 'rules', 'ignored'].includes(key)) errors.push(`${W}: unknown key ${show(key)}; ignored`)
  const block: Block = { blocked: [], blockedSkills: [], ownSkills: [], ownNotes: [], ownRules: [], ignored: [] }
  if (raw.block !== undefined) block.blocked = nameList(raw.block, `${W}.block`, errors)
  if (raw.ignored !== undefined) block.ignored = nameList(raw.ignored, `${W}.ignored`, errors)

  const gone = new Set(block.blocked)
  block.blockedSkills = block.blocked.filter((n) => user.skillKeys.includes(n))
  for (const name of gone) delete user.skills[name]
  user.skillKeys = user.skillKeys.filter((n) => !gone.has(n))
  user.rules = user.rules.filter((r) => !gone.has(r.id) && !(r.skill !== undefined && gone.has(r.skill)))
  user.notes = user.notes.filter((n) => !gone.has(n.id))

  const own: Record<string, unknown> = {}
  for (const key of ['skills', 'needs', 'notes', 'rules']) {
    const v = raw[key]
    if (v === undefined) continue
    if (Array.isArray(v) ? v.length > MAX_LIST : isObject(v) && Object.keys(v).length > MAX_LIST) {
      errors.push(`${W}.${key}: at most ${MAX_LIST} entries; ignored`)
      continue
    }
    own[key] = v
  }
  const sub: string[] = []
  const mine = parseFile(JSON.stringify(own), 'user', sub, Object.keys(user.needs))
  for (const msg of sub) errors.push(`${W}: ${msg.replace(/^user config: /, '')}`)
  const taken = new Set([...user.rules, ...user.notes].map((e) => e.id))
  const clash = (path: string): void => void errors.push(`${W}.${path}: already in the standard; block it first or rename; entry dropped`)
  for (const [name, rule] of Object.entries(mine.skills)) {
    if (user.skillKeys.includes(name)) clash(`skills.${name}`)
    else if (rule.notIn !== undefined) errors.push(`${W}.skills.${name}: notIn has no meaning inside a block; entry dropped`)
    else {
      user.skills[name] = rule
      user.skillKeys.push(name)
      block.ownSkills.push(name)
    }
  }
  for (const [name, need] of Object.entries(mine.needs)) {
    if (user.needKeys.includes(name)) errors.push(`${W}.needs.${name}: already in the standard; rename; entry dropped`)
    else {
      user.needs[name] = need
      user.needKeys.push(name)
    }
  }
  for (const [kind, list] of [['rules', mine.rules], ['notes', mine.notes]] as const) {
    for (const entry of list) {
      if (taken.has(entry.id)) {
        clash(`${kind}.${entry.id}`)
        continue
      }
      if (entry.where !== undefined) {
        errors.push(`${W}.${kind}.${entry.id}: where has no meaning inside a block; entry dropped`)
        continue
      }
      taken.add(entry.id)
      if (kind === 'rules') {
        user.rules.push(entry as Rule)
        block.ownRules.push(entry.id)
      } else {
        user.notes.push(entry as Note)
        block.ownNotes.push(entry.id)
      }
    }
  }
  return block
}

/**
 * Reads the user file and the project file (either may be absent). Each file is
 * validated on its own: an invalid entry drops only that entry. The project file
 * is untrusted: it can only add skills and needs under names the user file does
 * not use, and cannot set `mode` or `trustProjects`. Its skills carry
 * `from: 'project'`.
 */
export function parseConfig(
  userText: string | undefined,
  projectText: string | undefined,
  root?: string,
): { config: Config; errors: string[] } {
  const errors: string[] = []
  const config: Config = { mode: 'observe', skills: {}, needs: {}, trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true, update: 'notify' }

  const read = (source: Origin, text: string | undefined): FileConfig | undefined => {
    if (text === undefined) return undefined
    try {
      return parseFile(text, source, errors)
    } catch (e) {
      if (!(e instanceof SchemaError)) throw e
      errors.push(`${source} config skipped: ${e.message}`)
      return undefined
    }
  }
  const user = read('user', userText)
  const project = read('project', projectText)

  const dropUnknownNeed = (file: FileConfig, source: Origin, needs: Set<string>): void => {
    for (const [name, rule] of Object.entries(file.skills)) {
      if (rule.need !== undefined && !needs.has(rule.need)) {
        errors.push(`${source} config: skill ${show(name)} names unknown need ${show(rule.need)}; entry dropped`)
        delete file.skills[name]
      }
    }
  }

  let block: Block | undefined
  if (user && root !== undefined) block = applyBlock(user, normRoot(root), errors)
  if (user) {
    if (user.mode !== undefined) config.mode = user.mode
    if (user.trustProjects) config.trustProjects = user.trustProjects
    if (user.learn) config.learn = user.learn
    if (user.notices !== undefined) config.notices = user.notices
    if (user.update !== undefined) config.update = user.update
    if (user.updateSigner !== undefined) config.updateSigner = user.updateSigner
    config.rules = user.rules
    config.notes = user.notes
    config.userNeeds = Object.keys(user.needs)
    dropUnknownNeed(user, 'user', new Set(Object.keys(user.needs)))
    Object.assign(config.skills, user.skills)
    Object.assign(config.needs, user.needs)
  }
  if (project && block) {
    // The block wins over the repository file too: a blocked name stays out, and may name a repository skill.
    for (const name of block.blocked) {
      if (Object.hasOwn(project.skills, name)) {
        delete project.skills[name]
        if (!block.blockedSkills.includes(name)) block.blockedSkills.push(name)
      }
    }
    block.blockedSkills = block.blocked.filter((n) => block.blockedSkills.includes(n))
  }
  if (project) {
    const userSkills = new Set(user?.skillKeys)
    const userNeeds = new Set(user?.needKeys)
    for (const name of Object.keys(project.skills)) {
      if (userSkills.has(name)) {
        errors.push(`project config: skill ${show(name)} is already defined in the user config; entry ignored`)
        delete project.skills[name]
      }
    }
    for (const name of Object.keys(project.needs)) {
      if (userNeeds.has(name)) {
        errors.push(`project config: need ${show(name)} is already defined in the user config; entry ignored`)
        delete project.needs[name]
      }
    }
    dropUnknownNeed(project, 'project', new Set([...Object.keys(config.needs), ...Object.keys(project.needs)]))
    Object.assign(config.skills, project.skills)
    Object.assign(config.needs, project.needs)
    const projectNeeds = Object.keys(project.needs)
    if (projectNeeds.length) config.projectNeeds = projectNeeds
  }
  if (block && root !== undefined) {
    config.project = {
      root: normRoot(root),
      blocked: block.blocked,
      blockedSkills: block.blockedSkills,
      own: [...block.ownSkills.filter((n) => Object.hasOwn(config.skills, n)), ...block.ownNotes.filter((id) => config.notes.some((n) => n.id === id)), ...block.ownRules.filter((id) => config.rules.some((r) => r.id === id))],
      ignored: block.ignored,
    }
  }
  let replyOwner: string | undefined
  for (const [name, rule] of Object.entries(config.skills)) {
    if (rule.reply === undefined) continue
    if (replyOwner === undefined) replyOwner = name
    else {
      errors.push(`${rule.from} config: ${name}.reply: only one chat skill can carry reply; ignored`)
      delete rule.reply
    }
  }
  return { config, errors }
}

// --- Glob matching: `*`, `**`, `?` only, no regular expressions. ---

type Token =
  | { t: 'lit'; c: string }
  | { t: 'one' } // any one character
  | { t: 'oneNoSlash' }
  | { t: 'run' } // any characters
  | { t: 'runNoSlash' }
  | { t: 'dirs' } // "**/": nothing, or anything ending in "/"

function compile(glob: string, segments: boolean): Token[] {
  const out: Token[] = []
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      let j = i
      while (glob[j + 1] === '*') j++
      const double = j > i
      if (!segments) out.push({ t: 'run' })
      else if (!double) out.push({ t: 'runNoSlash' })
      else if (glob[j + 1] === '/' && (i === 0 || glob[i - 1] === '/')) {
        out.push({ t: 'dirs' })
        j++
      } else out.push({ t: 'run' })
      i = j
    } else if (c === '?') {
      out.push(segments ? { t: 'oneNoSlash' } : { t: 'one' })
    } else {
      out.push({ t: 'lit', c })
    }
  }
  return out
}

/** Walks the tokens once over the text, keeping the set of reachable positions: O(tokens x length). */
function run(tokens: Token[], s: string): boolean {
  const n = s.length
  let cur = new Array<boolean>(n + 1).fill(false)
  cur[0] = true
  for (const tok of tokens) {
    const next = new Array<boolean>(n + 1).fill(false)
    if (tok.t === 'lit' || tok.t === 'one' || tok.t === 'oneNoSlash') {
      for (let j = 0; j < n; j++) {
        if (!cur[j]) continue
        const ch = s[j]!
        if (tok.t === 'lit' ? ch === tok.c : tok.t === 'one' || ch !== '/') next[j + 1] = true
      }
    } else if (tok.t === 'dirs') {
      let seen = false
      for (let j = 0; j <= n; j++) {
        if (j > 0 && s[j - 1] === '/' && seen) next[j] = true
        if (cur[j]) {
          next[j] = true
          seen = true
        }
      }
    } else {
      for (let j = 0; j <= n; j++) {
        next[j] = cur[j] || (j > 0 && next[j - 1]! && (tok.t === 'run' || s[j - 1] !== '/'))
      }
    }
    cur = next
    if (!cur.includes(true)) return false
  }
  return cur[n]!
}

/** Resolves `.`, `..` and repeated slashes so a path cannot step out of the root by spelling. */
function normalizePath(p: string): string {
  const abs = p.startsWith('/')
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (parts.length > 0 && parts[parts.length - 1] !== '..') parts.pop()
      else if (!abs) parts.push('..')
    } else parts.push(seg)
  }
  return (abs ? '/' : '') + parts.join('/')
}

function globMatchesPath(glob: string, path: string, root: string | undefined): boolean {
  let g = glob
  while (g.startsWith('./')) g = g.slice(2)
  let p = normalizePath(path)
  if (!g.startsWith('/') && !g.startsWith('**/') && root !== undefined) {
    const r = normalizePath(root)
    const prefix = r.endsWith('/') ? r : `${r}/`
    if (!p.startsWith(prefix)) return false
    p = p.slice(prefix.length)
  }
  return run(compile(g, true), p)
}

/** True when `tool` is listed and, if `paths` is set, `path` matches one of its globs (`**`, `*`, `?`). */
export function matches(m: Match, tool: string, path: string | undefined, root?: string): boolean {
  if (!m.tools.includes(tool)) return false
  if (m.paths === undefined) return true
  if (path === undefined) return false
  return m.paths.some((glob) => globMatchesPath(glob, path, root))
}

/** Matches a duty's `evidence.command` glob against a command line. Here `*` and `?` also match `/`. */
export function matchesCommand(glob: string, command: string): boolean {
  return run(compile(glob, false), command)
}
