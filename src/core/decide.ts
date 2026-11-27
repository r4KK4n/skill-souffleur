import { excludedIn, isTrustedRoot, matches, matchesCommand } from './config.ts'
import { compacted, initLedger, markInstalled, requested, skillLoaded, syncLedger } from './ledger.ts'
import type { Ledger } from './ledger.ts'
import { audienceOf, neededSkills, type Deliverable } from './needs.ts'
import type { Proposal } from './proposals.ts'
import { checkReply, replySkill, reminderLine } from './reply.ts'
import { checkRules, contextNotes, ruleKind, ruleSkillNames } from './rules.ts'
import { renderTable } from './status.ts'
import type { UpdateInfo } from './status.ts'
import type { ModelUse } from './cost.ts'
import type { Audience, Config, NeedName, SkillName } from './types.ts'

/** An open duty. `denied` is set once the duty has denied a call, so the retry passes. */
export type Duty = { skill: SkillName; openedAt: number; by: string; denied: boolean; /** Mentioned in a prompt context once per opening. */ told?: boolean }

/** Plain JSON only: the adapter persists it and reads it back. */
export type Session = {
  ledger: Ledger
  /** `dormant`: a readers/users need after a compaction; its skills wait for the next deliverable signal. */
  needs: Record<NeedName, { since: number; reason: string; misses?: number; dormant?: boolean; /** Started or woken by tool evidence: its skills are not asked for again on a prompt that is not its deliverable. */ evidence?: boolean }>
  duties: Duty[]
  paused: boolean
  id: string
  mainSkillCalls: SkillName[]
  subagentsRunning: number
  compactedSincePrompt: boolean
  agentDenied: boolean
  observed: { at: number; reason: string }[]
  errors: string[]
  version?: string
  /** Skills of rules that fired or were loaded: needed for the rest of the session. */
  ruleSkills: SkillName[]
  /** Open `after` rules; `denied` is set once one has denied a call, so the retry passes. */
  openRules: { id: string; by: string; denied: boolean; told: boolean }[]
  /** Field rules that denied and wait for the retry. */
  fieldDenied: string[]
  proposals: Proposal[]
  /** Skill texts read for proposals in this session. */
  skillReads?: number
  /** Skills the main session asked for (a `Skill` call or a typed name) and whose load has not arrived yet. */
  learnCalls?: string[]
  /** Hashes of declined proposals. */
  declined: string[]
  /** Need notes already sent since the last compaction. */
  notesSent: string[]
  /** Confirmed notes without a need, sent once in the next context. */
  freshNotes: string[]
  /** Requests to revise a proposal, sent once in the next context. */
  revise: string[]
  /** Hashes of the proposals the model made through the tool: at most five per session. */
  proposed: string[]
  /** The person declined or skipped a proposal: the model proposes no more in this session (kept over reload and resume). */
  proposalsStopped?: boolean
  /** The person dismissed a dialog: no more questions at turn end in this session (kept over reload and resume; a dialog that could not open is not kept). */
  askStopped?: boolean
  /** Counts the stores, so the newer of two copies can be told. */
  rev?: number
  /** Classifier runs that failed in a row, and learn calls that failed in a row. */
  classifyFails?: number
  /** Call B runs that failed in a row (a prompt where A said code work); prompts where B did not run neither count nor clear. */
  workFails?: number
  learnFails?: number
  /** When this copy was stored last, so old copies in the plugin store can be removed. */
  touched?: number
  /** What notices already told the user: skills cut by compaction, and problem keys shown. */
  noticed?: { cut: SkillName[]; problems: string[]; /** How often each problem key's line was told in this session (at most 2: the second after a back to normal). */ tells?: Record<string, number> }
  /** Failures per step (`error` events by `where`) in this session, kept after the error cleared and over reload and resume. */
  failCounts?: Record<string, number>
  /** The reply check of the chat skill: replies checked, replies over the limit, user prompts since the last reminder, and the reminder waiting for a prompt. */
  replyCheck?: { total: number; over: number; sinceReminder: number; pending?: string }
  /** The small-model calls of this session with their tokens and estimated cost; kept over reload and resume, reset by a new session or /clear. */
  modelUse?: ModelUse
  /** Denials per skill ("skill X not loaded") in the current turn; reset by a person's prompt. After `RELEASE_AFTER` the skill's gate and rules let calls pass. */
  turnDenials?: Record<string, number>
  /** Skills the main loop tried to load by a `Skill` call after their first denial this turn: only these can be released. Reset with `turnDenials`. */
  turnTries?: SkillName[]
  /** When Souffleur last saw the session: a person's prompt or a main-loop turn end. Shown in the status line; kept over reload and resume. */
  lastSeen?: number
  /** The release tag whose notify line this session already showed; kept over reload and resume. */
  updateShown?: string
}

export type CoreEvent =
  | { type: 'start'; now: number; start: 'startup' | 'resume' | 'reload' | 'clear'; version?: string }
  | { type: 'skill'; now: number; skill: string; text?: string; source?: string; pluginName?: string; path?: string }
  | { type: 'compact'; now: number; phase: 'before' | 'after'; trigger: string; skipped?: boolean; agentId?: string }
  /** `classifierFailed`: call A failed (true) or answered (false); absent when the classifier did not run. `workFailed`: call B failed (true) or answered (false) after A said code work; absent when B did not run. `deliverable`: A's answer. */
  | { type: 'prompt'; now: number; text: string; fromUser: boolean; matched: NeedName[]; root?: string; classifierFailed?: boolean; workFailed?: boolean; deliverable?: Deliverable }
  /** `present` names the arguments the call carries, for field rules. */
  | { type: 'tool'; now: number; tool: string; path?: string; command?: string; brief?: string; skill?: string; model?: string; present?: string[]; agentId?: string; root?: string; tree?: string }
  | { type: 'command'; now: number; args: string; root?: string; /** The small-model count over all sessions, from the plugin store. */ total?: ModelUse; /** What the stored release check says. */ update?: UpdateInfo }
  | { type: 'typed'; now: number; name: string }
  | { type: 'agentDone'; now: number }
  /** A main-loop turn ended (any reason): the session is alive. */
  | { type: 'seen'; now: number }
  /** A main-session turn ended with this answer. `fromCommand`: the turn's prompt was a typed command. */
  | { type: 'reply'; now: number; answer: string; fromCommand: boolean; aborted: boolean; root?: string }
  /** A learn call (the small model reading a skill text) ended: `ok` is false when it failed or gave no usable answer. */
  | { type: 'learned'; now: number; ok: boolean }
  /** The config was read again (after `/souffleur init`): the ledger follows it, and `errors` replace the old config errors. */
  | { type: 'config'; now: number; errors: string[] }
  /** The skill names this session lists. An empty list means unknown. */
  | { type: 'installed'; now: number; names: string[] }
  | { type: 'error'; now: number; where: string; message: string }
  /** A hook ran without failing again: its earlier errors (`${where}: …`) are removed, nothing else. `config`, `learn` and `classify` (and `classifier`) never clear this way: they keep their own lifecycle. */
  | { type: 'recovered'; now: number; where: string }

export type Action =
  | { kind: 'context'; text: string }
  /** A line for the debug log only; the user and the model do not see it. */
  | { kind: 'debug'; text: string }
  /** A main-session skill load whose text may be read for proposals; the adapter decides whether to. */
  | { kind: 'learn'; skill: SkillName; text: string; source?: string; pluginName?: string; path?: string }
  | { kind: 'deny'; reason: string }
  | { kind: 'reply'; text: string }
  | { kind: 'toolContext'; text: string }

type Result = { session: Session; actions: Action[] }

const KEEP = 20
const MAX_REQUESTS = 2
const COMPACT_TRIGGERS = ['manual', 'auto', 'plugin']
const BRIEF_SKILLS = /^skills:\s*\S/im
/** The most characters one context block carries: Claude Code moves hook output above 10,000 to a file. */
const CONTEXT_LIMIT = 10_000
/** The part of that block the restore request may take, so notes and reminders still fit. */
const RESTORE_LIMIT = 5000
const FAIL_LIMIT = 3
/** Denials of one skill's "not loaded" check per turn before its calls are released. */
const RELEASE_AFTER = 3
/** Tools that change a file: only these arm a duty by themselves. */
const FILE_TOOLS = ['Write', 'Edit', 'NotebookEdit', 'MultiEdit']
const PAUSE_HINT = 'To turn checks off for this session: /souffleur pause.'

export function initSession(config: Config, id: string, now: number, start: 'startup' | 'clear', version?: string): Session {
  const s: Session = {
    ledger: initLedger(config, now, start, ruleSkillNames(config)),
    needs: {},
    duties: [],
    paused: false,
    id,
    mainSkillCalls: [],
    subagentsRunning: 0,
    compactedSincePrompt: false,
    agentDenied: false,
    observed: [],
    errors: [],
    lastSeen: now,
    ...emptyRules(),
  }
  if (version !== undefined) s.version = version
  return s
}

function emptyRules() {
  return { ruleSkills: [], openRules: [], fieldDenied: [], proposals: [], declined: [], notesSent: [], freshNotes: [], revise: [], proposed: [] }
}

/** A session stored before a field existed gets that field empty. */
export function normalizeSession(s: Session): Session {
  const have = s as unknown as Record<string, unknown>
  const missing = Object.entries(emptyRules()).filter(([key]) => !Array.isArray(have[key]))
  return missing.length ? ({ ...s, ...Object.fromEntries(missing) } as Session) : s
}

export function statusText(config: Config, session: Session, now: number, root?: string, total?: ModelUse, update?: UpdateInfo): string {
  return renderTable(config, session, now, root, total, update)
}

const lastN = <T>(list: T[], item: T): T[] => [...list, item].slice(-KEEP)

/** Counts failures in a row. The third records an error once (the status shows degraded); a success clears both. */
function track(s: Session, key: 'classifyFails' | 'workFails' | 'learnFails', prefix: string, failed: boolean | undefined, message: string): Session {
  if (failed === undefined) return s
  const has = s.errors.some((m) => m.startsWith(prefix))
  if (!failed) return (s[key] ?? 0) === 0 && !has ? s : { ...s, [key]: 0, errors: s.errors.filter((m) => !m.startsWith(prefix)) }
  const n = (s[key] ?? 0) + 1
  if (n < FAIL_LIMIT || has) return { ...s, [key]: n }
  // The third failure in a row records the error and counts once for the session.
  const step = prefix.replace(/: $/, '')
  return { ...s, [key]: n, errors: lastN(s.errors, `${prefix}${message}`), failCounts: { ...s.failCounts, [step]: (s.failCounts?.[step] ?? 0) + 1 } }
}

export function decide(config: Config, s: Session, e: CoreEvent): Result {
  switch (e.type) {
    case 'start':
      // A resume or reload keeps the ledger: what was loaded stays in the transcript until a compaction.
      // A pause is not carried over. A reload (same process, state still held) keeps the per-run counters;
      // a resume (a new process) restarts them.
      if (e.start === 'resume' || e.start === 'reload') {
        const counters = e.start === 'resume'
          ? { subagentsRunning: 0, mainSkillCalls: [], agentDenied: false, learnCalls: [], fieldDenied: [] }
          : {}
        return {
          session: { ...s, paused: false, lastSeen: e.now, ...counters, ...(e.version === undefined ? {} : { version: e.version }) },
          actions: [],
        }
      }
      return { session: initSession(config, s.id, e.now, e.start, e.version), actions: [] }
    case 'skill': {
      const announced = (s.learnCalls ?? []).indexOf(e.skill)
      const main = announced >= 0 || s.subagentsRunning === 0
      const learn = main && config.learn.skills && !s.paused && e.text !== undefined && e.text.trim() !== ''
      const session: Session = { ...onSkill(config, s, e), learnCalls: (s.learnCalls ?? []).filter((_, k) => k !== announced) }
      const from = { ...(e.source === undefined ? {} : { source: e.source }), ...(e.pluginName === undefined ? {} : { pluginName: e.pluginName }), ...(e.path === undefined ? {} : { path: e.path }) }
      return { session, actions: learn ? [{ kind: 'learn', skill: e.skill, text: e.text!, ...from }] : [] }
    }
    case 'compact':
      return { session: onCompact(config, s, e), actions: [] }
    case 'prompt': {
      const r = onPrompt(config, s, e)
      // A person's prompt starts a turn: the denial counters start over, and the session was seen.
      return e.fromUser ? { ...r, session: { ...r.session, turnDenials: {}, turnTries: [], lastSeen: e.now } } : r
    }
    case 'seen':
      return { session: { ...s, lastSeen: e.now }, actions: [] }
    case 'tool':
      return onTool(config, s, e)
    case 'command':
      return onCommand(config, s, e)
    case 'typed':
      return { session: { ...(e.name in s.ledger ? { ...s, mainSkillCalls: [...s.mainSkillCalls, e.name], ruleSkills: withRuleSkill(config, s, e.name) } : s), learnCalls: [...(s.learnCalls ?? []), e.name].slice(-KEEP) }, actions: [] }
    case 'config':
      return { session: { ...s, ledger: syncLedger(s.ledger, config, e.now, ruleSkillNames(config)), ruleSkills: s.ruleSkills.filter((n) => ruleSkillNames(config).includes(n)), openRules: s.openRules.filter((o) => config.rules.some((r) => r.id === o.id)), needs: Object.fromEntries(Object.entries(s.needs).filter(([name]) => name in config.needs)), duties: s.duties.filter((d) => d.skill in config.skills), errors: [...s.errors.filter((m) => !m.startsWith('config: ')), ...e.errors.map((m) => `config: ${m}`)].slice(-KEEP) }, actions: [] }
    case 'installed':
      return { session: { ...s, ledger: markInstalled(s.ledger, e.names, e.now) }, actions: [] }
    case 'reply':
      return { session: onReply(config, s, e), actions: [] }
    case 'agentDone':
      return { session: { ...s, subagentsRunning: Math.max(0, s.subagentsRunning - 1) }, actions: [] }
    case 'learned':
      return { session: track(s, 'learnFails', 'learn: ', !e.ok, 'the small model failed or gave no usable answer 3 times in a row, so skill texts are not read'), actions: [] }
    case 'error':
      return { session: { ...s, errors: lastN(s.errors, `${e.where}: ${e.message}`), failCounts: { ...s.failCounts, [e.where]: (s.failCounts?.[e.where] ?? 0) + 1 } }, actions: [] }
    case 'recovered': {
      const prefix = `${e.where}: `
      if (OWN_LIFECYCLE.includes(e.where)) return { session: s, actions: [] }
      return { session: s.errors.some((m) => m.startsWith(prefix)) ? { ...s, errors: s.errors.filter((m) => !m.startsWith(prefix)) } : s, actions: [] }
    }
  }
}

/** Error prefixes owned by `config` events and `track()`; a hook success must not clear them. */
const OWN_LIFECYCLE = ['config', 'learn', 'classify', 'classifier', 'classifier B']

/** A skill a rule names, once loaded, stays needed for the session. */
function withRuleSkill(config: Config, s: Session, skill: SkillName): SkillName[] {
  return ruleSkillNames(config).includes(skill) && !s.ruleSkills.includes(skill) ? [...s.ruleSkills, skill] : s.ruleSkills
}

function onSkill(config: Config, s: Session, e: Extract<CoreEvent, { type: 'skill' }>): Session {
  const i = s.mainSkillCalls.indexOf(e.skill)
  if (i < 0 && s.subagentsRunning > 0) return s // a subagent's load
  const calls = i < 0 ? s.mainSkillCalls : s.mainSkillCalls.filter((_, k) => k !== i)
  const gone = `gate: ${e.skill} did not load`
  return { ...s, errors: s.errors.filter((m) => !m.startsWith(gone)), mainSkillCalls: calls, ledger: skillLoaded(s.ledger, e.skill, e.now, 'skill.prompt'), ruleSkills: withRuleSkill(config, s, e.skill) }
}

function onCompact(config: Config, s: Session, e: Extract<CoreEvent, { type: 'compact' }>): Session {
  if (e.agentId !== undefined || e.phase !== 'after' || e.skipped || !COMPACT_TRIGGERS.includes(e.trigger)) return s
  // Need notes went out in a context block the compaction cut: send them again while their need stays active.
  const needNotes = new Set(config.notes.filter((n) => n.need !== undefined).map((n) => n.id))
  // Texts for others and screens wait for the next signal; chat and work needs are requested on the next prompt as before.
  const needs = Object.fromEntries(Object.entries(s.needs).map(([name, n]) => [name, isOutward(config, name) && n.reason !== 'command' ? { ...n, dormant: true } : n]))
  return { ...s, needs, ledger: compacted(s.ledger, e.now), compactedSincePrompt: true, notesSent: s.notesSent.filter((id) => !needNotes.has(id)) }
}

/** User prompts between two reminders about long replies. */
const REMINDER_EVERY = 5

/** Counts one checked reply. A violation queues the reminder for the next prompt; a reply within the limits drops a waiting one. Never denies. */
function onReply(config: Config, s: Session, e: Extract<CoreEvent, { type: 'reply' }>): Session {
  if (e.fromCommand || e.aborted || s.paused) return s
  const rule = replySkill(config, e.root)
  if (rule === undefined) return s
  const r = checkReply(e.answer, rule.limits)
  if (r.skip) return s
  const old = s.replyCheck ?? { total: 0, over: 0, sinceReminder: REMINDER_EVERY }
  const { pending: _p, ...rest } = old
  const rc: NonNullable<Session['replyCheck']> = { ...rest, total: old.total + 1 }
  if (r.over) {
    rc.over = old.over + 1
    rc.pending = reminderLine(rule.name, rule.limits, r)
  }
  return { ...s, replyCheck: rc }
}

const DELIVERABLE_OF: Partial<Record<Audience, Deliverable>> = { readers: 'text-for-others', users: 'screen' }
const ownDeliverable = (config: Config, name: NeedName): Deliverable | undefined => {
  const audience = config.needs[name]?.for
  return audience === undefined ? undefined : DELIVERABLE_OF[audience]
}
/** A need whose deliverable is a text for others or a screen. */
const isOutward = (config: Config, name: NeedName): boolean => config.needs[name]?.for === 'readers' || config.needs[name]?.for === 'users'

const ORDER: readonly Audience[] = ['readers', 'users', 'work', 'chat']
const GROUP_SENTENCE: Record<Audience, string> = {
  chat: 'for your replies in this chat.',
  readers: 'for texts other people read (docs, issues, PRs, app copy). Not for your replies in this chat.',
  users: 'for what users of the product see (screens, pages, components). Not for your replies in this chat.',
  work: 'for how you work on this task.',
}

/** The restore request for these skills: one line per audience, then `why`, then the chat trailer. */
function restoreText(config: Config, names: readonly SkillName[], chat: readonly SkillName[], why: string): string {
  const lines = ORDER.flatMap((a) => {
    const group = names.filter((n) => audienceOf(config, n) === a)
    return group.length ? [`- ${group.join(', ')}: ${GROUP_SENTENCE[a]}`] : []
  })
  const outward = names.some((n) => ['readers', 'users'].includes(audienceOf(config, n)))
  const trailer = chat.length && outward ? [`Your replies in this chat follow ${chat.join(', ')}.`] : []
  return ['Souffleur: before anything else, invoke these skills with the Skill tool, one after another:', ...lines, ...(why ? [why] : []), ...trailer].join('\n')
}

/** A fresh signal for these needs: their skills may be asked for twice again, and an unavailable one is absent again. */
function resetSkills(config: Config, ledger: Ledger, needNames: readonly NeedName[]): Ledger {
  if (needNames.length === 0) return ledger
  const next: Ledger = { ...ledger }
  for (const [name, rule] of Object.entries(config.skills)) {
    const e = next[name]
    if (rule.need === undefined || !needNames.includes(rule.need) || e === undefined || e.state === 'loaded' || e.state === 'not installed here') continue
    next[name] = e.state === 'unavailable' ? { ...e, state: 'absent', since: e.since, reason: '', requests: 0 } : { ...e, requests: 0 }
  }
  return next
}

/**
 * Asks for needed skills that are missing. Skills asked for twice without a load are not named again;
 * `requested` moves them to unavailable. Restores run in config order. The request names as many skills as fit
 * into RESTORE_LIMIT characters, grouped by audience; the rest stay as they are (the table of /souffleur lists them) and are asked for
 * on a later prompt. Skills of a project file are asked for only when its root is trusted; skills excluded in this root never.
 */
function restore(config: Config, s: Session, now: number, trusted: boolean, root?: string, scope: { only?: ReadonlySet<SkillName>; skip?: ReadonlySet<SkillName> } = {}): { ledger: Ledger; text?: string; asked: SkillName[] } {
  const missing = neededSkills(config, s.needs, s.ruleSkills, root).filter((name) => {
    if (scope.only && !scope.only.has(name)) return false
    if (scope.skip?.has(name)) return false
    if (!trusted && config.skills[name]?.from === 'project') return false
    const st = s.ledger[name]?.state
    return st === 'absent' || st === 'stale' || st === 'restoring'
  })
  const wanted = missing.filter((name) => s.ledger[name]!.requests < MAX_REQUESTS)
  const giveUp = missing.filter((name) => s.ledger[name]!.requests >= MAX_REQUESTS)
  const why = wanted.some((name) => { const e = s.ledger[name]!; return e.state === 'stale' || ((e.state === 'restoring' || e.state === 'absent') && e.lastCompactAt !== undefined) }) ? 'Compaction cut or dropped their text. The note that skills invoked earlier must not be run again does not apply to them: invoke them again.' : ''
  const chat = Object.entries(config.skills)
    .filter(([name, rule]) => rule.always === true && audienceOf(config, name) === 'chat' && s.ledger[name]?.state !== 'not installed here' && (trusted || rule.from !== 'project') && !excludedIn(rule, root))
    .map(([name]) => name)
  const ask: SkillName[] = []
  for (const name of wanted) {
    if (ask.length > 0 && restoreText(config, [...ask, name], chat, why).length > RESTORE_LIMIT) break
    ask.push(name)
  }
  const ledger = requested(s.ledger, [...ask, ...giveUp], now)
  if (ask.length === 0) return { ledger, asked: [] }
  return { ledger, text: restoreText(config, ask, chat, why), asked: ask }
}

/** User prompts in a row that the classifier ran on without matching a need before the need ends. */
const NEED_MISSES = 20
/** A prompt of this many words or fewer is not counted for need expiry. */
const SHORT_PROMPT_WORDS = 3

function onPrompt(config: Config, s: Session, e: Extract<CoreEvent, { type: 'prompt' }>): Result {
  if (!e.fromUser) return { session: s, actions: [] }
  const trusted = isTrustedRoot(config, e.root)
  const needs = { ...s.needs }
  const debug: Action[] = []
  let ended = false
  let ledger = s.ledger
  if (!s.paused) {
    for (const name of e.matched) {
      if (name in needs) {
        const { dormant: _d, evidence: _e, ...rest } = needs[name]!
        needs[name] = { ...rest, ...(rest.misses ? { misses: 0 } : {}) }
        continue
      }
      const reason = `need:${name} from "${e.text.slice(0, 40)}"`
      needs[name] = { since: e.now, reason }
      debug.push({ kind: 'debug', text: `need started: ${reason}` })
    }
    // A's deliverable is a fresh signal for the readers/users needs it belongs to: it wakes them, ends their evidence-only mode and gives their skills two requests again.
    const fresh = e.deliverable === undefined ? [] : Object.keys(needs).filter((name) => ownDeliverable(config, name) === e.deliverable && (trusted || !(config.projectNeeds ?? []).includes(name)))
    for (const name of fresh) {
      const { dormant: _d, evidence: _e, ...rest } = needs[name]!
      needs[name] = rest
    }
    ledger = resetSkills(config, ledger, fresh)
    // Only a prompt the classifier ran on without failing counts as a miss; a need set with the command never ends by itself.
    // A reply of a word or two ("ja") says nothing about the topic: it does not count as a miss. A match on it still resets the count (see the matched branch above).
    if (e.classifierFailed === false && e.text.trim().split(/\s+/).length > SHORT_PROMPT_WORDS) {
      for (const [name, n] of Object.entries(needs)) {
        // A readers/users need is hit by its own deliverable only; A answering anything else is a miss.
        if (e.matched.includes(name) || n.reason === 'command' || (e.deliverable !== undefined && ownDeliverable(config, name) === e.deliverable)) continue
        if (e.workFailed && config.needs[name]?.for === 'work') continue
        const misses = (n.misses ?? 0) + 1
        if (misses >= NEED_MISSES) {
          delete needs[name]
          ended = true
          debug.push({ kind: 'debug', text: `need ended: ${name} (${NEED_MISSES} prompts without a match)` })
        } else needs[name] = { ...n, misses }
      }
    }
  }
  if (ended) {
    // Skills that were only being restored for the ended need are not stuck in the status.
    const still = neededSkills(config, needs, s.ruleSkills, e.root)
    ledger = Object.fromEntries(Object.entries(ledger).map(([name, row]) => [name, row.state === 'restoring' && !still.includes(name) ? { ...row, state: 'absent' as const, requests: 0, reason: '' } : row]))
  }
  const tracked = track({ ...s, ledger, needs, compactedSincePrompt: false }, 'classifyFails', 'classifier: ', e.classifierFailed, 'the small model failed or timed out 3 prompts in a row, so needs are not detected')
  const next: Session = track(tracked, 'workFails', 'classifier B: ', e.workFailed, 'the small model failed to pick a work need 3 prompts in a row, so work needs are not detected')
  // Needs that evidence started stay quiet on a prompt that is not their deliverable (a chat reply, a failed classification).
  const quiet = new Set(Object.entries(config.skills).filter(([, rule]) => rule.need !== undefined && needs[rule.need]?.evidence === true).map(([name]) => name))
  const r = s.paused ? undefined : restore(config, next, e.now, trusted, e.root, { skip: quiet })
  if (r) next.ledger = r.ledger
  // One block, at most CONTEXT_LIMIT characters. What does not fit waits: it stays in the session and /souffleur lists it.
  const lines: string[] = []
  let used = 0
  const add = (text: string): boolean => {
    const cost = text.length + (lines.length ? 1 : 0)
    if (used + cost > CONTEXT_LIMIT) return false
    lines.push(text)
    used += cost
    return true
  }
  if (r?.text !== undefined) add(r.text)
  // A failed call A hides every need; a failed call B hides only the work needs, and only a prompt A called code work needs them.
  const aDown = (next.classifyFails ?? 0) >= FAIL_LIMIT
  const bDown = !aDown && (next.workFails ?? 0) >= FAIL_LIMIT && e.deliverable === 'code-or-repo-work'
  if ((aDown || bDown) && !s.paused) {
    const listed = Object.entries(config.needs)
      .filter(([name, n]) => n.for === 'work' && !(name in next.needs) && (trusted || !(config.projectNeeds ?? []).includes(name)))
      .map(([name, n]) => {
        const skills = Object.entries(config.skills)
          .filter(([skill, rule]) => rule.need === name && next.ledger[skill]?.state !== 'not installed here' && next.ledger[skill]?.state !== 'loaded' && !excludedIn(rule, e.root) && (trusted || rule.from !== 'project'))
          .map(([skill]) => skill)
        return skills.length ? `${name} (${n.what}): ${skills.join(', ')}` : ''
      })
      .filter(Boolean)
    if (listed.length) add(`Souffleur cannot ${aDown ? 'classify prompts' : 'pick a work need'} right now. If this prompt starts one of these, invoke its skills first: ${listed.join('; ')}`)
  }
  const notes = contextNotes(config, next, e.root).kept
  if (notes.length && add(`Souffleur notes from the user's config:\n${notes.map((n) => `- ${n.text}`).join('\n')}`)) {
    const ids = notes.map((n) => n.id)
    next.notesSent = [...next.notesSent, ...ids.filter((id) => !next.notesSent.includes(id))]
    next.freshNotes = next.freshNotes.filter((id) => !ids.includes(id) && config.notes.some((n) => n.id === id))
  }
  if (next.replyCheck !== undefined) {
    const rc = { ...next.replyCheck, sinceReminder: next.replyCheck.sinceReminder + 1 }
    next.replyCheck = rc
    if (rc.pending !== undefined && rc.sinceReminder >= REMINDER_EVERY && !s.paused && replySkill(config, e.root) !== undefined && add(rc.pending)) {
      const { pending: _p, ...rest } = rc
      next.replyCheck = { ...rest, sinceReminder: 0 }
    }
  }
  next.revise = next.revise.filter((text) => !add(text))
  next.duties = next.duties.map((d) => {
    if (d.told || next.ledger[d.skill]?.state === 'not installed here' || (!trusted && config.skills[d.skill]?.from === 'project')) return d
    return add(`Open duty: ${d.skill} (${d.by}).`) ? { ...d, told: true } : d
  })
  next.openRules = next.openRules.map((o) => (!o.told && add(`Open rule: ${o.id} (${o.by}).`) ? { ...o, told: true } : o))
  return { session: next, actions: [...(lines.length ? [{ kind: 'context' as const, text: lines.join('\n') }] : []), ...debug] }
}

/** Bash commands that end in a text other people read, as a whole-word prefix of a command part. */
const TEXT_COMMANDS = ['gh issue create', 'gh issue comment', 'gh pr create', 'gh pr edit']
const RUNNERS = /^(?:(?:env|sudo|time|command)\s+|[A-Za-z_]\w*=\S*\s+)+/

/** The first of the chained parts of a command that is a text command, with assignments and `env`/`sudo`/`time`/`command` removed; quotes are not parsed, so a quoted `&& gh pr create` counts too. */
function textCommand(command: string | undefined): string | undefined {
  for (const part of (command ?? '').split(/&&|\|\||[;|\n]/)) {
    const bare = part.trim().replace(RUNNERS, '')
    if (TEXT_COMMANDS.some((c) => bare === c || bare.startsWith(`${c} `))) return bare
  }
  return undefined
}

/**
 * A call that shows what the agent delivers starts or wakes the `readers`/`users` needs it belongs to, without a model call:
 * a tool call matching a gate of one of the need's skills, and for `readers` a text command. Skills excluded in this root and
 * skills of an untrusted project do not count, and a need only the project file defines starts only in a trusted root.
 * Returns the needs that started or woke, so the caller asks for their skills.
 */
function startFromEvidence(config: Config, next: Session, e: Extract<CoreEvent, { type: 'tool' }>, trustedRoot: boolean): NeedName[] {
  const usable = (skill: string): boolean => {
    const rule = config.skills[skill]
    return rule !== undefined && next.ledger[skill]?.state !== 'not installed here' && !excludedIn(rule, e.root) && (trustedRoot || rule.from !== 'project')
  }
  const head = textCommand(e.command)
  const started: NeedName[] = []
  for (const [name, need] of Object.entries(config.needs)) {
    if (need.for !== 'readers' && need.for !== 'users') continue
    if (!trustedRoot && (config.projectNeeds ?? []).includes(name)) continue
    const own = Object.entries(config.skills).filter(([skill, rule]) => rule.need === name && usable(skill))
    const byGate = own.some(([, rule]) => rule.gate !== undefined && !(e.tool === 'Skill') && matches(rule.gate, e.tool, e.path, e.tree ?? e.root))
    const byCommand = need.for === 'readers' && e.tool === 'Bash' && head !== undefined && own.length > 0
    if (!byGate && !byCommand) continue
    const had = next.needs[name]
    if (had !== undefined) {
      const { dormant, ...rest } = had
      next.needs[name] = { ...rest, ...(dormant === true ? { evidence: true } : {}), ...(rest.misses ? { misses: 0 } : {}) }
      if (dormant === true) started.push(name)
    } else {
      const what = e.path ?? (head ?? e.command ?? '').split(/\s+/).slice(0, 3).join(' ').slice(0, 40)
      next.needs[name] = { since: e.now, reason: `tool: ${e.tool} ${what}`.trimEnd(), evidence: true }
      started.push(name)
    }
  }
  return started
}

function evidenceMatches(ev: { tool: string; command?: string }, e: Extract<CoreEvent, { type: 'tool' }>): boolean {
  if (ev.tool !== e.tool) return false
  return ev.command === undefined || matchesCommand(ev.command, e.command ?? '')
}

function onTool(config: Config, s: Session, e: Extract<CoreEvent, { type: 'tool' }>): Result {
  if (e.agentId !== undefined) return { session: s, actions: [] }
  const next: Session = { ...s, needs: { ...s.needs }, lastSeen: e.now }
  const actions: Action[] = []
  // A load attempt after the first denial of that skill lets its denials count toward the release.
  if (e.tool === 'Skill' && e.skill !== undefined && (s.turnDenials?.[e.skill] ?? 0) >= 1 && !(s.turnTries ?? []).includes(e.skill)) next.turnTries = [...(s.turnTries ?? []), e.skill]

  if (e.tool === 'Skill' && e.skill !== undefined && e.skill in s.ledger) next.mainSkillCalls = [...s.mainSkillCalls, e.skill]
  // The learn decision keeps its own list: it also covers skills the config does not list.
  if (e.tool === 'Skill' && e.skill !== undefined) next.learnCalls = [...(s.learnCalls ?? []), e.skill].slice(-KEEP)

  const trustedRoot = isTrustedRoot(config, e.root)
  const started = next.paused ? [] : startFromEvidence(config, next, e, trustedRoot)
  // A call that starts or wakes a need asks for that need's skills only: in enforce the call is denied once (the retry finds the need active), in observe the request follows it.
  const evidenceAsked = new Set<SkillName>()
  const evidenceText: string[] = []
  if (started.length) {
    const own = new Set(Object.entries(config.skills).filter(([, rule]) => rule.need !== undefined && started.includes(rule.need)).map(([name]) => name))
    next.ledger = resetSkills(config, next.ledger, started)
    const r = restore(config, next, e.now, trustedRoot, e.root, { only: own })
    next.ledger = r.ledger
    r.asked.forEach((n) => evidenceAsked.add(n))
    if (r.text !== undefined) {
      // Observe records the first evidence call as one enforce would have denied, and the request follows the call.
      evidenceText.push(r.text)
      if (config.mode !== 'enforce') actions.push({ kind: 'toolContext', text: r.text })
    }
  }
  if (s.compactedSincePrompt && !s.paused) {
    next.compactedSincePrompt = false
    const r = restore(config, next, e.now, trustedRoot, e.root, { skip: evidenceAsked })
    next.ledger = r.ledger
    if (r.text !== undefined) actions.push({ kind: 'toolContext', text: r.text })
  }

  next.duties = s.duties.filter((d) => {
    const ev = config.skills[d.skill]?.duty?.evidence
    return !(ev && evidenceMatches(ev, e))
  })

  // Violations: `trusted` ones may deny in enforce mode; the rest (untrusted project skills) only record.
  const found: { text: string; trusted: boolean; skill?: SkillName }[] = []
  const recordOnly: string[] = []

  if (!next.paused) {
    if (e.tool === 'Agent') {
      // A need only the project file defines counts for a trusted root alone, like its skills.
      const active = Object.keys(next.needs).filter((n) => !next.needs[n]!.dormant).filter((n) => trustedRoot || !(config.projectNeeds ?? []).includes(n))
      if (active.length === 0 || BRIEF_SKILLS.test(e.brief ?? '')) next.agentDenied = false
      else if (next.agentDenied) next.agentDenied = false
      else {
        next.agentDenied = true
        found.push({
          text: `Souffleur: add a line "skills: <names>" (or "skills: none" for mechanical work) to the brief, then retry. Configured skills: ${Object.keys(config.skills).filter((n) => next.ledger[n]?.state !== 'not installed here' && !excludedIn(config.skills[n]!, e.root) && (trustedRoot || config.skills[n]!.from !== 'project')).join(', ') || 'none'}. Active needs: ${active.join(', ')}. ${PAUSE_HINT}`,
          trusted: true,
        })
      }
    }

    for (const text of evidenceText) found.push({ text: `${text} ${PAUSE_HINT}`, trusted: true })
    const needed = neededSkills(config, next.needs, next.ruleSkills, e.root)
    for (const [name, rule] of Object.entries(config.skills)) {
      if (!rule.gate || next.ledger[name]?.state === 'not installed here' || excludedIn(rule, e.root) || evidenceAsked.has(name) || (e.tool === 'Skill' && e.skill === name) || !matches(rule.gate, e.tool, e.path, e.tree ?? e.root)) continue
      const trusted = rule.from === 'user' || trustedRoot
      const state = next.ledger[name]?.state
      if (needed.includes(name) && state !== undefined && state !== 'loaded' && state !== 'unavailable') {
        found.push({ text: `Souffleur: load ${name} with the Skill tool first, then retry. ${name} is ${GROUP_SENTENCE[audienceOf(config, name)]} ${PAUSE_HINT}`, trusted, skill: name })
      } else if (needed.includes(name) && state === 'unavailable') {
        recordOnly.push(`Souffleur: ${name} is not loaded (skill unavailable)`)
      }
      const duty = next.duties.find((d) => d.skill === name)
      if (duty && !duty.denied && rule.duty) {
        const ev = rule.duty.evidence
        const what = ev.command === undefined ? ev.tool : `${ev.tool} matching ${ev.command}`
        found.push({ text: `Souffleur: open duty for ${name} (${duty.by}). Do this first: ${what}. Then retry. ${PAUSE_HINT}`, trusted })
        next.duties = next.duties.map((d) => (d === duty ? { ...d, denied: true } : d))
      }
    }
  }

  // Rules: evidence closes and a first match opens even while paused; only the denials and the needed skills stop.
  const checked = checkRules(config, next, e)
  const rr = next.paused ? { ...checked, reasons: [], denied: [], fired: [] } : checked
  rr.reasons.forEach((reason, i) => found.push({ text: `${reason} ${PAUSE_HINT}`, trusted: true, ...(rr.reasonSkills[i] === undefined ? {} : { skill: rr.reasonSkills[i]! }) }))
  if (!next.paused) recordOnly.push(...rr.unavailable)
  for (const text of recordOnly) next.observed = lastN(next.observed, { at: e.now, reason: text })
  // Enforce only: a skill that did not load after RELEASE_AFTER denials this turn no longer denies; the call passes and is recorded.
  if (config.mode === 'enforce') {
    const counts = s.turnDenials ?? {}
    const released = new Set<SkillName>()
    for (let i = found.length - 1; i >= 0; i--) {
      const f = found[i]!
      if (f.trusted && f.skill !== undefined && (counts[f.skill] ?? 0) >= RELEASE_AFTER && (next.turnTries ?? []).includes(f.skill)) {
        released.add(f.skill)
        found.splice(i, 1)
      }
    }
    for (const skill of released) {
      next.observed = lastN(next.observed, { at: e.now, reason: `released after ${RELEASE_AFTER} denials: ${skill} did not load` })
      const error = `gate: ${skill} did not load after ${RELEASE_AFTER} denials in a turn; calls released`
      if (!next.errors.includes(error)) next.errors = lastN(next.errors, error)
    }
  }
  if (rr.fired.length) next.ruleSkills = [...next.ruleSkills, ...rr.fired.filter((n) => !next.ruleSkills.includes(n))]

  let denied = false
  const trustedText = found.filter((f) => f.trusted).map((f) => f.text).join('\n')
  const untrustedText = found.filter((f) => !f.trusted).map((f) => f.text).join('\n')
  if (trustedText) {
    if (config.mode === 'enforce') {
      denied = true
      actions.push({ kind: 'deny', reason: trustedText })
      const counts = { ...(s.turnDenials ?? {}) }
      for (const skill of new Set(found.filter((f) => f.trusted && f.skill !== undefined).map((f) => f.skill!))) counts[skill] = (counts[skill] ?? 0) + 1
      next.turnDenials = counts
    } else next.observed = lastN(next.observed, { at: e.now, reason: trustedText })
  }
  if (untrustedText) next.observed = lastN(next.observed, { at: e.now, reason: untrustedText })

  // Retry state moves only with the outcome of the whole call: a denial marks the rules that spoke, a pass uses up their retry
  // and lets evidence close a rule. In observe nothing is denied, so every break is recorded and no retry state is kept.
  if (denied) {
    next.openRules = next.openRules.map((o) => (rr.denied.includes(o.id) ? { ...o, denied: true } : o))
    next.fieldDenied = [...next.fieldDenied, ...rr.denied.filter((id) => !next.fieldDenied.includes(id) && config.rules.some((r) => r.id === id && ruleKind(r) === 'field'))]
  } else {
    next.openRules = next.openRules.filter((o) => !rr.closed.includes(o.id))
    next.fieldDenied = next.fieldDenied.filter((id) => !rr.released.includes(id))
  }

  if (!denied) {
    if (e.tool === 'Agent') next.subagentsRunning += 1
    const by = e.path === undefined ? e.tool : `${e.tool} ${e.path}`
    next.openRules = [...next.openRules, ...rr.opened.map((id) => ({ id, by, denied: false, told: false }))]
    for (const [name, rule] of Object.entries(config.skills)) {
      if (!rule.duty || next.ledger[name]?.state === 'not installed here' || excludedIn(rule, e.root) || !matches(rule.duty.after, e.tool, e.path, e.tree ?? e.root)) continue
      if (!FILE_TOOLS.includes(e.tool)) continue
      if (next.duties.some((d) => d.skill === name)) continue
      next.duties = [...next.duties, { skill: name, openedAt: e.now, by: e.path === undefined ? e.tool : `${e.tool} ${e.path}`, denied: false, told: false }]
    }
  }
  return { session: next, actions }
}

function onCommand(config: Config, s: Session, e: Extract<CoreEvent, { type: 'command' }>): Result {
  const [verb = '', arg = ''] = e.args.trim().split(/\s+/)
  const reply = (session: Session, text: string): Result => ({ session, actions: [{ kind: 'reply', text }] })
  const known = () => `Known needs: ${Object.keys(config.needs).join(', ') || 'none'}.`
  switch (verb) {
    case '':
    case 'status':
      return reply(s, statusText(config, s, e.now, e.root, e.total, e.update))
    case 'pause':
      return reply({ ...s, paused: true }, 'Souffleur: paused for this session: no restore requests, no need detection, no turn-end questions, no gate, duty or brief denial. /souffleur resume turns them on again.')
    case 'resume':
      return s.paused ? reply({ ...s, paused: false }, 'Souffleur: checks are on again.') : reply(s, 'Souffleur: not paused.')
    case 'need':
      if (!(arg in config.needs)) return reply(s, `Unknown need "${arg}". ${known()}`)
      return reply({ ...s, needs: { ...s.needs, [arg]: { since: e.now, reason: 'command' } } }, `Need ${arg} is on.`)
    case 'drop': {
      if (!(arg in config.needs)) return reply(s, `Unknown need "${arg}". ${known()}`)
      const { [arg]: _gone, ...rest } = s.needs
      return reply({ ...s, needs: rest }, `Need ${arg} is off.`)
    }
    default:
      return reply(s, 'Usage: /souffleur [status | need <name> | drop <name> | pause | resume | init | migrate | rule <text> | review | accept <id> | decline <id> | block <name> | unblock <name> | project | update]')
  }
}
