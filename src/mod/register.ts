import { atom, read, update as updateAtom } from 'claude-code'
import type { EngineInterface, ModelCompleteRequest, ModelCompleteResult, Register, RenderElement } from 'claude-code'
import { MAX_LIST, MAX_PROJECT_ROOTS, excludedIn, isTrustedRoot, normRoot, parseConfig } from '../core/config.ts'
import { decide, initSession, normalizeSession, SPAWN_PREFIX } from '../core/decide.ts'
import { MIGRATE_INTRO, describeHook, findHookOverlaps, findPassages, hookQuestion, hookSteps, isGuess, migrateSteps, passageLines, removeHook } from '../core/migrate.ts'
import type { HookOverlap, Passage } from '../core/migrate.ts'
import { CHOICE_LABEL, INJECTED_HELP, addSkillToProject, hasProjectKey, ignoreInProject, NOT_SET_UP, SETUP_INTRO, applyChoice, candidates, choiceOf, cleanNeedText, configProblem, currentChoice, describePlan, explicitOnly, GROUP_ALL, GROUP_NONE, GROUP_ONE, groupByPlugin, injectedWarning, LATER, needKeyFor, options, parsePicks, parseSkips, picksPrompt, setupSteps } from '../core/setup.ts'
import type { LoadChoice, NeedText, Plan, StartHooks, Suggestion } from '../core/setup.ts'
import type { Action, CoreEvent, Session } from '../core/decide.ts'
import { allowedSigners, goodSignature, signedTagObject, verifyTagArgs } from '../core/update.ts'
import { audienceOf, classifyDeliverable, needTexts } from '../core/needs.ts'
import { EXTRACT_SYSTEM, MAX_SKILL_TEXT, extractPrompt, hashKey, parseAnswer, shouldRead, skillHash, trusted } from '../core/learn.ts'
import type { Proposal } from '../core/proposals.ts'
import { NO, YES_EVERYWHERE, YES_PROJECT, addEntry, answer, describeProposal, enqueue, findProposal, makeProposal, nextQuestion, parseReply, parseShaped, proposalLines, proposalNotice, shapePrompt } from '../core/proposals.ts'
import { ruleSkillNames, sectionNotes } from '../core/rules.ts'
import { needsAttention, statusLine } from '../core/status.ts'
import { addUsage } from '../core/cost.ts'
import type { ModelUse, UsageFields } from '../core/cost.ts'
import type { Config, Note, Rule } from '../core/types.ts'
import { notices, startNotice } from '../core/notices.ts'
import { PLUGIN_VERSION } from './version.ts'
import { isCheckDue, isUpdateCheck, newestRelease, refusalLine, shown, updateLine } from '../core/update.ts'
import type { UpdateInfo } from '../core/status.ts'
import { compareVersions } from '../core/version.ts'
import { isFromUser, isUserOrigin, startsTurn, presentArgs, toolFields } from './map.ts'

// The hooks' `$` is the engine interface; the adapter calls only documented members. The type resolves only under tsconfig.mod.json (npm run typecheck:mod).
type Dollar = EngineInterface
/** `root` is the main repository root (what `where` names), `tree` the session's own working tree (what globs are relative to). */
type Loaded = { config: Config; errors: string[]; root: string; tree: string; cwd: string; setUp: boolean; legacy?: string }

const REF = { plugin: 'skill-souffleur', key: 'session' } as const
/** What the band above the prompt shows: the status text, or null while nothing needs attention. */
const band = atom({ plugin: 'skill-souffleur', key: 'band' } as const, null as { text: string } | null)
const RULE =
  'Souffleur keeps track of skills in this session. If a message from Souffleur asks you to load skills, invoke each one with the Skill tool before you continue.'
const PROPOSE_SENTENCE =
  ' Call the souffleur_propose tool only (a) when the user gives a standing instruction meant to hold beyond the current task, as a note, or (b) when something went wrong that a checkable rule would have caught (a skill loaded before a call, a field a call carries, evidence after a call), as a rule. Never for facts about one task, issue or file. Souffleur then asks the user; do not write the entry anywhere yourself.'
const PROPOSE_TOOL = 'mcp__skill-souffleur__souffleur_propose'
const DECLINED_KEY = 'souffleur:declined'

// Module variables start over on a reload; the config is read again by `session.start`, which a reload runs.
let loaded: Loaded | undefined
/** The stat fingerprint of the user and repository files when `loaded` was read; a prompt drops the cache when it changed. */
let loadedSig: string | undefined
/** The session this process stored last, with its revision. */
let latest: Session | undefined
/** Set by `session.start`: a person is at the prompt, and the propose tool is registered. */
let interactive = false
let proposeReady = false
/** The origin kind of the last prompt of the person; under `claude -p` that is `sdk`, and no later prompt can carry a reply. */
let lastPromptKind: string | undefined
/** The last prompt of the person was a typed command: its reply is not checked against the chat skill's limits. */
let lastPromptCommand = false
/** The turn now running was started by a prompt of the person (typed or a command); background and agent notification turns are not counted. */
let personTurn = false
/**
 * Everything that belongs to one session and must not reach the next: `resetSessionState` starts it over at `session.start`
 * and at an id change inside the process (`/clear`, an in-process `/resume`). A new flag of this kind goes here, nowhere else.
 */
export const newSessionState = () => ({
  /** A dialog was dismissed or could not open: no more questions at turn end; only a dismissal is stored in the session. */
  askStopped: false,
  /** The hash of the proposal a notice showed because no dialog opens; only the person's very next prompt can answer it, by one reply word. */
  shownHash: undefined as string | undefined,
  /** A typed `/souffleur review` could not open its dialog: the next turn end asks even after a dismissal. */
  askAtTurnEnd: false,
  /** `$.ui.ask` rejected in this session: nobody can answer a dialog, so waiting proposals are shown as notices. */
  noDialog: false,
  /** The proposals a notice showed (kept after the offer ended), so each proposal gets one notice. */
  noticed: new Set<string>(),
  /** Proposals whose dialog timed out (turn end or typed command) and may still be answered. */
  timedOutAsk: new Set<string>(),
  /** Skill versions whose read is under way. */
  reading: new Set<string>(),
  /** Set once the question about the project's own skills was handled in this session. */
  ownHandled: false,
  /** Counts the project questions; a late answer belongs to the question it was asked for. A reset moves it on, so no answer of an earlier session matches. */
  ownToken: 0,
  /** Set once the current question was acted on, so a second answer cannot act again. */
  ownActed: false,
  /** A late `Set up now`: the round runs at the next turn end, where a dialog may open. */
  pendingSetUp: undefined as { token: number; names: string[] } | undefined,
})
export const sess = newSessionState()
/** The session id the state above belongs to, so one id change resets it once however many hooks notice the change. */
let sessFor: string | undefined
export function resetSessionState(id?: string): void {
  Object.assign(sess, newSessionState(), { ownToken: sess.ownToken + 1 })
  sessFor = id
}

/** How long a dialog may stay open before it counts as a rejection (turn end) or the typed command returns without it. */
const ASK_WAIT_MS = 120_000

/** The time of the host's clock as of the last `syncClock`; a test's fake clock moves it, nothing else reads the system time. */
let clockMs = Date.now()
const now = (): number => clockMs
/** The clock call failed or was silent once already in this process; the debug line is written once. */
let clockFallbackLogged = false
/**
 * `$.clock.now()` is asynchronous, so the synchronous `now()` reads this copy. It is refreshed at every event handler and at every core
 * event (`apply`); a time that another process wrote is compared only after `wallNow`. When the host clock throws or does not answer
 * within 50 ms the system time is used, and the first time says so in the debug log.
 */
async function syncClock($: Dollar): Promise<void> {
  const quiet = new AbortController()
  try {
    const t = await Promise.race([$.clock.now(), $.clock.sleep(50, { signal: quiet.signal }).then(() => undefined, () => undefined)])
    if (typeof t === 'number' && Number.isFinite(t)) {
      clockMs = t
      return
    }
  } catch {
    // falls through to the system time
  } finally {
    quiet.abort()
  }
  clockMs = Date.now()
  if (!clockFallbackLogged) {
    clockFallbackLogged = true
    try {
      $.ui.log('clock unavailable: using the system time', { to: 'debug' })
    } catch {
      // a log line is a courtesy
    }
  }
}
/** A fresh time for comparing with a stamp written by another process (a lock, a folder time, a stored check time). */
async function wallNow($: Dollar): Promise<number> {
  await syncClock($)
  return clockMs
}
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const stripBom = (text: string) => text.replace(/^\uFEFF/, '')
const parseJson = (text: string): unknown => JSON.parse(stripBom(text))
const dropSlash = (p: string) => p.replace(/[\\/]+$/, '') || p
/** The home folder as written with `\` (Windows) and with `/`, without a trailing separator. */
const homeForms = (home: string): string[] => [...new Set([dropSlash(home), dropSlash(home).replace(/\\/g, '/')])]
const shownPath = (home: string | undefined, path: string) => {
  for (const h of home ? homeForms(home) : []) {
    if (path.startsWith(`${h}/`) || path.startsWith(`${h}\\`)) return `~${path.slice(h.length)}`
  }
  return path
}
/** An error text with the home folder written as `~`. */
const scrub = (home: string | undefined, text: string) => (home ? homeForms(home).reduce((t, h) => t.split(h).join('~'), text) : text)

/** The home folder: `HOME`, or `USERPROFILE` where there is no `HOME` (Windows). */
async function homeOf($: Dollar): Promise<string | undefined> {
  return (await $.env.get('HOME').catch(() => undefined)) || (await $.env.get('USERPROFILE').catch(() => undefined)) || undefined
}

/**
 * The user's Claude folder. The mod API has no accessor for it (checked against the 2.1.332 typings), so this is
 * `CLAUDE_CONFIG_DIR` when set, else `<home>/.claude`. Every path under the user's folder is built from this.
 */
async function userDir($: Dollar): Promise<string | undefined> {
  const cfg = await configDirEnv($)
  if (cfg) return cfg
  const home = await homeOf($)
  return home ? `${dropSlash(home)}/.claude` : undefined
}

/** `CLAUDE_CONFIG_DIR` when it is an absolute folder (`/x`, `X:\`, `X:/` or UNC `\\`) other than the root; otherwise undefined: a relative, blank or root value is ignored. */
async function configDirEnv($: Dollar): Promise<string | undefined> {
  const raw: string | undefined = await $.env.get('CLAUDE_CONFIG_DIR').catch(() => undefined)
  const cfg = raw?.trim()
  if (!cfg || !/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(cfg)) return undefined
  // `/.` or `/x/..` is the root too: collapse a `/` path before the root check.
  const dir = cfg.startsWith('/') ? collapsePath(cfg) : dropSlash(cfg)
  return /^([A-Za-z]:)?[\\/]*$/.test(dir) ? undefined : dir
}

/** The user file as shown to the person (`~` for the home folder), for texts that name it. */
async function shownUserFile($: Dollar): Promise<string> {
  const uc = await userConfig($)
  return uc ? shownPath(await homeOf($), uc.path) : '~/.claude/souffleur.json'
}

const dirOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')))
const fileExists = async ($: Dollar, path: string): Promise<boolean> => {
  try {
    return Boolean(await $.fs.exists(path))
  } catch (err) {
    // Only a plain "not found" says it is not there; any other failure keeps the configured path.
    return !/ENOENT|not found/i.test(message(err))
  }
}

/**
 * The user file: `<userDir>/souffleur.json`. When `CLAUDE_CONFIG_DIR` is set, that file is missing and `~/.claude/souffleur.json`
 * exists, the legacy file is used (`legacy` names the config folder it should move to). Souffleur never moves or copies it.
 */
async function userConfig($: Dollar): Promise<{ path: string; dir: string; legacy?: string } | undefined> {
  const dir = await userDir($)
  if (!dir) return undefined
  const path = `${dir}/souffleur.json`
  const cfg = await configDirEnv($)
  const home = await homeOf($)
  if (cfg && home) {
    const old = `${dropSlash(home)}/.claude/souffleur.json`
    if (old !== path && !(await fileExists($, path)) && (await fileExists($, old))) return { path: old, dir, legacy: dir }
  }
  return { path, dir }
}

async function readOptional($: Dollar, path: string, errors: string[], home?: string): Promise<string | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    return await $.fs.read(path)
  } catch (err) {
    errors.push(`cannot read ${shownPath(home, path)}: ${scrub(home, message(err))}`)
    return undefined
  }
}

/** A file as a command that writes it must see it: missing is not the same as unreadable. */
type FileState = { kind: 'missing' } | { kind: 'ok'; text: string } | { kind: 'error'; why: string }
async function readState($: Dollar, path: string, home: string): Promise<FileState> {
  try {
    if (!(await $.fs.exists(path))) return { kind: 'missing' }
    return { kind: 'ok', text: await $.fs.read(path) }
  } catch (err) {
    return { kind: 'error', why: scrub(home, message(err)) }
  }
}

async function getLoaded($: Dollar): Promise<Loaded> {
  if (loaded) return loaded
  const errors: string[] = []
  const home = await homeOf($)
  const uc = await userConfig($)
  const root = (await $.session.repo())?.root ?? (await $.session.cwd())
  const cwd: string = await $.session.cwd()
  const sig = await configSig($, root) // before the reads: a save in between only costs one extra reload
  const userText = uc ? await readOptional($, uc.path, errors, home) : undefined
  const projectText = await readOptional($, `${root}/.claude/souffleur.json`, errors, home)
  const parsed = parseConfig(userText === undefined ? undefined : stripBom(userText), projectText === undefined ? undefined : stripBom(projectText), root)
  let tree = cwd
  try {
    const copy = await $.vcs.detect({ path: cwd })
    if (copy && typeof copy.root === 'string') tree = copy.root
  } catch {
    // outside a repository, or no detection: the working directory is the tree
  }
  loaded = { config: parsed.config, errors: [...errors, ...parsed.errors], root, tree, cwd, setUp: userText !== undefined, ...(uc?.legacy === undefined ? {} : { legacy: uc.legacy }) }
  loadedSig = sig
  return loaded
}

const isSession = (v: unknown, id: string): v is Session =>
  typeof v === 'object' && v !== null && (v as Session).id === id && typeof (v as Session).ledger === 'object' && (v as Session).ledger !== null

async function freshSession($: Dollar, l: Loaded, id: string, start: 'startup' | 'clear'): Promise<Session> {
  const version = (await $.session.version()).version
  let s = initSession(l.config, id, now(), start, version)
  for (const msg of l.errors) s = decide(l.config, s, { type: 'error', now: now(), where: 'config', message: msg }).session
  return s
}

/** The session this hook works on: `$.state`, else the stored copy of a resumed session, else a new one. */
async function current($: Dollar): Promise<{ l: Loaded; session: Session }> {
  const l = await getLoaded($)
  const id: string = await $.session.id()
  let held: Session | undefined = (await $.state.get(REF)).value
  // What this process wrote last wins over a state read that has not caught up (hooks that run at the same moment).
  if (latest && latest.id === id && (held === undefined || (isSession(held, id) && (held.rev ?? 0) < (latest.rev ?? 0)))) held = latest
  if (held && held.id === id) return { l, session: heal(l, held) }
  // A different id with no session.start in between: `/clear` and an in-process `/resume` both end the session and
  // go on under another id without one. The old copy (the held state or this process's last write, the newer one)
  // is flushed first; a stored copy under the new id is a resume, anything else is a clear.
  const old = [held, latest].filter((x): x is Session => x !== undefined && x.id !== id).sort((x, y) => (y.rev ?? 0) - (x.rev ?? 0))[0]
  if (old) {
    await flushCopy($, l, old)
    if (sessFor !== id) resetSessionState(id)
    const copy = await $.store.get(`session:${id}`)
    if (isSession(copy, id)) return { l, session: await resumedSession($, l, copy, 'resume') }
    return { l, session: await freshSession($, l, id, 'clear') }
  }
  const stored = await $.store.get(`session:${id}`)
  if (isSession(stored, id)) return { l, session: heal(l, stored) }
  return { l, session: await freshSession($, l, id, 'startup') }
}

/** What a resume does to a stored copy, at `session.start` and at an in-process id switch: errors dropped, the start event, the config, the ask-stopped mark (the caller reset the session state before). */
async function resumedSession($: Dollar, l: Loaded, before: Session, start: 'resume' | 'reload'): Promise<Session> {
  const version = (await $.session.version()).version
  let s = decide(l.config, { ...normalizeSession(before), errors: [] }, { type: 'start', now: now(), start, version }).session
  s = decide(l.config, s, { type: 'config', now: now(), errors: l.errors }).session
  sess.askStopped = s.askStopped === true
  return s
}

/** A session whose ledger lists other skills than the config (a session that missed a config change) follows the config. */
function heal(l: Loaded, held: Session): Session {
  const s = normalizeSession(held)
  const want = [...new Set([...Object.keys(l.config.skills), ...ruleSkillNames(l.config)])]
  const have = Object.keys(s.ledger)
  if (want.length === have.length && want.every((name) => Object.hasOwn(s.ledger, name))) return s
  return decide(l.config, s, { type: 'config', now: now(), errors: l.errors }).session
}

/** One line in the transcript, unless the user switched notices off; true when it was written. A surface without a transcript must not break the hook. */
function say($: Dollar, l: Loaded, line: string): boolean {
  if (l.config.notices === false) return false
  try {
    $.ui.log(line)
    return true
  } catch {
    // The line is a courtesy; the work goes on.
    return false
  }
}

/** Session ids this process has tried to write a store copy for: only the first persist of a session is a flush point; a failed write waits for the next real one. */
const mirrored = new Set<string>()

/** The copy kept in the store: the newest 20 observed entries and 10 errors are enough for `/souffleur` after a resume; a `store:` error is about this write, not the session. */
function slim(s: Session): Session {
  return { ...s, observed: s.observed.slice(-20), errors: s.errors.filter((m) => !m.startsWith('store: ')).slice(-10) }
}

/**
 * Keeps `s0` as the session: `$.state` is its truth, written first, and then the status and the band, each in its own
 * try/catch so a decision never waits for them. Writes the notices for what changed since the copy this process kept
 * last. `quiet` skips the comparison (a subagent's change, a session start). This never writes the store: see `flushCopy`.
 */
async function persist($: Dollar, l: Loaded, s0: Session, quiet = false): Promise<void> {
  let next = s0
  let lines: string[] = []
  if (!quiet && latest && latest.id === s0.id) ({ lines, session: next } = notices(l.config, latest, s0, l.root))
  const s: Session = { ...next, rev: (next.rev ?? 0) + 1, touched: now() }
  latest = s
  try {
    await $.state.set(REF, s)
  } catch (err) {
    $.ui.log(`state write failed: ${message(err)}`, { to: 'debug' })
  }
  for (const line of lines) say($, l, line)
  try {
    // A broken file shows as degraded; only a clean start without a user file says "not set up".
    const notSetUp = !l.setUp && !s.errors.length
    const text = notSetUp ? NOT_SET_UP : statusLine(s, l.config.mode, sectionNotes(l.config, l.root).leftOut.length, l.config, l.root)
    $.ui.status(text)
    // The apps draw no status line: a band stands in for it, but only while something needs attention.
    const tag = l.config.update === 'off' ? undefined : (await readCheck($, false))?.latest
    const newer = tag !== undefined && compareVersions(shown(tag), PLUGIN_VERSION) === 1
    const attention = notSetUp || needsAttention(s, l.config, l.root)
    const bandText = newer ? [text, `${shown(tag)} is out, see /souffleur`].filter(Boolean).join(' · ') : attention ? text : undefined
    await updateAtom($, band, () => (bandText === undefined ? null : { text: bandText }))
  } catch (err) {
    $.ui.log(`status or band failed: ${message(err)}`, { to: 'debug' })
  }
}

/**
 * Writes the copy a resume reads (`session:<id>`) from `s`, else the latest session. Called only at the flush points:
 * a main-loop turn end, after a compaction, on a proposal change, at `session.end` and on a session's first persist.
 * A failure is logged, recorded once as a `store:` error (the status shows degraded) and retried at the next flush
 * point; a success clears that error. It never throws and is never part of a decision.
 */
async function flushCopy($: Dollar, l: Loaded, s: Session | undefined = latest): Promise<void> {
  if (!s) return
  const problem = (m: string) => m.startsWith('store: ')
  mirrored.add(s.id)
  try {
    await $.store.set(`session:${s.id}`, slim(s))
    if (latest?.id === s.id && latest.errors.some(problem)) await persist($, l, decide(l.config, latest, { type: 'recovered', now: now(), where: 'store' }).session, true)
  } catch (err) {
    $.ui.log(`store copy failed: ${message(err)}`, { to: 'debug' })
    try {
      if (latest?.id === s.id && !latest.errors.some(problem)) await persist($, l, decide(l.config, latest, { type: 'error', now: now(), where: 'store', message: message(err) }).session, true)
    } catch {
      // Recording failed too; the decision has been made.
    }
  }
}

/** After a persist: flush when the caller says so, the proposal queue changed or the session has no copy yet. */
async function settle($: Dollar, l: Loaded, before: Session, after: Session, force = false): Promise<void> {
  if (force || !mirrored.has(after.id) || JSON.stringify(after.proposals) !== JSON.stringify(before.proposals)) await flushCopy($, l)
}

/** Plugin store key of the last release check. */
const UPDATE_KEY = 'updateCheck'
const REPO_URL = 'https://github.com/r4KK4n/skill-souffleur'

/** The last release check as this process knows it: read at session start and when the check runs, not at every persist. */
let checkCache: { value: { at: number; latest?: string } | undefined } | undefined

async function readCheck($: Dollar, fresh = true): Promise<{ at: number; latest?: string } | undefined> {
  if (!fresh && checkCache) return checkCache.value
  try {
    const stored: unknown = await $.store.get(UPDATE_KEY)
    checkCache = { value: isUpdateCheck(stored) ? stored : undefined }
  } catch {
    return undefined
  }
  return checkCache.value
}

const KIND_KEY = 'installKind'

/** True when `path` is `dir` or lies under it. */
const underDir = (path: string, dir: string) => path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`)

/** The real path of `path` (symlinks resolved), or `path` itself when it cannot be resolved. */
async function realOf($: Dollar, path: string): Promise<string> {
  try {
    return collapsePath((await $.fs.stat(path, { resolve: true }))?.realPath ?? path)
  } catch {
    return collapsePath(path)
  }
}

/** True when Claude Code owns the plugin root: its real path lies under the real `<user config dir>/plugins/` or `~/.claude/plugins/` or equals the real path of an `installPath` in `installed_plugins.json`. A missing or unreadable file means no ownership found; an unknown home folder counts as owned (fail safe: no install). */
async function ownedByMarketplace($: Dollar): Promise<boolean> {
  const dir = await userDir($)
  const home = await homeOf($)
  // collapsePath reads `/` only: a folder that does not start with `/` (a drive path, `\`) cannot be compared, so it counts as owned (no install).
  const plain = (p: string | undefined): p is string => p !== undefined && p.startsWith('/') && !p.includes('\\')
  if (!plain(dir) || !plain(home)) return true
  // Claude Code may keep plugins in the configured folder or in `~/.claude`: both count.
  const folders = [...new Set([`${collapsePath(dir)}/plugins`, `${collapsePath(home)}/.claude/plugins`])]
  const roots = new Set([collapsePath($.plugin.root), await realOf($, $.plugin.root)])
  for (const plugins of folders) {
    const realPlugins = await realOf($, plugins)
    if ([...roots].some((r) => underDir(r, plugins) || underDir(r, realPlugins))) return true
  }
  for (const plugins of folders) {
    try {
      const listed: unknown = parseJson(await $.fs.read(`${plugins}/installed_plugins.json`))
      const all = (listed as { plugins?: Record<string, unknown> } | null)?.plugins ?? {}
      for (const copies of Object.values(all)) {
        if (!Array.isArray(copies)) continue
        for (const c of copies) {
          const p: unknown = (c as { installPath?: unknown } | null)?.installPath
          if (typeof p !== 'string') continue
          if (roots.has(collapsePath(p)) || roots.has(await realOf($, p))) return true
        }
      }
    } catch {
      // No file or not JSON: nothing owns the folder.
    }
  }
  return false
}

/** A folder install when the plugin root is the top of a git work tree (`--show-prefix` prints nothing) and Claude Code does not own it; anything else, or no git, is a marketplace install. */
export async function installKind($: Dollar): Promise<'folder' | 'market'> {
  try {
    if (await ownedByMarketplace($)) return 'market'
    const r = await $.process.run(['git', '-C', $.plugin.root, 'rev-parse', '--show-prefix'], { timeoutMs: 5000 })
    return r.exitCode === 0 && String(r.stdout).trim() === '' ? 'folder' : 'market'
  } catch {
    return 'market'
  }
}

async function cachedKind($: Dollar): Promise<'folder' | 'market' | undefined> {
  try {
    const k: unknown = await $.store.get(KIND_KEY)
    return k === 'folder' || k === 'market' ? k : undefined
  } catch {
    return undefined
  }
}

/** Remembers that the notify line for `tag` was said, so this session does not repeat it (also over reload and resume). */
/** `session id + tag` of the last update line said, set at the moment it is said (the stored mark follows after an await). */
let toldKey = ''

async function markShown($: Dollar, tag: string): Promise<void> {
  await update($, (_l, s) => ({ ...s, updateShown: tag }))
}

/** Looks for a newer release tag and stores the result. Never throws; a failure stores the time so one try happens per day. */
export async function checkForUpdate($: Dollar, l: Loaded, at: number): Promise<void> {
  const before = await readCheck($)
  try {
    if (l.config.update === 'off' || !isCheckDue(before, at)) return
    let check: { at: number; latest?: string }
    try {
      const r = await $.process.run(['git', 'ls-remote', '--tags', '--refs', REPO_URL], { timeoutMs: 15000 })
      if (r.exitCode !== 0) throw new Error(`git exited with ${r.exitCode}`)
      const out = String(r.stdout)
      const newest = newestRelease(out, PLUGIN_VERSION)
      if (newest !== undefined) check = { at, latest: newest }
      else if (out.trim() !== '' && !/^[0-9a-f]+\trefs\/tags\//m.test(out)) {
        $.ui.log('update check: unparsable ls-remote output', { to: 'debug' })
        check = { at }
      } else check = { at, latest: `v${PLUGIN_VERSION}` }
    } catch (err) {
      $.ui.log(`update check failed: ${message(err)}`, { to: 'debug' })
      check = { at, ...(before?.latest === undefined ? {} : { latest: before.latest }) }
    }
    await $.store.set(UPDATE_KEY, check)
    checkCache = { value: check }
  } catch {
    // A courtesy check: the next start tries again.
  }
}

/** The stored check as `/souffleur` shows it. */
async function updateInfo($: Dollar): Promise<UpdateInfo> {
  const c = await readCheck($)
  return { current: PLUGIN_VERSION, ...(c?.latest === undefined ? {} : { latest: c.latest }), ...(c === undefined ? {} : { at: c.at }) }
}

const RELEASE_TAG = /^v\d+\.\d+\.\d+$/
const GIT_TIMEOUT_MS = 10_000
const FETCH_TIMEOUT_MS = 30_000

type Run = { exitCode: number; stdout: string; stderr: string }

async function git($: Dollar, args: readonly string[], timeoutMs = GIT_TIMEOUT_MS): Promise<Run> {
  const r = await $.process.run(['git', '-C', $.plugin.root, ...args], { timeoutMs })
  return { exitCode: r.exitCode, stdout: String(r.stdout), stderr: String(r.stderr ?? '') }
}

/** Why the folder install must be left alone, or undefined when it is clean and exactly on a release tag. */
async function installBlocker($: Dollar): Promise<string | undefined> {
  const status = await git($, ['status', '--porcelain'])
  if (status.exitCode !== 0) throw new Error(`git status exited with ${status.exitCode}`)
  if (status.stdout.trim() !== '') return 'uncommitted changes in the install'
  const at = await git($, ['describe', '--tags', '--exact-match', 'HEAD'])
  return at.exitCode === 0 && RELEASE_TAG.test(at.stdout.trim()) ? undefined : 'the install is not on a release tag'
}

/**
 * True when the tag object `oid` (the object `refs/tags/<tag>` pointed to when it was resolved) is an SSH-signed tag named `tag`
 * whose signature is the `updateSigner` key's. Git picks the verifier from the signature armor, so a PGP-signed tag would pass
 * `gpg.format=ssh`; the armor is therefore required here. The signature does not cover the ref name, so the object's own
 * `tag` header must equal `tag`. The allowed_signers file is rewritten each time, so an older key never stays valid.
 */
async function tagVerified($: Dollar, signer: string, tag: string, oid: string): Promise<boolean> {
  const obj = await git($, ['cat-file', 'tag', oid])
  if (obj.exitCode !== 0) return false
  if (!signedTagObject(obj.stdout, tag)) return false
  const dir = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA
  if (dir === undefined || dir === '') throw new Error('no plugin data folder')
  const file = `${dir}/allowed_signers`
  await $.fs.write(file, allowedSigners(signer))
  const r = await git($, verifyTagArgs(file, oid))
  return r.exitCode === 0 && goodSignature(r.stderr)
}

type Install = { done: 'installed'; signed: boolean } | { done: 'refused'; reason: string } | { done: 'unverified' } | { done: 'busy' }

const LOCK_STALE_MS = 120_000

/** Runs a command without a shell; true when it exits 0. */
async function ok($: Dollar, argv: string[]): Promise<boolean> {
  try {
    return (await $.process.run(argv, { timeoutMs: 5000 })).exitCode === 0
  } catch {
    return false
  }
}

/**
 * Takes the lock `<plugin data>/<name>`, runs `fn`, releases it. The lock is a folder made with `mkdir`, which fails when it exists, so one
 * session wins. An `owner` file inside holds `{ at, token }`. A lock older than `staleMs`, dated in the future or with no readable owner and
 * an old folder is stale: it is removed and taken once. The release removes the folder only while the token is ours. `undefined` when another
 * session holds the lock. Throws when the lock cannot be made at all (no data folder, no `mkdir`); `label` names it in that error.
 */
async function withLock<T>($: Dollar, name: string, label: string, staleMs: number, fn: () => Promise<T>): Promise<{ value: T } | undefined> {
  const data = (await $.process.hookEnv()).CLAUDE_PLUGIN_DATA
  if (data === undefined || data === '') throw new Error('no plugin data folder')
  const lock = `${data}/${name}`
  const owner = `${lock}/owner`
  const readOwner = async (): Promise<{ at?: unknown; token?: unknown } | undefined> => {
    try {
      const o: unknown = parseJson(await $.fs.read(owner))
      return typeof o === 'object' && o !== null ? o : undefined
    } catch {
      return undefined
    }
  }
  const exists = async (path: string) => {
    try {
      return (await $.fs.stat(path)) !== undefined
    } catch {
      return false
    }
  }
  const mtime = async (path: string) => {
    try {
      const m = (await $.fs.stat(path))?.mtimeMs
      return typeof m === 'number' ? m : undefined
    } catch {
      return undefined
    }
  }
  /** Stale only when an age is known: an owner stamp or the folder's time. No age at all counts as fresh. */
  const stale = async () => {
    const at = (await readOwner())?.at
    const t = typeof at === 'number' ? at : await mtime(lock)
    const wall = await wallNow($)
    return t !== undefined && (t > wall || wall - t >= staleMs)
  }
  await ok($, ['mkdir', '-p', data])
  let made = await ok($, ['mkdir', lock])
  if (!made) {
    // A lock that cannot be made and is not there is a host problem (no mkdir, a data folder that cannot be created), not another session.
    if (!(await exists(lock))) {
      // The holder may have released between our mkdir and this check: try once more before calling it a host problem.
      made = await ok($, ['mkdir', lock])
      if (!made && !(await exists(lock))) throw new Error(`could not create the ${label}`)
      if (!made) return undefined
    } else if (!(await stale())) return undefined
  }
  if (!made) {
    // One session removes a stale lock: the one that makes the takeover folder.
    const take = `${lock}.takeover`
    if (!(await ok($, ['mkdir', take]))) {
      const t = await mtime(take)
      if (t !== undefined && (await wallNow($)) - t >= staleMs) await ok($, ['rm', '-rf', take])
      return undefined
    }
    try {
      // Another session may have finished a takeover since the verdict above: judge again under the guard.
      if (!(await stale())) return undefined
      await ok($, ['rm', '-rf', lock])
      made = await ok($, ['mkdir', lock])
    } finally {
      await ok($, ['rm', '-rf', take])
    }
  }
  if (!made) return undefined
  const stamp = await wallNow($)
  const token = `${stamp}-${Math.random().toString(36).slice(2)}`
  try {
    await $.fs.write(owner, JSON.stringify({ at: stamp, token }))
  } catch (err) {
    await ok($, ['rm', '-rf', lock])
    throw err
  }
  try {
    return { value: await fn() }
  } finally {
    if ((await readOwner())?.token === token) await ok($, ['rm', '-rf', lock])
  }
}

/** The install lock: `update.lock`, stale after 2 minutes. */
const withInstallLock = <T>($: Dollar, fn: () => Promise<T>) => withLock($, 'update.lock', 'update lock', LOCK_STALE_MS, fn)

/** Under the install lock: fetches, resolves `tag` once to an object id, verifies that object when a signer is set (or `needSigner`), and checks out its commit. Throws on a git failure. */
async function installTag($: Dollar, l: Loaded, tag: string, needSigner: boolean): Promise<Install> {
  return (await withInstallLock($, () => installTagLocked($, l, tag, needSigner)))?.value ?? { done: 'busy' }
}

async function installTagLocked($: Dollar, l: Loaded, tag: string, needSigner: boolean): Promise<Install> {
  const blocker = await installBlocker($)
  if (blocker !== undefined) return { done: 'refused', reason: blocker }
  const f = await git($, ['fetch', '-q', '--tags', REPO_URL], FETCH_TIMEOUT_MS)
  if (f.exitCode !== 0) throw new Error(`git fetch exited with ${f.exitCode}`)
  const signer = l.config.updateSigner
  if (signer === undefined && needSigner) return { done: 'unverified' }
  const resolved = await git($, ['rev-parse', '--verify', `refs/tags/${tag}`])
  const oid = resolved.stdout.trim()
  if (resolved.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(oid)) throw new Error(`git rev-parse exited with ${resolved.exitCode}`)
  if (signer !== undefined && !(await tagVerified($, signer, tag, oid))) return { done: 'unverified' }
  const c = await git($, ['checkout', '-q', `${oid}^{commit}`])
  if (c.exitCode !== 0) throw new Error(`git checkout exited with ${c.exitCode}`)
  return { done: 'installed', signed: signer !== undefined }
}

/** Automatic install, run detached after the start line: only a tag signed by `updateSigner` installs, once per session and tag. */
async function autoInstall($: Dollar, l: Loaded, sid: string): Promise<void> {
  const tag = (await readCheck($))?.latest
  if (tag === undefined || compareVersions(tag.slice(1), PLUGIN_VERSION) !== 1) return
  if (latest?.id === sid && latest.updateShown === tag) return
  if (toldKey === `${sid}:${tag}`) return
  toldKey = `${sid}:${tag}`
  const tell = async (line: string) => {
    if (say($, l, line)) await markShown($, tag)
  }
  if (l.config.updateSigner === undefined) return tell(updateLine('auto-no-signer', tag, PLUGIN_VERSION))
  try {
    const r = await installTag($, l, tag, true)
    if (r.done === 'busy') $.ui.log('update install skipped: another session holds the install lock', { to: 'debug' })
    else if (r.done === 'refused') await tell(refusalLine(r.reason, $.plugin.root))
    else if (r.done === 'unverified') await tell(updateLine('auto-unverified', tag, PLUGIN_VERSION, $.plugin.root))
    else await tell(updateLine('auto-done', tag, PLUGIN_VERSION))
  } catch (err) {
    $.ui.log(`update install failed: ${message(err)}`, { to: 'debug' })
  }
}

/** `/souffleur update`: installs the newest release now. Verifies when a signer is set; installs an unsigned tag only because the person asked. */
/** First line of a git message, cut to 120 characters, without a final dot; `fallback` when it is empty. */
function shortReason(text: string, fallback: string): string {
  return text.split('\n').map((x) => x.trim()).find((x) => x !== '')?.slice(0, 120).replace(/\.+$/, '') || fallback
}

async function runUpdate($: Dollar, l: Loaded): Promise<string> {
  if ((await installKind($)) === 'market') return 'Souffleur: installed through the marketplace; run /plugin update.'
  let r: { exitCode: number; stdout: unknown; stderr?: unknown }
  try {
    r = await $.process.run(['git', 'ls-remote', '--tags', '--refs', REPO_URL], { timeoutMs: 15000 })
  } catch (err) {
    return `Souffleur: could not look up releases: ${shortReason(message(err), 'git failed')}.`
  }
  if (r.exitCode !== 0) return `Souffleur: could not look up releases: ${shortReason(String(r.stderr ?? ''), `git exited with ${r.exitCode}`)}.`
  const tag = newestRelease(String(r.stdout), PLUGIN_VERSION)
  if (tag === undefined) return `Souffleur: ${PLUGIN_VERSION} is the newest release.`
  let done: Install
  try {
    done = await installTag($, l, tag, false)
  } catch (err) {
    return `Souffleur: could not install ${shown(tag)}: ${message(err).split('\n')[0]!.slice(0, 120)}.`
  }
  if (done.done === 'busy') return 'Souffleur: another session is installing an update; try again in a minute.'
  if (done.done === 'refused') return refusalLine(done.reason, $.plugin.root)
  if (done.done === 'unverified') return `Souffleur: ${shown(tag)} is not signed by your updateSigner key; not installed.`
  return `Souffleur: updated to ${shown(tag)} (${done.signed ? 'signed' : 'unsigned; you asked for it'})\nRunning sessions pick it up at their next turn.`
}

/** Stored copies of sessions not touched for this long are removed at session start. */
const SESSION_TTL_MS = 14 * 86_400_000
/** Stored session copies kept, the one in use included. */
const SESSION_KEEP = 50

/** Plugin store prefix of the per-skill-version read records; they follow the same age rule as the session copies. */
const HASH_PREFIX = hashKey('')

/**
 * Housekeeping at session start, run in the background: removes `session:*` and `souffleur:skill-hash:*` entries of the plugin store whose copy was stored more than 14 days
 * ago, then the oldest session copies beyond 50. A copy without a timestamp (stored before this existed) gets one now and goes after 14 days. Never touches the
 * session in use or other keys. The caller logs a failure to debug: it is not an error of the session, and the next start tries again.
 */
async function pruneStore($: Dollar, currentId: string): Promise<void> {
  const keys: string[] = await $.store.keys()
  const kept: { key: string; touched: number }[] = []
  // One fresh reading for the whole pass: stamps were written by other processes.
  const wall = await wallNow($)
  for (const key of keys) {
    const isSession = key.startsWith('session:')
    if (!(isSession || key.startsWith(HASH_PREFIX)) || key === `session:${currentId}`) continue
    const copy: unknown = await $.store.get(key)
    const touched = typeof copy === 'object' && copy !== null ? (copy as { touched?: unknown }).touched : undefined
    if (typeof touched === 'number') {
      if (wall - touched > SESSION_TTL_MS) await $.store.delete(key)
      else if (isSession) kept.push({ key, touched })
    } else if (typeof copy === 'object' && copy !== null) {
      await $.store.set(key, { ...copy, touched: wall })
      if (isSession) kept.push({ key, touched: wall })
    }
  }
  kept.sort((a, b) => b.touched - a.touched)
  for (const { key } of kept.slice(SESSION_KEEP - 1)) await $.store.delete(key)
}

/** The fixed instruction of both classifier calls; the labels and the text go in the prompt. */
const CLASSIFIER_SYSTEM = 'You are a classifier. Answer with exactly one of the labels you are given and nothing else.'

/** Plugin store key of the small-model count over all sessions. */
const TOTAL_KEY = 'modelUseTotal'

const isUse = (v: unknown): v is ModelUse => typeof v === 'object' && v !== null && typeof (v as ModelUse).calls === 'number' && typeof (v as ModelUse).usd === 'number'

/** The session id that was told the legacy config line, so it is said once per session. */
let legacyTold: string | undefined
const legacyLine = (cfgDir: string) => `Config: using ~/.claude/souffleur.json; CLAUDE_CONFIG_DIR is ${cfgDir}. Move the file there to follow it.`

/** The small-model count over all sessions; undefined when none is stored or the store fails. */
async function readTotal($: Dollar): Promise<ModelUse | undefined> {
  try {
    const stored: unknown = await $.store.get(TOTAL_KEY)
    return isUse(stored) ? stored : undefined
  } catch {
    return undefined
  }
}

/** Adds one returned call to the session count and the total. Never throws. */
async function countCall($: Dollar, model: string, usage: UsageFields | undefined): Promise<void> {
  try {
    await update($, (_l, s) => ({ ...s, modelUse: addUsage(s.modelUse, model, usage) }))
  } catch {
    // the count is a courtesy
  }
  try {
    await serial(async () => {
      await $.store.set(TOTAL_KEY, addUsage(await readTotal($), model, usage))
    })
  } catch {
    // the total is best effort
  }
}

/**
 * Every small-model call goes through here. A call that came back is counted once in the session and once in the total,
 * with its tokens when it was answered, however late it comes back. The counting runs detached, so it never delays the
 * answer. The total is read, changed and written (best effort: another process may add a call in between, and that
 * call is lost). A failure to count never fails the caller.
 */
async function callModel($: Dollar, request: ModelCompleteRequest): Promise<ModelCompleteResult> {
  const r = await $.model.complete(request)
  void countCall($, request.model, r?.isAnswered === true ? r.usage : undefined)
  return r
}

/** Session reads and writes wait for each other: two hooks at the same moment must not both read the old state. */
let chain: Promise<unknown> = Promise.resolve()
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work)
  chain = run.catch(() => undefined)
  return run
}

/** Feeds one event to the core and stores the result. */
function apply($: Dollar, make: (l: Loaded) => CoreEvent): Promise<{ actions: Action[]; l: Loaded }> {
  return serial(async () => {
    await syncClock($)
    const { l, session } = await current($)
    const event = make(l)
    const r = decide(l.config, session, event)
    // What a subagent does is not the main session's news.
    const agent = 'agentId' in event && event.agentId !== undefined
    // Flush points: the main loop's turn end and a finished compaction.
    const flush = !agent && (event.type === 'seen' || (event.type === 'compact' && event.phase === 'after'))
    // An event that changes nothing stores nothing.
    if (r.session !== session) await persist($, l, r.session, agent)
    if (r.session !== session || flush) await settle($, l, session, r.session, flush)
    return { actions: r.actions, l }
  })
}

/** Runs the adapter's own work. A throw becomes an `error` event and `fallback`; it never reaches the event. */
async function safe<T>($: Dollar, where: string, fallback: T, work: () => Promise<T>): Promise<T> {
  try {
    const result = await work()
    try {
      if (latest?.errors.some((m) => m.startsWith(`${where}: `))) await apply($, () => ({ type: 'recovered', now: now(), where }))
    } catch {
      // Clearing failed; the error stays until the next success.
    }
    return result
  } catch (err) {
    try {
      await apply($, () => ({ type: 'error', now: now(), where, message: message(err) }))
    } catch {
      // Recording failed too; the event still goes through.
    }
    return fallback
  }
}

/** How long the skill listing may take before the prompt goes on without it. */
const LIST_BUDGET_MS = 300

/**
 * The names `$.session.usage` lists (observed on 2.1.332: plugin skills as `plugin:skill`, others bare), or undefined when
 * that list is missing, empty or incomplete. The command list is not used: it is a different list, so it would mark skills wrongly.
 */
async function listedSkills($: Dollar): Promise<string[] | undefined> {
  try {
    const skills = (await $.session.usage({ breakdown: 'summary' }))?.context?.breakdown?.skills
    const listed: { name: string }[] | undefined = skills?.skillFrontmatter
    if (!skills || !listed?.length) return undefined
    if (typeof skills.totalSkills === 'number' && typeof skills.includedSkills === 'number' && skills.includedSkills < skills.totalSkills) return undefined
    return [...new Set(listed.map((x) => x.name))]
  } catch {
    return undefined
  }
}

/** Tells the ledger which skills this session lists, so configured skills it lacks are neither requested nor gated. Gives up after the budget. */
async function refreshInstalled($: Dollar): Promise<void> {
  const names = await Promise.race([listedSkills($), $.clock.sleep(LIST_BUDGET_MS).then(() => undefined)])
  if (names?.length) await apply($, () => ({ type: 'installed', now: now(), names }))
}

/**
 * What the plugin behind `skill` (`plugin:name`) says about SessionStart hooks, over every installed copy of it: its
 * `hooks/hooks.json` and the hooks declared in `plugin.json`. `mentions`: a hook command names the skill. `none` only
 * when every file could be read and none declares one; anything unsure is `unknown`.
 */
async function pluginStartHooks($: Dollar, dir: string, skill: string): Promise<StartHooks> {
  const plugin = skill.split(':')[0]!
  const bareName = skill.split(':').pop()!
  const names = new RegExp(`(^|[^A-Za-z0-9])${bareName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`)
  try {
    const listed: unknown = parseJson(await $.fs.read(`${dir}/plugins/installed_plugins.json`))
    const plugins = (listed as { plugins?: Record<string, { installPath?: unknown }[]> }).plugins ?? {}
    const dirs = Object.entries(plugins)
      .filter(([key]) => key.split('@')[0] === plugin)
      .flatMap(([, copies]) => (Array.isArray(copies) ? copies : []))
      .flatMap((copy) => (typeof copy?.installPath === 'string' ? [copy.installPath] : []))
    if (!dirs.length) return 'unknown'
    let read = 0
    let unsure = false
    let declared = false
    const commands: string[] = []
    const take = (hooks: unknown) => {
      const groups = typeof hooks === 'object' && hooks !== null ? (hooks as Record<string, unknown>).SessionStart : undefined
      if (!Array.isArray(groups) || groups.length === 0) return
      declared = true
      for (const g of groups) for (const h of Array.isArray(g?.hooks) ? g.hooks : []) if (typeof h?.command === 'string') commands.push(h.command)
    }
    for (const dir of dirs) {
      for (const file of [`${dir}/hooks/hooks.json`, `${dir}/.claude-plugin/plugin.json`]) {
        if (!(await $.fs.exists(file))) continue
        try {
          const doc = parseJson(await $.fs.read(file)) as { hooks?: unknown }
          read += 1
          if (typeof doc.hooks === 'string') {
            const more = `${dir}/${doc.hooks.replace(/^\.\//, '')}`
            if (await $.fs.exists(more)) take((parseJson(await $.fs.read(more)) as { hooks?: unknown }).hooks)
            else unsure = true
          } else take(doc.hooks)
        } catch {
          unsure = true
        }
      }
    }
    if (declared) return commands.some((c) => names.test(c)) ? 'mentions' : 'exists'
    return read > 0 && !unsure ? 'none' : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** The names `$.session.usage` lists, with the command list as a fallback. For init's candidates only: it says nothing about what is installed here. */
async function installedSkills($: Dollar): Promise<string[]> {
  const listed = await listedSkills($)
  if (listed) return listed
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const partial: { name: string }[] | undefined = usage?.context?.breakdown?.skills?.skillFrontmatter
    if (partial?.length) return [...new Set(partial.map((x) => x.name))]
  } catch {
    // fall through to the command list
  }
  try {
    return (await $.command.list()).map((c: { name: string }) => c.name)
  } catch {
    return []
  }
}

const stamp = (ms: number) => {
  const iso = new Date(ms).toISOString()
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`
}

/** A backup name nobody has used yet: the time to the second, then a counter. */
async function freeBackupPath($: Dollar, settingsPath: string): Promise<string> {
  const base = `${settingsPath}.bak-souffleur-${stamp(now())}`
  for (let n = 0; n < 1000; n++) {
    const path = n === 0 ? base : `${base}-${n}`
    if (!(await $.fs.exists(path))) return path
  }
  throw new Error('no free backup name')
}

/** `~/.claude/settings.json` as a value; `error` says why it cannot be used (unreadable or not JSON). */
async function readSettings($: Dollar, path: string, home: string): Promise<{ text?: string; value?: unknown; error?: string }> {
  const st = await readState($, path, home)
  if (st.kind === 'missing') return {}
  if (st.kind === 'error') return { error: `could not read ${shownPath(home, path)} (${st.why})` }
  try {
    return { text: st.text, value: parseJson(st.text) }
  } catch {
    return { text: st.text, error: `${shownPath(home, path)} is not valid JSON` }
  }
}

/** Installed skill names with the one-line description the command list gives, where there is one. */
async function installedWithDescriptions($: Dollar): Promise<{ name: string; description?: string }[]> {
  const names = await installedSkills($)
  let described = new Map<string, string>()
  try {
    described = new Map((await $.command.list()).map((c: { name: string; description?: string }) => [c.name, c.description ?? '']))
  } catch {
    // names alone are enough
  }
  return names.map((name) => {
    const description = described.get(name)
    return description ? { name, description } : { name }
  })
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** Collapses `.` and `..` segments of an absolute path, so a `../` escape is seen as the path it names. */
function collapsePath(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return `/${out.join('/')}`
}

const insideDir = (path: string, dir: string) => path === dir || path.startsWith(dir === '/' ? '/' : `${dir}/`)

/**
 * A project CLAUDE.md may import only files inside the given project roots, or `.md` files under `claudeDir`, by their real path too:
 * a symlink out does not count. A stat that fails says nothing about where the path leads, so the import is skipped.
 */
async function importAllowed($: Dollar, target: string, roots: string[], claudeDir: string): Promise<boolean> {
  const flat = collapsePath(target)
  const okIn = (path: string, projectRoots: string[], claude: string) => projectRoots.some((r) => insideDir(path, r)) || (insideDir(path, claude) && /\.md$/i.test(path))
  const flatRoots = roots.map(collapsePath)
  const flatClaude = collapsePath(claudeDir)
  if (!okIn(flat, flatRoots, flatClaude)) return false
  let real: string | undefined
  try {
    real = (await $.fs.stat(flat, { resolve: true }))?.realPath
  } catch (err) {
    try {
      $.ui.log(`import skipped: could not resolve ${flat}: ${message(err)}`, { to: 'debug' })
    } catch {
      // A surface without a log must not fail init or migrate.
    }
    return false
  }
  if (real === undefined) return true
  const resolved = async (r: string) => {
    const rr = (await $.fs.stat(r, { resolve: true }).catch(() => undefined))?.realPath
    return rr === undefined ? undefined : collapsePath(rr)
  }
  const realRoots = [...flatRoots]
  for (const r of roots) {
    const rr = await resolved(r)
    if (rr !== undefined) realRoots.push(rr)
  }
  return okIn(collapsePath(real), realRoots, (await resolved(claudeDir)) ?? flatClaude)
}

/**
 * The standing instructions to scan: user and project CLAUDE.md, the files a CLAUDE.md imports with `@path` (one level),
 * and the memory index of the project (named after the main repository root).
 */
async function readStanding($: Dollar, l: Loaded, home: string, claudeDir: string, notes: string[]): Promise<{ file: string; text: string; project: boolean }[]> {
  const slug = l.root.replace(/[^A-Za-z0-9]/g, '-')
  const claudeMds = [...new Set([`${claudeDir}/CLAUDE.md`, `${l.root}/CLAUDE.md`, `${l.cwd}/CLAUDE.md`])]
  const files: { file: string; text: string; project: boolean }[] = []
  const seen = new Set<string>()
  for (const path of claudeMds) {
    const text = await readOptional($, path, notes, home)
    if (text === undefined) continue
    seen.add(path)
    const project = path !== `${claudeDir}/CLAUDE.md`
    files.push({ file: shownPath(home, path), text, project })
    const dir = path.slice(0, path.lastIndexOf('/'))
    for (const m of text.matchAll(/(?:^|\s)@([^\s@]+\.[A-Za-z0-9]+)/g)) {
      const ref = m[1]!
      const target = ref.startsWith('/') ? ref : ref.startsWith('~/') ? `${home}/${ref.slice(2)}` : `${dir}/${ref.replace(/^\.\//, '')}`
      if (seen.has(target)) continue
      seen.add(target)
      if (project && !(await importAllowed($, target, [l.root, l.tree, l.cwd], claudeDir))) continue
      const imported = await readOptional($, target, notes, home)
      if (imported !== undefined) files.push({ file: shownPath(home, target), text: imported, project })
    }
  }
  const memory = `${claudeDir}/projects/${slug}/memory/MEMORY.md`
  const text = await readOptional($, memory, notes, home)
  if (text !== undefined) files.push({ file: shownPath(home, memory), text, project: false })
  return files
}

const withNotes = (text: string, notes: string[]) => (notes.length ? `${text}\n\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}` : text)

/**
 * `/souffleur init`: asks per skill how it is kept and writes each answer to the user file as it comes.
 * It reads the files fresh, writes only the user file, and writes nothing when the file cannot be read or edited.
 * Where no dialog answers, it returns the recommendations and the config they give, and writes nothing.
 */
async function runInit($: Dollar, l0: Loaded, only?: string[]): Promise<string> {
  const notes: string[] = []
  const home: string | undefined = await homeOf($)
  const uc = await userConfig($)
  if (!home || !uc) return 'Souffleur init: the home folder is unknown, so nothing was changed.'
  const configPath = uc.path
  const settingsPath = `${uc.dir}/settings.json`
  const shown = (path: string) => shownPath(home, path)
  const stop = (why: string) => `Souffleur init: ${why}, so nothing was changed. Fix that and run /souffleur init again.`

  // Fresh reads: the config cached at session start may be out of date.
  const user = await readState($, configPath, home)
  if (user.kind === 'error') return stop(`could not read ${shown(configPath)} (${user.why})`)
  let userDoc: unknown
  if (user.kind === 'ok') {
    try {
      userDoc = parseJson(user.text)
    } catch (err) {
      return stop(`${shown(configPath)} is not valid JSON (${message(err)})`)
    }
    const problem = configProblem(userDoc)
    if (problem) return stop(`${shown(configPath)} cannot be edited because ${problem}`)
  }
  const projectText = await readOptional($, `${l0.root}/.claude/souffleur.json`, notes, home)
  // init edits the standard: it reads the config without this root's block, and leaves out what the block names or adds.
  const userSrc = user.kind === 'ok' ? stripBom(user.text) : undefined
  const projectSrc = projectText === undefined ? undefined : stripBom(projectText)
  const config = parseConfig(userSrc, projectSrc).config
  const here = parseConfig(userSrc, projectSrc, l0.root)
  notes.push(...here.errors)
  // Raw keys, so an entry that failed validation is skipped as well.
  const rawProjects = isRecord(userDoc) && isRecord(userDoc.projects) ? userDoc.projects : undefined
  const rawKey = rawProjects === undefined ? undefined : Object.keys(rawProjects).find((k) => normRoot(k) === normRoot(l0.root))
  const rawBlock = rawProjects === undefined || rawKey === undefined ? undefined : rawProjects[rawKey]
  const rawNames = (v: unknown): string[] => (isRecord(v) ? Object.keys(v) : [])
  const rawIds = (v: unknown): string[] => (Array.isArray(v) ? v.flatMap((x) => (isRecord(x) && typeof x.id === 'string' ? [x.id] : [])) : [])
  const skip = isRecord(rawBlock)
    ? [...(Array.isArray(rawBlock.block) ? rawBlock.block.filter((n): n is string => typeof n === 'string') : []), ...rawNames(rawBlock.skills), ...rawIds(rawBlock.notes), ...rawIds(rawBlock.rules), ...(Array.isArray(rawBlock.ignored) ? rawBlock.ignored.filter((n): n is string => typeof n === 'string') : [])]
    : []
  skip.push(...(here.config.project?.blocked ?? []), ...(here.config.project?.own ?? []))
  const projectSkills: Record<string, unknown> = Object.fromEntries(Object.entries(config.skills).filter(([, r]) => r.from === 'project'))

  const settings = only === undefined ? await readSettings($, settingsPath, home) : {}
  if (settings.error) notes.push(`${settings.error}, so its hooks were not checked.`)
  const described = await installedWithDescriptions($)
  const installed = described.map((x) => x.name)
  const configured = Object.keys(config.skills)
  const hooks = findHookOverlaps(settings.value, configured, installed.filter((n) => !configured.includes(n)))
  const reloadHooked = [...new Set(hooks.flatMap((o) => (o.skill !== undefined && installed.includes(o.skill) && !(Object.hasOwn(config.skills, o.skill)) ? [o.skill] : [])))]
  const startHooked = new Set(hooks.flatMap((o) => (o.event === 'SessionStart' && o.skill !== undefined ? [o.skill] : [])))
  const passages = only === undefined ? findPassages(await readStanding($, l0, home, uc.dir, notes), configured, Infinity) : []

  // One small-model call over the installed skills that have no need yet: unconfigured, hook-reloaded, or in the user file without one.
  // Skills whose description says they run only on an explicit request are not sent; they are advised against watching.
  const explicit = new Set(described.filter((x) => explicitOnly(x.description)).map((x) => x.name))
  const pool = described.filter((x) => {
    const rule = config.skills[x.name]
    return (only === undefined || only.includes(x.name)) && !explicit.has(x.name) && (rule === undefined || (rule.from === 'user' && rule.need === undefined))
  })
  const skips = new Set(explicit)
  let picks: Suggestion[] = []
  if (pool.length) {
    try {
      const r = await callModel($, { model: 'haiku', prompt: picksPrompt(pool, needTexts(config.needs)) })
      if (r.isAnswered) {
        picks = parsePicks(r.text, pool.map((x) => x.name), needTexts(config.needs))
        for (const name of parseSkips(r.text, pool.map((x) => x.name))) skips.add(name)
      }
      else notes.push('The small model gave no answer, so no descriptions are proposed.')
    } catch (err) {
      notes.push(`The small model failed (${scrub(home, message(err))}), so no descriptions are proposed.`)
    }
  }

  // Skills of this project that nothing names yet: asked again here, for this project or everywhere.
  const ownHere = new Set((await projectInstalled($)).filter((n) => !(Object.hasOwn(config.skills, n)) && !skip.includes(n)))
  const plans: Plan[] = candidates(config, installed, reloadHooked, [...picks.map((x) => x.skill), ...ownHere], skip).filter((c) => only === undefined || only.includes(c.skill)).map(({ skill, source }) => {
    const current = currentChoice(config.skills[skill])
    const pick = picks.find((x) => x.skill === skill)
    const need = pick ? { need: pick.need } : {}
    if (source === 'hook') return { skill, source, recommended: startHooked.has(skill) ? 'start' : skips.has(skill) ? 'none' : 'need', ...need }
    if (source === 'model') return { skill, source, recommended: 'need', ...need }
    return { skill, source, ...(current === undefined ? {} : { current }), recommended: current ?? (skips.has(skill) ? 'none' : 'need'), ...need }
  })
  const watched = new Set(plans.map((p) => p.skill))
  const unwatched = installed.filter((name) => !watched.has(name) && !skip.includes(name))
  const toAsk = plans.filter((p) => p.source !== 'project')
  const setUp: string[] = []

  /** The line for an injected result: the plugin's SessionStart hooks decide which one. */
  const injectedLine = async (skill: string) => injectedWarning(skill, await pluginStartHooks($, uc.dir, skill))
  const noDialog = async () => {
    const warnings: string[] = []
    for (const p of toAsk) {
      const line = p.recommended === 'injected' ? await injectedLine(p.skill) : undefined
      if (line) warnings.push(`${p.skill}: ${line}`)
    }
    return withNotes(setupSteps({ plans, userConfig: userDoc, configPath: shown(configPath), unwatched, warnings }), notes)
  }
  const done: string[] = []
  let asked = false
  let wrote = false
  /** The description a dialog shows for "When the task needs it", and whether it is only the fallback. */
  const proposal = (p: Plan): { need: NeedText; fallback: boolean } => {
    if (p.need) return { need: p.need, fallback: false }
    const key = config.skills[p.skill]?.need
    const text = key === undefined ? undefined : config.needs[key]?.what
    if (key !== undefined && text !== undefined) return { need: { key, text }, fallback: false }
    return { need: { key: needKeyFor(p.skill), text: `The task calls for ${p.skill}.` }, fallback: true }
  }

  /** Writes one answer through the user file's one edit path: read again, apply, back up once, write atomically. False when init must stop. */
  const writeAnswer = async (p: Plan, choice: LoadChoice, need: NeedText | undefined, scope: 'project' | 'everywhere'): Promise<boolean> => {
    let applied: { pruned?: string[] } = {}
    const e = await editUserFile(
      $,
      (doc) => {
        const r =
          scope === 'everywhere'
            ? applyChoice(doc, p.skill, choice, need, projectSkills)
            : choice === 'none'
              ? ignoreInProject(doc, l0.root, p.skill)
              : addSkillToProject(doc, l0.root, p.skill, choice === 'need' ? 'need' : choice, need)
        applied = r
        if (r.note) return new Refusal(r.note)
        return doc === undefined && choice === 'none' ? doc : r.config
      },
      { missing: user.kind === 'ok' ? 'refuse' : 'allow' },
    )
    if (!e.ok) {
      if (e.kind === 'refused') {
        done.push(e.detail)
        return true
      }
      const why =
        e.kind === 'missing' ? `${shown(configPath)} was there at the start and is not now`
        : e.kind === 'read' ? `could not read ${shown(configPath)} (${e.detail})`
        : e.kind === 'json' ? `${shown(configPath)} is not valid JSON now (${e.detail})`
        : e.kind === 'problem' ? `${shown(configPath)} cannot be edited because ${e.detail}`
        : e.kind === 'changed' ? `${shown(configPath)} kept changing while it was written`
        : `could not write ${shown(configPath)} (${e.detail})`
      done.push(`Stopped: ${why}. Nothing was written for ${p.skill}.`)
      return false
    }
    const label = choice === 'none' ? 'not watched' : CHOICE_LABEL[choice]
    if (!e.wrote) {
      done.push(`Kept ${p.skill}: ${label}. Nothing was written.`)
      if (choice === 'injected') {
        const line = await injectedLine(p.skill)
        if (line) done.push(line)
      }
      return true
    }
    wrote = true
    const need2 = choice === 'need' ? `for ${need?.text ?? 'its description'}` : choice === 'start' ? 'from the start' : choice === 'injected' ? 'as its plugin injects it' : ''
    setUp.push(choice === 'none' ? `${p.skill}: ${scope === 'project' ? 'ignored here' : 'not watched'}` : `${p.skill}: watched ${need2.replace(/\.$/, '')} ${scope === 'project' ? 'in this project' : 'everywhere'}`)
    done.push(`${p.skill}: ${label}.`)
    if (choice === 'injected') {
      const line = await injectedLine(p.skill)
      if (line) done.push(line)
    }
    if (applied.pruned?.length) done.push(`Removed the unused ${applied.pruned.length === 1 ? 'need' : 'needs'} ${applied.pruned.join(', ')}.`)
    return true
  }
  /** Skills a group answer already wrote or kept, and the skills it left for later. */
  const handled = new Set<string>()
  const later = new Set<string>()
  let stopped = false

  try {
    for (const g of groupByPlugin(toAsk).groups) {
      const short = (skill: string) => skill.slice(g.plugin.length + 1)
      let budget = 600
      const props: string[] = []
      for (const p of g.plans) {
        const line = `${short(p.skill)}: ${proposal(p).need.text}`
        if (props.length >= 8 || line.length > budget) break
        budget -= line.length + 3
        props.push(line)
      }
      const lines = [
        `The plugin ${g.plugin} has ${g.plans.length} skills with no setting yet. Proposed descriptions for "When the task needs it": ${props.join(' | ')}${props.length < g.plans.length ? ` | and ${g.plans.length - props.length} more skills` : ''}`,
        'How should Souffleur keep them all? Ask one by one lets you choose per skill, and so does text typed under Other.',
      ]
      const answer: unknown = await $.ui.ask(`${asked ? '' : `${SETUP_INTRO}\n\n`}${lines.join(' ')}`, { options: [GROUP_ALL, GROUP_NONE, GROUP_ONE, LATER], header: 'Souffleur' })
      asked = true
      if (typeof answer !== 'string' || answer === '') {
        done.push(`Stopped at the plugin ${g.plugin}; ${plural(toAsk.filter((p) => !handled.has(p.skill) && !later.has(p.skill)).length, 'skill')} not asked.`)
        stopped = true
        break
      }
      if (answer === LATER) {
        for (const p of g.plans) later.add(p.skill)
      } else if (answer === GROUP_NONE) {
        for (const p of g.plans) {
          handled.add(p.skill)
          if (!(await writeAnswer(p, 'none', undefined, ownHere.has(p.skill) ? 'project' : 'everywhere'))) {
            stopped = true
            break
          }
        }
        if (stopped) break
      } else if (answer === GROUP_ALL) {
        // One scope question for the group's skills that only this project has.
        let scope: 'project' | 'everywhere' | undefined = 'everywhere'
        if (g.plans.some((p) => ownHere.has(p.skill))) {
          const where = await $.ui.ask(`Where should ${g.plans.filter((p) => ownHere.has(p.skill)).map((p) => p.skill).join(', ')} apply? These skills only this project has. This project only keeps them out of your other projects; Everywhere adds them to your standard.`, { options: ['This project only', 'Everywhere'], header: 'Souffleur' })
          scope = where === 'This project only' ? 'project' : where === 'Everywhere' ? 'everywhere' : undefined
        }
        for (const p of g.plans) {
          handled.add(p.skill)
          if (scope === undefined && ownHere.has(p.skill)) done.push(`${p.skill}: skipped, no answer about where it applies. Nothing was written for it.`)
          else if (!(await writeAnswer(p, 'need', proposal(p).need, ownHere.has(p.skill) ? (scope ?? 'everywhere') : 'everywhere'))) {
            stopped = true
            break
          }
        }
        if (stopped) break
      }
    }
    for (const [i, p] of toAsk.entries()) {
      if (stopped) break
      if (handled.has(p.skill)) continue
      if (later.has(p.skill)) {
        done.push(`${p.skill}: decided later; /souffleur init asks again.`)
        continue
      }
      let choice: LoadChoice
      let need: NeedText | undefined
      let scope: 'project' | 'everywhere' = 'everywhere'
      {
        const prop = proposal(p)
        const lines = [
          `${describePlan(p)}.`,
          prop.fallback
            ? `No description was proposed, so "When the task needs it" would read: "${prop.need.text}" Text typed under Other replaces it.`
            : `Description for "When the task needs it": ${prop.need.text} Text typed under Other replaces it.`,
          ...(options(p.skill, p.current, p.recommended).includes(CHOICE_LABEL.injected) ? [INJECTED_HELP] : []),
          'How should Souffleur keep it?',
        ]
        const question = `${asked ? '' : `${SETUP_INTRO}\n\n`}${lines.join(' ')}`
        const answer: unknown = await $.ui.ask(question, { options: options(p.skill, p.current, p.recommended), header: 'Souffleur' })
        asked = true
        const picked = typeof answer === 'string' && answer !== '' ? choiceOf(answer) : 'stop'
        if (picked === 'stop') {
          done.push(`Stopped at ${p.skill}; ${plural(toAsk.slice(i).filter((x) => !handled.has(x.skill) && !later.has(x.skill)).length, 'skill')} not asked.`)
          stopped = true
          break
        }
        if (picked === 'later') {
          done.push(`${p.skill}: decided later; /souffleur init asks again.`)
          continue
        }
        if (picked === undefined) {
          const text = cleanNeedText(answer as string)
          if (text === undefined) {
            done.push(`${p.skill}: skipped, a description must be one line of 1 to 200 characters. Nothing was written for it.`)
            continue
          }
          choice = 'need'
          need = { key: prop.need.key, text }
        } else {
          choice = picked
          need = choice === 'need' ? prop.need : undefined
        }

        // A project's own skill: "Don't watch" ignores it here; any other answer asks where it applies.
        if (ownHere.has(p.skill)) {
          if (choice === 'none') scope = 'project'
          else {
            const where = await $.ui.ask(`Where should ${p.skill} apply? This project only keeps it out of your other projects; Everywhere adds it to your standard.`, { options: ['This project only', 'Everywhere'], header: 'Souffleur' })
            if (where === 'This project only') scope = 'project'
            else if (where !== 'Everywhere') {
              done.push(`${p.skill}: skipped, no answer about where it applies. Nothing was written for it.`)
              continue
            }
          }
        }
      }
      if (!(await writeAnswer(p, choice, need, scope))) break
    }
  } catch (err) {
    if (!asked) return noDialog()
    done.push(`Stopped early: ${scrub(home, message(err))}. Answers given so far are kept.`)
  }
  if (!asked && toAsk.length && !done.length) return noDialog()

  if (wrote) {
    // Apply at once: read the file again, let the running session's ledger follow it, and refresh the status line.
    try {
      loaded = undefined
      const { l, session } = await current($)
      await persist($, l, decide(l.config, session, { type: 'config', now: now(), errors: l.errors }).session)
    } catch (err) {
      notes.push(`The new entries could not be applied to this session (${scrub(home, message(err))}). They apply from the next session start.`)
      wrote = false
    }
    // The skill listing is its own step: when it fails the entries are still applied.
    if (wrote) await safe($, 'installed', undefined, () => refreshInstalled($))
  }

  if (only !== undefined) {
    const problems = done.filter((d) => /Stopped|skipped|Nothing was written|not changed|already a skill/.test(d))
    return setUp.length ? [...setUp, ...problems].join('\n') : 'Souffleur: nothing set up; /souffleur init asks again.'
  }
  const out = ['Souffleur init', '', ...(toAsk.length || done.length ? done.map((d) => `- ${d}`) : ['- Nothing to ask: no skill is configured yet and none looks worth watching.'])]
  const project = plans.filter((p) => p.source === 'project')
  if (project.length) out.push('', `Set only in the project file, so init leaves ${project.length === 1 ? 'it' : 'them'} alone: ${project.map((p) => p.skill).join(', ')}.`)
  if (unwatched.length) out.push('', `Installed and not watched: ${unwatched.slice(0, 30).join(', ')}${unwatched.length > 30 ? `, and ${unwatched.length - 30} more` : ''}.`)
  const sure = hooks.filter((o) => !isGuess(o)).length
  const guessed = hooks.length - sure
  if (sure || guessed || passages.length) {
    const found = [plural(sure, 'hook'), plural(passages.length, 'passage')].join(' and ')
    out.push('', `Found ${found} that look like old setup${guessed ? `, and ${guessed} more guessed from script names` : ''}. /souffleur migrate goes through them with you.`)
  }
  if (notes.length) out.push('', 'Notes:', ...notes.map((n) => `- ${n}`))
  if (wrote) out.push('', 'New entries apply to this session now. The default mode is observe: nothing is blocked until you set "mode": "enforce" in the user file.')
  return out.join('\n')
}

/**
 * `/souffleur migrate`: goes through hooks in settings.json that do what Souffleur does, one dialog each.
 * `Turn off` copies settings.json first (never over an older copy) and removes only that entry, and only when the
 * file is still what the edit was based on. Scripts, CLAUDE.md and memory are never edited.
 */
async function runMigrate($: Dollar, l: Loaded): Promise<string> {
  const notes: string[] = []
  const home: string | undefined = await homeOf($)
  const dir = await userDir($)
  if (!home || !dir) return 'Souffleur migrate: the home folder is unknown, so nothing was changed.'
  const settingsPath = `${dir}/settings.json`
  const shown = (path: string) => shownPath(home, path)
  const settings = await readSettings($, settingsPath, home)
  if (settings.error) return `Souffleur migrate: ${settings.error}, so nothing was changed.`

  const files = await readStanding($, l, home, dir, notes)
  const configured = Object.keys(l.config.skills)
  // Only skills of the user file count as watched: a project file's entry works in that project alone.
  const watched = Object.entries(l.config.skills).filter(([, r]) => r.from === 'user').map(([name]) => name)
  const installed = await installedSkills($)
  const hooks: HookOverlap[] = findHookOverlaps(settings.value, configured, installed.filter((n) => !configured.includes(n)))
  const passages: Passage[] = findPassages(files, configured, Infinity)
  const known = { configured, installedOnly: installed.filter((n) => !configured.includes(n)) }

  const { queued: queuedNotes, skipped } = await queuePassages($, passages, new Set(files.filter((f) => f.project).map((f) => f.file)))
  if (queuedNotes.length) notes.push(`${plural(queuedNotes.length, 'passage')} queued as note proposals. /souffleur review asks about them one by one; nothing is written before you say yes.`)
  if (skipped) notes.push(`${passages.length - queuedNotes.length} skipped (${skipped}).`)
  const { session } = await current($)
  for (const o of hooks) {
    for (const name of o.skills ?? []) {
      const note = `${name} is configured but not installed in this session, so Souffleur cannot keep it loaded here. Check before turning the hook off.`
      if (watched.includes(name) && session.ledger[name]?.state === 'not installed here' && !notes.includes(note)) notes.push(note)
    }
  }
  const noDialog = () => withNotes(migrateSteps({ hooks, passages, settingsPath: shown(settingsPath), watched }), notes)
  const done: string[] = []
  const manual: string[] = []
  const label = (o: HookOverlap) => `${o.event} hook ${o.command}`
  let asked = false
  let backedUp = false
  let expected = settings.text // what settings.json should hold; anything else means it changed under us
  try {
    for (const [i, o] of hooks.entries()) {
      const q = hookQuestion(o, watched)
      const question = `${asked ? '' : `${MIGRATE_INTRO}\n\n`}${q.text}`
      const answer: unknown = await $.ui.ask(question, { options: q.options, header: 'Souffleur' })
      asked = true
      if (typeof answer !== 'string' || answer === '' || answer === 'Stop') {
        done.push(`Stopped at the ${label(o)}; ${plural(hooks.length - i, 'hook')} not asked.`)
        break
      }
      if (answer === 'Keep') done.push(`Kept the ${label(o)}.`)
      if (answer === 'Show me what to do') {
        manual.push(hookSteps(o, shown(settingsPath)))
        done.push(`Left the ${label(o)} alone; the steps are below.`)
      }
      if (answer !== 'Turn off') continue
      // Read again: an earlier removal moved the indexes, and the file may have changed since the scan.
      const text: string = await $.fs.read(settingsPath)
      if (expected !== undefined && text !== expected) {
        done.push(`Stopped: ${shown(settingsPath)} changed since it was read. Nothing more was written. Run /souffleur migrate again.`)
        break
      }
      const current: unknown = parseJson(text)
      const target = findHookOverlaps(current, known.configured, known.installedOnly).find((x) => x.event === o.event && x.matcher === o.matcher && x.command === o.command)
      if (!target) {
        done.push(`Already gone: the ${label(o)}.`)
        continue
      }
      if (!backedUp) {
        const backup = await freeBackupPath($, settingsPath)
        try {
          await $.fs.write(backup, text)
        } catch (err) {
          done.push(`Stopped: the backup could not be written (${scrub(home, message(err))}), so ${shown(settingsPath)} was not changed.`)
          break
        }
        backedUp = true
        done.push(`Copied settings to ${shown(backup)}.`)
      }
      const again: string = await $.fs.read(settingsPath)
      if (again !== text) {
        done.push(`Stopped: ${shown(settingsPath)} changed since it was read. Nothing more was written. Run /souffleur migrate again.`)
        break
      }
      const next = `${JSON.stringify(removeHook(current, target), null, 2)}\n`
      await $.fs.write(settingsPath, next)
      expected = next
      done.push(`Turned off the ${label(o)}.`)
    }
  } catch (err) {
    if (!asked) return noDialog()
    done.push(`Stopped early: ${scrub(home, message(err))}.`)
  }
  if (!asked && hooks.length && !done.length) return noDialog()

  const out = [MIGRATE_INTRO, '', ...(hooks.length || done.length ? done.map((d) => `- ${d}`) : ['- Nothing to migrate: no overlapping hooks.'])]
  if (manual.length) out.push('', 'To do by hand:', ...manual.map((m) => `- ${m}`))
  if (passages.length) out.push('', 'Standing instructions that name a configured skill (Souffleur never edits these):', ...passageLines(passages))
  if (notes.length) out.push('', 'Notes:', ...notes.map((n) => `- ${n}`))
  return out.join('\n')
}

// --- Rules, notes and proposals ---

/** The fields `souffleur_propose` takes; anything else on the call is not part of a proposal. */
const PROPOSE_FIELDS = ['kind', 'text', 'need', 'before', 'skill', 'field', 'after', 'evidence']
const PROPOSE_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['rule', 'note'] },
    source: { type: 'string', enum: ['slip', 'user'], description: '"user" when the user asked for it, "slip" when something went wrong that this would have caught.' },
    text: { type: 'string', description: 'For a note: the instruction, one line.' },
    need: { type: 'string', description: 'For a note: a configured need name, when it only matters for that kind of work.' },
    before: { type: 'object', description: 'For a rule that checks a call: { tools: ["Agent"], paths?: ["src/**"] }. Use with skill or field.' },
    skill: { type: 'string', description: 'The skill that must be loaded before a matching call.' },
    field: { type: 'string', description: 'The argument a matching call must carry, for example model.' },
    after: { type: 'object', description: 'For a rule about what must follow a call: { tools: ["Edit"], paths?: ["src/**"] }. Use with evidence.' },
    evidence: { type: 'object', description: 'What closes an "after" rule: { tool: "Bash", command?: "npm test" } (command is a glob).' },
  },
  required: ['kind'],
}

const REGISTER_PROPOSE = {
  name: 'souffleur_propose',
  description:
    'Propose a note or a rule for Souffleur to keep. Call it only for a standing instruction of the user that holds beyond the current task (a note), or when something went wrong that a checkable rule would have caught: a skill loaded before a call, a field a call carries, or evidence that follows a call (a rule). Never for facts about one task, issue or file. Souffleur asks the user before anything is kept; never write the entry into a file yourself.',
  inputSchema: PROPOSE_SCHEMA,
}

/** The session with the declined hashes of earlier sessions added (they live in the plugin store). */
async function withStoredDeclined($: Dollar, s: Session): Promise<Session> {
  try {
    const stored: unknown = await $.store.get(DECLINED_KEY)
    if (!Array.isArray(stored)) return s
    const extra = stored.filter((h): h is string => typeof h === 'string' && !s.declined.includes(h))
    return extra.length ? { ...s, declined: [...s.declined, ...extra] } : s
  } catch {
    return s
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const BLOCK_NAME = /^[A-Za-z0-9:_-]{1,64}$/
let backedUp = false

/** What a `change` returns to stop an edit: the text is the answer, and nothing is written. */
class Refusal {
  readonly text: string
  constructor(text: string) {
    this.text = text
  }
}
type EditFailure = { ok: false; kind: 'home' | 'read' | 'missing' | 'json' | 'problem' | 'refused' | 'changed' | 'write'; detail: string; text: string }
type Edited = { ok: true; wrote: boolean } | EditFailure
const EDIT_TRIES = 3
const BACKUPS_KEPT = 3
const same = (a: unknown, b: unknown) => Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b)

const USER_LOCK_STALE_MS = 30_000
const USER_LOCK_WAIT_MS = 3000
const USER_LOCK_RETRY_MS = 100
/** Edits of the user file in this process run one after the other: each waits for the one before it. */
let editQueue: Promise<unknown> = Promise.resolve()

/**
 * The one way the user file is written. Edits in this process run one at a time, and across sessions the read-modify-move holds the lock
 * `<plugin data>/user-file.lock`. `change` is synchronous and must not call `editUserFile` itself: it would wait for its own edit.
 */
function editUserFile(
  $: Dollar,
  change: (doc: unknown) => unknown,
  opts: { missing?: 'allow' | 'refuse' } = {},
): Promise<Edited> {
  const run = editQueue.then(() => editUserFileLocked($, change, opts))
  editQueue = run.catch(() => undefined)
  return run
}

/**
 * Takes the user file lock, retrying every 100 ms until 3 s have passed on the wall clock, and edits under it. Only when the very first try finds
 * that no lock can be made at all (no `mkdir`, no data folder) does it edit without one; on a later try the same error counts as a held lock.
 */
async function editUserFileLocked($: Dollar, change: (doc: unknown) => unknown, opts: { missing?: 'allow' | 'refuse' }): Promise<Edited> {
  let entered = false
  const edit = () => {
    entered = true
    return editUserFileOnce($, change, opts)
  }
  const start = await wallNow($)
  // The attempt cap bounds the loop even when the clock does not move.
  for (let first = true, tries = 0; tries <= USER_LOCK_WAIT_MS / USER_LOCK_RETRY_MS; first = false, tries++) {
    try {
      const got = await withLock($, 'user-file.lock', 'user file lock', USER_LOCK_STALE_MS, edit)
      if (got) return got.value
    } catch (err) {
      if (entered) throw err
      if (first) {
        $.ui.log(`user file lock unavailable, editing without it: ${message(err)}`, { to: 'debug' })
        return editUserFileOnce($, change, opts)
      }
    }
    if ((await wallNow($)) - start >= USER_LOCK_WAIT_MS) break
    try {
      await $.clock.sleep(USER_LOCK_RETRY_MS)
    } catch {
      break
    }
  }
  const home: string | undefined = await homeOf($)
  const uc = await userConfig($)
  const shown = home && uc ? shownPath(home, uc.path) : 'the user file'
  return { ok: false, kind: 'write', detail: 'locked', text: `could not write ${shown} (another session holds the lock on it), so nothing was written` }
}

/** The write itself: `<file>.tmp-<time>-<random>` (its own name per write), parsed back, then moved over the file. */
async function editUserFileOnce(
  $: Dollar,
  change: (doc: unknown) => unknown,
  opts: { missing?: 'allow' | 'refuse' },
): Promise<Edited> {
  const home: string | undefined = await homeOf($)
  const uc = await userConfig($)
  const fail = (kind: EditFailure['kind'], detail: string, text: string): EditFailure => ({ ok: false, kind, detail, text })
  if (!home || !uc) return fail('home', '', 'the home folder is unknown, so nothing was written')
  const path = uc.path
  // A symlinked config is written through: the copy goes next to, and over, what the link leads to.
  const target = (await $.fs.stat(path, { resolve: true }).catch(() => undefined))?.realPath ?? path
  const tmp = `${target}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const shown = shownPath(home, path)
  const dropTmp = () => $.process.run(['rm', '-f', tmp], { timeoutMs: 10_000 }).catch(() => undefined)
  for (let attempt = 0; attempt < EDIT_TRIES; attempt++) {
    const st = await readState($, path, home)
    if (st.kind === 'error') return fail('read', st.why, `could not read ${shown} (${st.why}), so nothing was written`)
    if (st.kind === 'missing' && opts.missing !== 'allow') return fail('missing', '', 'there is no user file, so nothing was written')
    let doc: unknown
    if (st.kind === 'ok') {
      try {
        doc = parseJson(st.text)
      } catch (err) {
        const why = scrub(home, message(err))
        return fail('json', why, `${shown} is not valid JSON (${why}), so nothing was written`)
      }
      const problem = configProblem(doc)
      if (problem) return fail('problem', problem, `${shown} cannot be edited because ${problem}, so nothing was written`)
    }
    const next = change(doc)
    if (next instanceof Refusal) return fail('refused', next.text, next.text)
    if (same(next, doc)) return { ok: true, wrote: false }
    const after = configProblem(next)
    if (after) return fail('problem', after, `${shown} would not be a usable config because ${after}, so nothing was written`)
    const text = `${JSON.stringify(next, null, 2)}\n`
    try {
      await $.fs.write(tmp, text)
      const back: string = await $.fs.read(tmp)
      parseJson(back)
      if (back !== text) throw new Error('the temp copy does not read back as written')
    } catch (err) {
      await dropTmp()
      const why = scrub(home, message(err))
      return fail('write', why, `could not write ${shown} (${why})`)
    }
    // Read once more right before the move: another session or the user may have saved the file since. Then apply the change to what is there now.
    const again = await readState($, path, home)
    if (again.kind !== st.kind || (again.kind === 'ok' && st.kind === 'ok' && again.text !== st.text)) {
      await dropTmp()
      continue
    }
    try {
      if (!backedUp && st.kind === 'ok') {
        await $.fs.write(`${path}.bak-${Date.now()}`, st.text)
        backedUp = true
      }
      const moved = await $.process.run(['mv', '-f', tmp, target], { timeoutMs: 10_000 })
      if (moved.exitCode !== 0) throw new Error(`mv exited ${moved.exitCode}${moved.stderr ? `: ${moved.stderr.trim()}` : ''}`)
    } catch (err) {
      await dropTmp()
      const why = scrub(home, message(err))
      return fail('write', why, `could not write ${shown} (${why})`)
    }
    loaded = undefined // the next event reads the new file
    await pruneBackups($, dirOf(path))
    return { ok: true, wrote: true }
  }
  return fail('changed', '', `${shown} kept changing while it was written, so nothing was written`)
}

const USER_BACKUP = /^souffleur\.json\.bak-(\d{13})$/
/** Keeps the newest `BACKUPS_KEPT` copies named `souffleur.json.bak-<13-digit ms>`; any other suffix is somebody's own copy and stays. */
async function pruneBackups($: Dollar, dir: string): Promise<void> {
  try {
    const stamps = (await $.fs.list(dir)).flatMap((f: { name: string }) => {
      const m = USER_BACKUP.exec(f.name)
      return m ? [{ name: f.name, at: Number(m[1]) }] : []
    })
    const old = stamps.sort((a, b) => b.at - a.at).slice(BACKUPS_KEPT)
    if (old.length) await $.process.run(['rm', '-f', ...old.map((f) => `${dir}/${f.name}`)], { timeoutMs: 10_000 })
  } catch {
    // an old copy left behind costs disk space only
  }
}

/** The cheap fingerprint of a config file: changes when it is saved, by anyone. */
async function fileSig($: Dollar, path: string): Promise<string> {
  try {
    const st = await $.fs.stat(path)
    return `${st.mtimeMs}:${st.size}`
  } catch {
    return 'none'
  }
}
/** The user file and the repository file together. */
async function configSig($: Dollar, root: string): Promise<string> {
  const uc = await userConfig($)
  return `${uc ? await fileSig($, uc.path) : 'none'}|${await fileSig($, `${root}/.claude/souffleur.json`)}`
}

/**
 * `/souffleur block <name>` and `unblock <name>`: edits `projects[<this root>].block` in the user file through `editUserFile`
 * (read fresh, retried on a concurrent save, atomic, one backup per process).
 */
async function runBlock($: Dollar, l0: Loaded, verb: 'block' | 'unblock', name: string): Promise<string> {
  const home: string | undefined = await homeOf($)
  const uc = await userConfig($)
  if (!home || !uc) return 'Souffleur: the home folder is unknown, so nothing was written.'
  if (name === '') return `Souffleur: usage /souffleur ${verb} <skill, note or rule name>.`
  if (!BLOCK_NAME.test(name) || name === '__proto__') return `Souffleur: ${JSON.stringify(name.slice(0, 80))} is not a valid name.`
  const path = uc.path
  const root = normRoot(l0.root)
  if (!/^(\/|[A-Za-z]:[\\/])/.test(root)) return 'Souffleur: the project root is unknown, so nothing was written.'
  const projectText = await readOptional($, `${l0.root}/.claude/souffleur.json`, [], home)
  const e = await editUserFile($, (doc) => {
    const refuse = (text: string) => new Refusal(`Souffleur: ${text}`)
    const base = doc as Record<string, unknown>
    if (base.projects !== undefined && !isRecord(base.projects)) return refuse(`"projects" in ${shownPath(home, path)} is not an object, so nothing was written.`)
    const projects: Record<string, unknown> = { ...(base.projects as Record<string, unknown> | undefined) }
    const key = Object.keys(projects).find((k) => normRoot(k) === root) ?? root
    if (projects[key] !== undefined && !isRecord(projects[key])) return refuse(`the block for ${root} in ${shownPath(home, path)} is not an object, so nothing was written.`)
    const block: Record<string, unknown> = { ...(projects[key] as Record<string, unknown> | undefined) }
    if (block.block !== undefined && !(Array.isArray(block.block) && block.block.every((n) => typeof n === 'string'))) return refuse(`"block" for ${root} is not a list of names, so nothing was written.`)
    const names: string[] = [...((block.block as string[] | undefined) ?? [])]
    const std = standardNames(parseConfig(JSON.stringify(doc), projectText === undefined ? undefined : stripBom(projectText)).config)
    if (!std.has(name) && !names.includes(name)) return refuse(`${name} is not in your standard or this project's block.`)
    if (verb === 'block') {
      if (names.includes(name)) return refuse(`${name} is already blocked in ${root}.`)
      if (names.length >= MAX_LIST) return refuse(`the block of ${root} already has ${MAX_LIST} names, so nothing was written.`)
      if (!(Object.hasOwn(projects, key)) && Object.keys(projects).length >= MAX_PROJECT_ROOTS) return refuse(`at most ${MAX_PROJECT_ROOTS} project blocks are read, so nothing was written.`)
      names.push(name)
      block.block = names
    } else {
      if (!names.includes(name)) return refuse(`${name} is not blocked in ${root}.`)
      const left = names.filter((n) => n !== name)
      if (left.length) block.block = left
      else delete block.block
    }
    if (Object.keys(block).length) projects[key] = block
    else delete projects[key]
    const next: Record<string, unknown> = { ...base }
    if (Object.keys(projects).length) next.projects = projects
    else delete next.projects
    return next
  })
  if (!e.ok) {
    if (e.kind === 'missing') return `Souffleur: there is no ${await shownUserFile($)} yet, so there is no standard to block in. Run /souffleur init.`
    return e.kind === 'refused' ? e.text : `Souffleur: ${e.text}.`
  }
  await apply($, (l) => ({ type: 'config', now: now(), errors: l.errors }))
  return verb === 'block' ? `Souffleur: ${name} blocked in ${root}; other projects keep it.` : `Souffleur: ${name} unblocked in ${root}; the standard applies here again.`
}

/** Every skill name, note id and rule id of a config (the standard when it was read without a root). */
function standardNames(c: Config): Set<string> {
  return new Set([...Object.keys(c.skills), ...c.notes.map((n) => n.id), ...c.rules.map((r) => r.id)])
}

/** `/souffleur project`: what applies here, as a few short lines. Empty lines are left out. */
async function runProject($: Dollar, l: Loaded): Promise<string> {
  const home: string | undefined = await homeOf($)
  const uc = await userConfig($)
  const st = home && uc ? await readState($, uc.path, home) : ({ kind: 'missing' } as FileState)
  const std = parseConfig(st.kind === 'ok' ? stripBom(st.text) : undefined, undefined).config
  const c = l.config
  const root = normRoot(l.root)
  const p = c.project
  const own = new Set(p?.own ?? [])
  const known = standardNames(std)
  const blocked = (p?.blocked ?? []).map((n) => (known.has(n) ? n : `${n} (not in standard)`))
  for (const r of std.rules) if (r.skill !== undefined && (p?.blockedSkills ?? []).includes(r.skill) && !(p?.blocked ?? []).includes(r.id)) blocked.push(`rule ${r.id} (its skill ${r.skill} is blocked)`)
  const here = (where: string | undefined) => where === undefined || normRoot(where) === root
  const userSkills = Object.entries(c.skills).filter(([n, r]) => r.from === 'user' && !own.has(n))
  const offSkills = userSkills.filter(([, r]) => excludedIn(r, root)).map(([n]) => n)
  const notes = c.notes.filter((n) => !own.has(n.id))
  const rules = c.rules.filter((r) => !own.has(r.id))
  const off = [...offSkills, ...notes.filter((n) => !here(n.where)).map((n) => n.id), ...rules.filter((r) => !here(r.where)).map((r) => r.id)]
  const mine = [...(p?.own ?? [])].map((n) => `${Object.hasOwn(c.skills, n) ? 'skill' : c.notes.some((x) => x.id === n) ? 'note' : 'rule'} ${n}`)
  const repo = Object.entries(c.skills).filter(([, r]) => r.from === 'project').map(([n]) => n)
  const lines = [`Souffleur: project ${root}`]
  if (blocked.length) lines.push(`Blocked here: ${blocked.join(', ')}`)
  if (mine.length) lines.push(`This project only: ${mine.join(', ')}`)
  if (off.length) lines.push(`Off here by notIn/where: ${off.join(', ')}`)
  lines.push(`Standard: ${userSkills.length - offSkills.length} skills, ${notes.filter((n) => here(n.where)).length} notes, ${rules.filter((r) => here(r.where)).length} rules apply here`)
  if (repo.length) lines.push(`Repository file: ${repo.join(', ')}`)
  return lines.join('\n')
}

/** The installed skills that come from the open project (`source` `projectSettings`), when the listing is complete. */
async function projectInstalled($: Dollar): Promise<string[]> {
  try {
    const skills = (await $.session.usage({ breakdown: 'summary' }))?.context?.breakdown?.skills
    const listed: { name: string; source?: string }[] | undefined = skills?.skillFrontmatter
    if (!skills || !listed?.length) return []
    if (typeof skills.totalSkills === 'number' && typeof skills.includedSkills === 'number' && skills.includedSkills < skills.totalSkills) return []
    return [...new Set(listed.filter((x) => x.source === 'projectSettings' || x.source === 'project').map((x) => x.name))]
  } catch {
    return []
  }
}

const OWN_NOW = 'Set up now'
const OWN_IGNORE = 'Ignore all here'
const OWN_LATER = 'Later'

/**
 * At the first turn end of a session in a repository whose root has no block yet: one dialog about the installed project skills
 * that nothing names. `Set up now` runs init's round for them, `Ignore all here` writes them to `ignored`, anything else
 * (`Later`, a dismissal, a timeout, no dialog) writes nothing and sets no stop, so the next session asks again.
 * Where no dialog opens, one notice names the count.
 */
async function askOwnSkills($: Dollar, dialog: boolean): Promise<void> {
  if (sess.ownHandled) return
  const { l, session } = await current($)
  if (session.paused || session.proposals.length || !l.setUp) return
  let repo: unknown
  try {
    repo = await $.session.repo()
  } catch {
    return
  }
  if (!repo) return
  sess.ownHandled = true
  const token = ++sess.ownToken
  sess.ownActed = false
  sess.pendingSetUp = undefined
  const home: string | undefined = await homeOf($)
  const uc = await userConfig($)
  if (!home || !uc) return
  const st = await readState($, uc.path, home)
  if (st.kind !== 'ok') return
  let doc: unknown
  try {
    doc = parseJson(st.text)
  } catch {
    return
  }
  if (configProblem(doc) || hasProjectKey(doc, l.root)) return
  const names = (await projectInstalled($)).filter((n) => !(Object.hasOwn(l.config.skills, n)))
  if (!names.length) return
  const notice = () => void say($, l, `Souffleur: this project has ${names.length} skills not in your config. /souffleur init asks about them.`)
  if (!dialog) return notice()
  // The app cuts a long question, so the full list goes to the chat first.
  const listed = names.slice(0, MAX_NAMES_LINE).join(', ') + (names.length > MAX_NAMES_LINE ? ` and ${names.length - MAX_NAMES_LINE} more` : '')
  say($, l, `Souffleur: skills in this project not in your config: ${listed}`)
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ', …' : '')
  const question = `This project has ${names.length} skill${names.length === 1 ? '' : 's'} not in your config: ${shown}. Set ${names.length === 1 ? 'it' : 'them'} up now?`
  let answer: unknown
  const asking = Promise.resolve().then(() => $.ui.ask(question, { options: [OWN_NOW, OWN_IGNORE, OWN_LATER], header: 'Souffleur' }))
  try {
    asking.catch(() => undefined) // a late rejection after a timeout is nobody's business
    answer = await Promise.race([asking, $.clock.sleep(ASK_WAIT_MS).then(() => Promise.reject(new TimedOut()))])
  } catch (err) {
    if (err instanceof TimedOut) {
      // The dialog stays open: a tap after the limit still counts while the root has no block.
      asking.then((late) => lateOwnAnswer($, l, names, late, token), () => undefined)
      return
    }
    // Dismissed: ask again next session. Nobody can answer: say so once.
    if (!DISMISSED.test(message(err))) notice()
    return
  }
  await actOnOwnAnswer($, l, names, answer)
}

/** The names line shows at most this many names. */
const MAX_NAMES_LINE = 40

/** `Set up now` runs init's round for the names, `Ignore all here` writes them to `ignored`; anything else does nothing. */
async function actOnOwnAnswer($: Dollar, l: Loaded, names: string[], answer: unknown): Promise<void> {
  if (answer === OWN_NOW) {
    sess.ownActed = true
    say($, l, await runInit($, l, names))
    return
  }
  if (answer !== OWN_IGNORE) return
  sess.ownActed = true
  const kept = names.slice(0, MAX_LIST)
  const r = await editUserFile($, (d) => {
    let config: unknown = d
    for (const name of kept) config = ignoreInProject(config, l.root, name).config
    return config
  })
  if (!r.ok) say($, l, `Souffleur: ${r.text}.`)
  else {
    if (r.wrote) await apply($, (l1) => ({ type: 'config', now: now(), errors: l1.errors }))
    say($, l, `Souffleur: ${kept.length} skill${kept.length === 1 ? '' : 's'} ignored in this project.`)
    if (names.length > kept.length) say($, l, `Souffleur: the ignored list of this project holds ${MAX_LIST} names; ${names.length - kept.length} skills stay unasked. /souffleur init asks about them.`)
  }
}

/** An answer after the two-minute limit: acts only for the current question, once, while the root still has no block. */
async function lateOwnAnswer($: Dollar, l: Loaded, names: string[], answer: unknown, token: number): Promise<void> {
  if (token !== sess.ownToken || sess.ownActed || (answer !== OWN_NOW && answer !== OWN_IGNORE)) return
  try {
    if ((await current($)).session.paused) {
      say($, l, 'Souffleur: Souffleur is paused; /souffleur init sets them up later.')
      return
    }
    const left = await stillUnnamed($, l, names)
    if (!left.length) return
    if (answer === OWN_NOW) {
      if (sess.askStopped || sess.noDialog) {
        say($, l, 'Souffleur: run /souffleur init in this project to set them up.')
        return
      }
      sess.pendingSetUp = { token, names: left }
      say($, l, 'Souffleur: set-up starts at the next turn end.')
      return
    }
    await actOnOwnAnswer($, l, left, answer)
  } catch (err) {
    say($, l, `Souffleur: could not act on your answer (${message(err)}). /souffleur init asks again.`)
  }
}

/** The names that the freshly read user file still does not name, or none when the root has a block by now. */
async function stillUnnamed($: Dollar, l: Loaded, names: string[]): Promise<string[]> {
  const home: string | undefined = await homeOf($)
  const uc = await userConfig($)
  if (!home || !uc) return []
  const st = await readState($, uc.path, home)
  if (st.kind !== 'ok') return []
  const doc = parseJson(st.text)
  if (configProblem(doc) || hasProjectKey(doc, l.root)) return []
  // The effective config (user file and trusted repository file), read fresh like the in-time path.
  loaded = undefined
  const fresh = (await current($)).l
  return names.filter((n) => !(Object.hasOwn(fresh.config.skills, n)))
}

/** At a turn end: runs the set-up a late `Set up now` asked for, if it still applies. True when it ran. */
async function runPendingSetUp($: Dollar): Promise<boolean> {
  const p = sess.pendingSetUp
  sess.pendingSetUp = undefined
  if (!p) return false
  const { l } = await current($)
  try {
    const left = await stillUnnamed($, l, p.names)
    if (!left.length) return false
    sess.ownActed = true
    say($, l, await runInit($, l, left))
  } catch (err) {
    say($, l, `Souffleur: could not act on your answer (${message(err)}). /souffleur init asks again.`)
  }
  return true
}

/**
 * Adds one entry to the user file through `editUserFile`: write only now (the caller has the user's yes), keep every other key. Returns the user-facing line.
 */
async function writeEntry($: Dollar, kind: 'rule' | 'note', entry: Rule | Note, project?: string): Promise<{ ok: boolean; text: string; wrote?: boolean }> {
  let keep = false
  const e = await editUserFile($, (doc) => {
    const r = addEntry(doc, kind, entry, project)
    keep = r.keep === true
    return r.note ? new Refusal(r.note) : r.config
  }, { missing: 'allow' })
  if (!e.ok) return { ok: e.kind === 'refused' && !keep, text: e.text }
  const home: string | undefined = await homeOf($)
  const uc = await userConfig($)
  return { ok: true, wrote: true, text: `added ${kind} ${entry.id} to ${shownPath(home, uc?.path ?? '~/.claude/souffleur.json')}${project === undefined ? '' : ` for ${project}`}` }
}

/** The session after a change the core has no event for: read, change, store. */
function update($: Dollar, change: (l: Loaded, s: Session) => Session): Promise<void> {
  return serial(async () => {
    const { l, session } = await current($)
    const next = change(l, await withStoredDeclined($, session))
    await persist($, l, next)
    await settle($, l, session, next)
  })
}

/** The person declined a proposal or dismissed a dialog (never a failure or a timeout): kept in the session, so a reload does not forget it. */
async function markStopped($: Dollar, flags: { proposals?: boolean; ask?: boolean }): Promise<void> {
  if (flags.ask) sess.askStopped = true
  await update($, (_l, s) => ({ ...s, ...(flags.proposals ? { proposalsStopped: true } : {}), ...(flags.ask ? { askStopped: true } : {}) }))
}

/** A prompt of the person ends the offer a notice made. Without an answer the proposal just stays queued: no stop. */
function endOffer(): void {
  sess.shownHash = undefined
}

/** Applies the user's answer to one waiting proposal: writes after a yes, remembers a no, keeps the proposal when the write fails. */
function commitAnswer($: Dollar, hash: string, label: string): Promise<string> {
  return serial(() => commitAnswerNow($, hash, label))
}

async function commitAnswerNow($: Dollar, hash: string, label: string): Promise<string> {
  const { l, session: before } = await current($)
  const session = await withStoredDeclined($, before)
  const r = answer(l.config, session, hash, label, l.root)
  if (r.note) return r.note
  if (r.write) {
    let w: { ok: boolean; text: string; wrote?: boolean }
    try {
      w = await writeEntry($, r.write.kind, r.write.entry, r.write.project)
    } catch (err) {
      w = { ok: false, text: `writing failed (${scrub(await homeOf($), message(err))}), so nothing was written` }
    }
    if (!w.ok) {
      await persist($, l, session)
      return `Souffleur: ${w.text}. The proposal stays queued.`
    }
    loaded = undefined // the file changed: read it again
    const l2 = await getLoaded($)
    await persist($, l2, decide(l2.config, r.session, { type: 'config', now: now(), errors: l2.errors }).session)
    await flushCopy($, l2)
    await markVersionDone($, session, r.session, hash)
    // The file is what counts: confirm that the reader kept the entry before saying it is there.
    const kept = [...l2.config.rules, ...l2.config.notes].some((x) => x.id === r.write!.entry.id)
    if (w.wrote && !kept) {
      const why = l2.errors.filter((m) => m.startsWith('user config') || m.startsWith('projects[')).slice(-2).join('; ')
      return `Souffleur: wrote ${r.write.entry.id} to the file, but the reader did not keep it${why ? ` (${why})` : ''}. Check ${await shownUserFile($)}.`
    }
    return `Souffleur: ${w.text}.`
  }
  await persist($, l, label === NO ? { ...r.session, proposalsStopped: true } : r.session)
  await flushCopy($, l)
  await markVersionDone($, session, r.session, hash)
  if (label === NO) {
    try {
      await $.store.set(DECLINED_KEY, r.session.declined.slice(-200))
    } catch {
      // the decline holds for this session even when the store fails
    }
    return 'Souffleur: not added, and it will not be proposed again.'
  }
  return r.revise === undefined ? 'Souffleur: nothing changed.' : 'Souffleur: the model is asked to revise it with your next prompt.'
}

/** Shows the first waiting proposal that no notice showed yet. A reply may answer only what was written to the transcript, so the offer is armed only then. */
function noticeFirst($: Dollar, l: Loaded, session: Session): void {
  const p = session.proposals.find((x) => !sess.noticed.has(x.hash))
  // A session that takes no person prompt (`claude -p`) cannot be answered by a reply word: name the command.
  const form = !interactive && lastPromptKind === 'sdk' ? 'command' : 'reply'
  if (p === undefined || !say($, l, proposalNotice(p, form))) return
  sess.shownHash = p.hash
  sess.noticed.add(p.hash)
}

/** One dialog about the first waiting proposal. Returns the line to show, or undefined when nothing was asked or the dialog gave no answer. */
async function askFirst($: Dollar, atTurnEnd = false): Promise<string | undefined> {
  const { l, session } = await current($)
  // A proposal whose dialog timed out (at a turn end or in a typed command) is not asked again while that dialog is still open.
  const waiting = await withStoredDeclined($, session)
  const q = nextQuestion({ ...waiting, proposals: waiting.proposals.filter((p) => !sess.timedOutAsk.has(p.hash)) })
  if (!q) return undefined
  if (!interactive && lastPromptKind === 'sdk') {
    // Nobody can answer a dialog in a headless run (Remote Control also reports not interactive, but its prompts are a person's), and a client that never answers would hold the turn end for two minutes per proposal.
    if (atTurnEnd) {
      sess.noDialog = true
      sess.askStopped = true
      noticeFirst($, l, session)
    }
    return undefined
  }
  let label: unknown
  const asking = Promise.resolve().then(() => $.ui.ask(q.question, { options: q.options, header: 'Souffleur' }))
  try {
    // A client that shows no dialog may never answer: after two minutes the turn end falls back to a notice and a typed command returns.
    label = await Promise.race([asking, $.clock.sleep(ASK_WAIT_MS).then(() => Promise.reject(new TimedOut()))])
  } catch (err) {
    if (err instanceof TimedOut) {
      // Only this proposal falls back. The dialog stays open: a later tap still counts while the proposal waits.
      sess.timedOutAsk.add(q.hash)
      asking.then((late) => lateAnswer($, q.hash, late), () => undefined).finally(() => sess.timedOutAsk.delete(q.hash))
      // A typed command answers for itself: no notice, no stop.
      if (!atTurnEnd) return ASK_TIMEOUT_LINE
      noticeFirst($, l, session)
    } else if (DISMISSED.test(message(err))) {
      // The person closed the dialog: a skip. Nothing more is asked at turn end, and the model proposes no more.
      await markStopped($, { proposals: true, ...(atTurnEnd ? { ask: true } : {}) })
    } else if (atTurnEnd) {
      // A rejection that is no dismissal is not kept: show the proposal once and let a one-word reply answer it.
      // Only this process knows it: a session resumed in a client that can open a dialog asks again, and no stop is set.
      sess.noDialog = true
      sess.askStopped = true
      noticeFirst($, l, session)
    } else {
      // A dialog in a typed command that cannot open: the turn-end question still comes.
      sess.askAtTurnEnd = true
    }
    return undefined
  }
  if (typeof label !== 'string' || label.trim() === '') {
    // A dismissed dialog is a skip: nothing more is asked at turn end, and the model proposes no more.
    await markStopped($, { proposals: true, ...(atTurnEnd ? { ask: true } : {}) })
    return undefined
  }
  return commitAnswer($, q.hash, label)
}

class TimedOut extends Error {}
/** What a typed command returns when its dialog stayed open for `ASK_WAIT_MS`. */
const ASK_TIMEOUT_LINE = 'Souffleur: no answer within two minutes; the proposal stays queued. A late tap in the dialog still counts.'
/** How the mod kit words the rejection of a dialog the person closed: `$.ui.ask: no answer (the dialog was dismissed)`. */
const DISMISSED = /dismissed/i

/** A dialog answered after its timeout: counts only while the proposal still waits (a reply may have answered it first). */
async function lateAnswer($: Dollar, hash: string, label: unknown): Promise<void> {
  if (typeof label !== 'string' || label.trim() === '') return
  try {
    const { session } = await current($)
    if (session.paused || !session.proposals.some((p) => p.hash === hash)) return
    if (sess.shownHash === hash) sess.shownHash = undefined
    sess.askAtTurnEnd = true
    const line = await commitAnswer($, hash, label)
    try {
      $.ui.toast(line)
    } catch {
      // a toast is a courtesy
    }
  } catch {
    // a late answer that cannot be applied leaves the proposal queued
  }
}

/**
 * The person's one-word reply to the proposal a notice showed. Returns the context line for the model, or undefined when
 * the prompt answers nothing. The shown proposal is forgotten by the first prompt of the person, whatever it says.
 */
async function answerShown($: Dollar, text: string): Promise<string | undefined> {
  const hash = sess.shownHash
  sess.shownHash = undefined
  const verdict = parseReply(text)
  if (hash === undefined || verdict === undefined) return undefined
  const { l, session } = await current($)
  const p = session.paused ? undefined : session.proposals.find((x) => x.hash === hash)
  if (!p) return undefined
  const id = p.entry.id
  // By the full hash: the short id may name another waiting proposal.
  try {
    const line = await commitAnswer($, hash, verdict === 'accept' ? YES_EVERYWHERE : NO)
    sess.askAtTurnEnd = true // the next waiting proposal gets its question or notice at the next turn end
    try {
      $.ui.toast(line)
    } catch {
      say($, l, line)
    }
    const { l: l3, session: after } = await current($)
    const active = [...l3.config.rules, ...l3.config.notes].some((x) => x.id === id)
    if (verdict === 'accept' && !after.proposals.some((x) => x.hash === hash) && !active) return `Souffleur: the user accepted proposal ${id}, but the reader did not keep the entry; it is not active. Tell the user to check ${await shownUserFile($)}.`
    if (after.proposals.some((x) => x.hash === hash)) return `Souffleur: the user tried to ${verdict} proposal ${id}, but it could not be written; it stays queued. Do not retry it.`
    return `Souffleur: the user ${verdict === 'accept' ? 'accepted' : 'declined'} proposal ${id}; nothing else to do for it.`
  } catch {
    // Something failed during or after the write; the model must not assume either outcome.
    return `Souffleur: the answer may not have been written; check ${await shownUserFile($)} or /souffleur.`
  }
}

/** Queues a proposal. `from` is `slip` or `user`. */
async function propose($: Dollar, raw: unknown, from: string): Promise<{ status: string; id?: string }> {
  const { l } = await current($)
  const made = makeProposal(raw, from, l.config)
  if (!made.proposal) return { status: `error: ${made.error}` }
  let status = 'queued'
  await update($, (l2, s) => {
    if (s.proposed.length >= MODEL_PROPOSALS) {
      status = 'capped'
      return s
    }
    const r = enqueue(l2.config, s, made.proposal!)
    status = r.status
    return r.status === 'queued' ? { ...r.session, proposed: [...r.session.proposed, made.proposal!.hash] } : r.session
  })
  return { status, id: made.proposal.entry.id }
}

// --- Learning from skill texts ---

const READ_TIMEOUT_MS = 30_000

type LearnAction = Extract<Action, { kind: 'learn' }>

/**
 * Reads one skill with the small model and queues what it finds. Runs after the hook has answered, so the hook never
 * waits for the model, and every failure ends here. The version is marked done in the plugin store only after its
 * proposals were queued; a call that fails, gets no answer or gives an unusable one counts a failure for that version
 * (three end the tries) and gives the session its read back; a full queue leaves the version unmarked, so a later load tries again.
 */
async function learnFrom($: Dollar, a: LearnAction): Promise<void> {
  if (!interactive) return
  let hash: string | undefined
  let fails = 0
  let offers = 0
  let claimed = false
  try {
    const first = await current($)
    if (!first.l.setUp || !trusted(a.source, first.l.root, first.l.config)) return
    let fileText: string | undefined
    if (a.path !== undefined) {
      try {
        if (await $.fs.exists(a.path)) fileText = (await $.fs.read(a.path)).slice(0, MAX_SKILL_TEXT)
      } catch {
        // without the file the computed text stands in
      }
    }
    const text = fileText ?? a.text
    hash = skillHash(a.skill, text)
    if (sess.reading.has(hash)) {
      hash = undefined
      return
    }
    sess.reading.add(hash)
    const key = hashKey(hash)
    const l = await serial(async () => {
      const { l, session } = await current($)
      const stored = await $.store.get(key)
      await refreshStamp($, key, stored)
      // A version whose proposals still wait in this session is not read again.
      if (!l.setUp || !interactive || session.proposals.some((p) => p.skillHash === hash) || !shouldRead(session, l.config, stored)) return undefined
      const count = (name: 'fails' | 'offers') => (typeof stored === 'object' && stored !== null && typeof (stored as Record<string, unknown>)[name] === 'number' ? (stored as Record<string, number>)[name]! : 0)
      fails = count('fails')
      offers = count('offers')
      await persist($, l, { ...session, skillReads: (session.skillReads ?? 0) + 1 })
      return l
    })
    if (l === undefined) return
    claimed = true
    const nonce = Math.random().toString(36).slice(2, 10)
    const r = await callModel($, { model: 'haiku', system: EXTRACT_SYSTEM, prompt: extractPrompt(a.skill, text, nonce), maxTokens: 1500, timeoutMs: READ_TIMEOUT_MS })
    const origin = { name: a.skill, ...(a.source === undefined ? {} : { source: a.source }), ...(a.pluginName === undefined ? {} : { pluginName: a.pluginName }) }
    const found = r.isAnswered ? parseAnswer(r.text, origin, l.config, text) : undefined
    if (found === undefined) throw new Error('no usable answer')
    claimed = false
    await apply($, () => ({ type: 'learned', now: now(), ok: true }))
    let full = false
    const queued: string[] = []
    if (found.length > 0) {
      const version = hash
      await update($, (l2, s) => {
        const next = found.reduce((acc, p) => {
          const q = enqueue(l2.config, acc, { ...p, skillHash: version })
          if (q.status === 'full') full = true
          else if (q.status === 'queued') queued.push(p.hash)
          return q.session
        }, s)
        // A queue that was full cannot answer for the whole version: its proposals do not mark it done.
        return full ? { ...next, proposals: next.proposals.map((p) => (queued.includes(p.hash) ? withoutSkillHash(p) : p)) } : next
      })
    }
    // Done when nothing is left to ask; otherwise the version counts as offered, and done only once its proposals are answered.
    if (!full) await $.store.set(key, queued.length === 0 ? { done: true, touched: now() } : { offers: offers + 1, touched: now() })
  } catch {
    if (claimed && hash !== undefined) {
      try {
        await apply($, () => ({ type: 'learned', now: now(), ok: false }))
        await serial(async () => {
          const { l, session } = await current($)
          await persist($, l, { ...session, skillReads: Math.max(0, (session.skillReads ?? 0) - 1) })
          await $.store.set(hashKey(hash!), { fails: fails + 1, touched: now() })
        })
      } catch {
        // the version stays as it was
      }
    }
  } finally {
    if (hash !== undefined) sess.reading.delete(hash)
  }
}

const withoutSkillHash = ({ skillHash: _gone, ...rest }: Proposal): Proposal => rest

/** After an answer: the skill version the answered proposal came from is done once none of its proposals waits any more. */
async function markVersionDone($: Dollar, before: Session, after: Session, hash: string): Promise<void> {
  const version = before.proposals.find((q) => q.hash === hash)?.skillHash
  if (version === undefined || after.proposals.some((q) => q.skillHash === version)) return
  try {
    await $.store.set(hashKey(version), { done: true, touched: now() })
  } catch {
    // the version stays offered and is read again next time, within the cap
  }
}

/** A hash record in use keeps its age rule from running out: its stamp moves up when it is read, at most once a day. */
async function refreshStamp($: Dollar, key: string, stored: unknown): Promise<void> {
  if (typeof stored !== 'object' || stored === null) return
  const touched = (stored as { touched?: unknown }).touched
  const wall = await wallNow($)
  if (typeof touched === 'number' && wall - touched < 86_400_000) return
  try {
    await $.store.set(key, { ...stored, touched: wall })
  } catch {
    // the stamp stays; a failed refresh only means the age rule counts from the older one
  }
}

/** The model may make this many proposals per session. */
const MODEL_PROPOSALS = 5

const PROPOSE_REPLY: Record<string, string> = {
  duplicate: 'Already a rule or note, or already waiting for the user. Nothing to do.',
  declined: 'The user declined this before. Do not propose it again.',
  capped: 'You made five proposals this session already. The user reviews them with /souffleur review; make no more.',
  full: 'Twenty proposals already wait for the user. Do not propose more until /souffleur review cleared some.',
}

async function runPropose($: Dollar, input: Record<string, unknown>): Promise<string> {
  if (input.agentId !== undefined) return 'Only the main session proposes rules and notes. Tell the main session what went wrong instead.'
  if (input.kind === 'note' && input.source === 'slip') return 'Souffleur: a note comes only from a standing instruction of the user; nothing queued.'
  if ((await current($)).session.proposalsStopped === true) return 'Souffleur: the user declined or skipped a proposal in this session; do not propose more. Nothing queued.'
  const raw: Record<string, unknown> = {}
  for (const key of PROPOSE_FIELDS) if (input[key] !== undefined) raw[key] = input[key]
  const r = await propose($, raw, input.source === 'slip' ? 'slip' : 'user')
  if (r.status.startsWith('error: ')) return `Not queued: ${r.status.slice(7)}. Fix the call and try again.`
  if (r.status !== 'queued') return PROPOSE_REPLY[r.status] ?? 'Not queued.'
  return `Queued as ${r.id}. At the end of this turn Souffleur asks the user in a dialog, or shows a notice they answer with a reply; do not ask again.`
}

/** `/souffleur rule <text>`: the small model shapes the words into a rule or note; a failure keeps them as a note. */
async function runRule($: Dollar, text: string): Promise<string> {
  if (!text.trim()) return 'Usage: /souffleur rule <what to remember>'
  const { l } = await current($)
  let raw = ''
  try {
    const r = await callModel($, { model: 'haiku', prompt: shapePrompt(text, l.config.needs) })
    if (r.isAnswered) raw = r.text
  } catch {
    // the words become a note
  }
  const p = parseShaped(raw, text, l.config)
  let status = 'queued'
  await update($, (l2, s) => {
    const r = enqueue(l2.config, s, p)
    status = r.status
    return r.session
  })
  if (status !== 'queued') return status === 'duplicate' ? 'Souffleur: that is already a rule or note, or already waiting.' : status === 'declined' ? 'Souffleur: you declined this before.' : 'Souffleur: twenty proposals wait already. Run /souffleur review first.'
  const asked = await askFirst($)
  if (asked === ASK_TIMEOUT_LINE) return `${asked} Or run /souffleur accept ${p.entry.id}.`
  if (asked !== undefined) return asked
  return `Souffleur: queued ${p.kind} ${p.entry.id}: ${describeProposal(p)}. Run /souffleur review to answer, or /souffleur accept ${p.entry.id}.`
}

/** `/souffleur review`: one dialog per waiting proposal; without a dialog the list and the text commands. */
async function runReview($: Dollar): Promise<string> {
  const { session } = await current($)
  if (session.proposals.length === 0) return 'Souffleur: no proposals are waiting.'
  const done: string[] = []
  for (let i = 0; i < 20; i++) {
    const line = await askFirst($)
    if (line === undefined) break
    done.push(line)
    if (line === ASK_TIMEOUT_LINE) break
  }
  const { session: rest } = await current($)
  const out = [...done]
  if (rest.proposals.length) {
    out.push(done.length ? 'Still waiting:' : rest.proposals.some((p) => sess.timedOutAsk.has(p.hash)) ? 'Waiting for your answer; a dialog for it is still open:' : 'Waiting for your answer, and no dialog can open here:', ...proposalLines(rest), 'Add one with /souffleur accept <id> (everywhere) or /souffleur accept <id> here (this project only).')
  }
  return out.join('\n')
}

/** `/souffleur accept <id> [here|project]`: the text route for what a dialog would ask. */
async function runAccept($: Dollar, args: string[]): Promise<string> {
  const [id, scope] = args
  const usage = 'Usage: /souffleur accept <id> [here|project]'
  if (!id || args.length > 2 || (scope !== undefined && scope !== 'here' && scope !== 'project')) return usage
  const { session } = await current($)
  const p = findProposal(session, id)
  if (!p) return `Souffleur: no proposal ${id} is waiting.${session.proposals.length ? ` Waiting: ${session.proposals.map((q) => q.entry.id).join(', ')}.` : ''}`
  return commitAnswer($, p.hash, scope === undefined ? YES_EVERYWHERE : YES_PROJECT)
}

/** `/souffleur decline <id>`: the text route for No; the hash is remembered. */
async function runDecline($: Dollar, args: string[]): Promise<string> {
  const [id] = args
  if (!id || args.length > 1) return 'Usage: /souffleur decline <id>'
  const { session } = await current($)
  const p = findProposal(session, id)
  if (!p) return `Souffleur: no proposal ${id} is waiting.`
  return commitAnswer($, p.hash, NO)
}

const SKIP_WORDS: Record<string, string> = { short: 'too short', invalid: 'not valid as a note', duplicate: 'already known or waiting', declined: 'declined before', full: 'queue full' }

/** Standing instructions `migrate` found become note proposals with their file and line. Returns the ids queued and why the rest were skipped. */
async function queuePassages($: Dollar, passages: Passage[], projectFiles: Set<string>): Promise<{ queued: string[]; skipped: string }> {
  const queued: string[] = []
  const counts: Record<string, number> = {}
  const skip = (why: string) => void (counts[why] = (counts[why] ?? 0) + 1)
  if (!passages.length) return { queued, skipped: '' }
  await update($, (l, s) => {
    let next = s
    for (const p of passages) {
      const text = p.text.replace(/^[\s>#*\-\d.]+/, '').trim()
      if (text.length < 8) {
        skip('short')
        continue
      }
      const made = makeProposal({ kind: 'note', text }, 'user', l.config)
      if (!made.proposal) {
        skip('invalid')
        continue
      }
      const r = enqueue(l.config, next, { ...made.proposal, origin: `${p.file}:${p.line}`, project: projectFiles.has(p.file) })
      if (r.status === 'queued') queued.push(made.proposal.entry.id)
      else skip(r.status)
      next = r.session
    }
    return next
  })
  const skipped = Object.entries(counts).map(([why, n]) => `${n} ${SKIP_WORDS[why] ?? why}`).join(', ')
  return { queued, skipped }
}

/** The own tool showed in `$.tool.list()` at least once in this process (the list may never show it). */
let toolSeen = false
/** The silent retry for a tool the list never showed has been spent. */
let silentRetried = false

/**
 * The propose tool's server can drop between turns while the hooks go on. Missing after it was seen: register again and
 * say so. Missing and never seen: the list may not show our own tool, so try once, silently.
 */
async function reconnectTool($: Dollar): Promise<void> {
  let listed: unknown
  try {
    listed = await Promise.race([$.tool.list(), $.clock.sleep(LIST_BUDGET_MS).then(() => undefined)])
  } catch {
    return
  }
  if (!Array.isArray(listed)) return
  if (listed.some((t) => t?.name === PROPOSE_TOOL)) {
    toolSeen = true
    return
  }
  if (!toolSeen && silentRetried) return
  const announce = toolSeen
  toolSeen = false
  silentRetried = true
  try {
    await $.tool.register(REGISTER_PROPOSE)
  } catch {
    proposeReady = false
    return
  }
  proposeReady = true
  if (announce) say($, await getLoaded($), 'Souffleur: tool reconnected.')
}

let lastBand: string | undefined // last band draw logged in this process, so the debug log skips repeats

export const register: Register = (on) => {
  // On the terminal the status line says the same; any other surface gets one row while something needs attention.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const b = e.surface === 'terminal' || e.props.hasSurvey ? null : await read($, band)
    const key = `band: surface=${e.surface} shown=${b ? 'true' : 'false'}`
    if (key !== lastBand) {
      lastBand = key
      $.ui.log(key, { to: 'debug' })
    }
    if (!b) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    return h(Box, null, h(Text, { wrap: 'truncate' }, b.text)) as RenderElement
  })

  on('session.start', async ($, e, next) => {
    await syncClock($)
    resetSessionState() // before anything that can throw: a failed start must not leave the last session's state behind
    await safe($, 'session.start', undefined, async () => {
      loaded = undefined
      lastBand = undefined
      backedUp = false // a session start is a fresh run: the first change saves a new backup
      const l = await getLoaded($)
      const id: string = await $.session.id()
      sessFor = id
      const version = (await $.session.version()).version
      const held: Session | undefined = (await $.state.get(REF)).value
      const stored = held?.id === id ? undefined : await $.store.get(`session:${id}`)
      const before = held?.id === id ? held : isSession(stored, id) ? stored : undefined
      let s: Session
      if (before) {
        // Resume or reload: the ledger stays, what the config said last time does not.
        s = await resumedSession($, l, before, held?.id === id ? 'reload' : 'resume')
      } else {
        s = await freshSession($, l, id, 'startup')
        toldKey = '' // a new session has told nothing yet
      }
      // Problems that hold at the start are news once; a resumed session's stored `noticed` keeps them from repeating.
      const first = notices(l.config, s, s, l.root)
      s = first.session
      // A newer release found earlier is shown once per session (the mark survives reload and resume).
      const found = l.config.update === 'off' ? undefined : (await readCheck($))?.latest // refreshes the cache
      const tell = found !== undefined && compareVersions(found.slice(1), PLUGIN_VERSION) === 1 && s.updateShown !== found ? found : undefined
      const kind = tell === undefined ? undefined : await cachedKind($)
      await persist($, l, s, true)
      await flushCopy($, l)
      say($, l, startNotice(l.config, s, l.setUp, PLUGIN_VERSION))
      for (const line of first.lines) say($, l, line)
      let said = false
      if (tell !== undefined && kind !== undefined && (l.config.update === 'notify' || kind === 'market')) {
        said = say($, l, updateLine(kind === 'folder' ? 'notify' : 'notify-market', tell, PLUGIN_VERSION))
        if (said) toldKey = `${s.id}:${tell}`
        if (said) await markShown($, tell)
      }
      // Neither the first-run line nor the check may hold the session start: both run detached.
      void (async () => {
        try {
          if (l.config.update === 'off') return
          const k = await installKind($)
          await $.store.set(KIND_KEY, k)
          if (tell !== undefined && !said && (l.config.update === 'notify' || k === 'market') && latest?.updateShown !== tell && toldKey !== `${s.id}:${tell}`) {
            if (say($, l, updateLine(k === 'folder' ? 'notify' : 'notify-market', tell, PLUGIN_VERSION))) {
              toldKey = `${s.id}:${tell}`
              await markShown($, tell)
            }
          }
          await checkForUpdate($, l, await wallNow($))
          if (l.config.update === 'auto' && k === 'folder') await autoInstall($, l, s.id)
        } finally {
          $.ui.log('update work done', { to: 'debug' })
        }
      })().catch(() => {})
    })
    const pruneId = await $.session.id()
    // Not awaited: a store with thousands of keys must not hold the session start.
    void pruneStore($, pruneId).catch((err) => {
      try {
        $.ui.log(`store pruning failed: ${message(err)}`, { to: 'debug' })
      } catch {
        // a log line is a courtesy
      }
    })
    await safe($, 'installed', undefined, () => refreshInstalled($))
    await safe($, 'command.register', undefined, async () => {
      await $.command.register({ name: 'souffleur', description: 'Show which skills Souffleur keeps loaded', argumentHint: '[status | need <name> | drop <name> | pause | resume | init | migrate | rule <text> | review | accept <id> | decline <id> | block <name> | unblock <name> | project | update]' })
    })
    interactive = e.isInteractive === true
    lastPromptKind = undefined
    lastPromptCommand = false
    personTurn = false
    proposeReady = false
    toolSeen = false
    silentRetried = false
    try {
      await $.tool.register(REGISTER_PROPOSE)
      proposeReady = true
    } catch {
      // The tool does not reach the model: the system prompt leaves out the sentence about it, and /souffleur rule stays.
    }
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    await syncClock($)
    await safe($, 'skill.prompt', undefined, async () => {
      const { actions } = await apply($, () => ({ type: 'skill', now: now(), skill: e.skill, text: e.text, ...(e.source === undefined ? {} : { source: e.source }), ...(e.pluginName === undefined ? {} : { pluginName: e.pluginName }), ...(e.path === undefined ? {} : { path: e.path }) }))
      for (const a of actions) if (a.kind === 'learn') void learnFrom($, a)
    })
    return next(e)
  })

  // The last chance to store the copy a resume reads: the turn may have ended without a turn.complete (exit, signal, -p).
  on('session.end', async ($, e, next) => {
    await syncClock($)
    try {
      await serial(async () => {
        // After a reload `latest` is unset: the held state or the stored copy is the session to keep.
        if (latest) await flushCopy($, await getLoaded($))
        else {
          const { l, session } = await current($)
          await flushCopy($, l, session)
        }
      })
    } catch (err) {
      $.ui.log(`store copy at session end failed: ${message(err)}`, { to: 'debug' })
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    await syncClock($)
    const agentId = e.agentId === undefined ? {} : { agentId: e.agentId }
    await safe($, 'session.compact.before', undefined, async () => {
      await apply($, () => ({ type: 'compact', now: now(), phase: 'before', trigger: e.trigger, ...agentId }))
    })
    // The engine always sends the messages; the test kit's compaction call sends none, and next() refuses that.
    const r = await next(Array.isArray(e.messages) ? e : { ...e, messages: [{ role: 'user' as const, text: '', toolUses: [] }] })
    await safe($, 'session.compact.after', undefined, async () => {
      const skipped = 'skip' in r && r.skip !== undefined
      await apply($, () => ({ type: 'compact', now: now(), phase: 'after', trigger: e.trigger, skipped, ...agentId }))
    })
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    await syncClock($)
    const fromUser = isFromUser(e)
    if (fromUser) lastPromptKind = e.origin?.kind
    personTurn = fromUser || (e.command !== undefined && isUserOrigin(e))
    lastPromptCommand = e.command !== undefined
    // A hand edit or another session's save: read the files again before this prompt is judged.
    await safe($, 'config.reload', undefined, async () => {
      if (!loaded || (await configSig($, loaded.root)) === loadedSig) return
      loaded = undefined
      await apply($, (l) => ({ type: 'config', now: now(), errors: l.errors }))
    })
    // An end event can be lost (a failed update, a reload that kept the state): the engine's own list names the runs that are over.
    // A run the list never names (a workflow's agent) stays live. No run to check, or a list that does not answer in time: nothing is pruned.
    await safe($, 'agent.prune', undefined, async () => {
      const { session } = await current($)
      const checkable = (session.liveAgents ?? []).some((id) => !id.startsWith(SPAWN_PREFIX))
      let ended: string[] = []
      if (checkable) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
          const list = await Promise.race([
            $.agent.list() as Promise<{ id: string; status: string }[]>,
            new Promise<undefined>((resolve) => {
              timer = setTimeout(() => resolve(undefined), 2000)
            }),
          ])
          if (list !== undefined) ended = list.filter((a) => ['completed', 'failed', 'killed'].includes(a.status)).map((a) => a.id)
        } catch {
          // no list: no run is pruned, old placeholders still age out below
        } finally {
          clearTimeout(timer)
        }
      }
      await apply($, () => ({ type: 'agentsEnded', now: now(), ids: ended }))
    })
    if (fromUser) await safe($, 'tool.reconnect', undefined, () => reconnectTool($))
    // Only a prompt of the person (composer or bridge, no command) answers; any prompt of the person ends the offer.
    if (e.command !== undefined && isUserOrigin(e)) endOffer()
    let answered: string | undefined
    if (fromUser) {
      if (e.origin?.kind === 'composer' || e.origin?.kind === 'bridge') answered = await safe($, 'prompt.reply', undefined as string | undefined, () => answerShown($, e.text))
      else endOffer()
    }
    const texts = await safe($, 'prompt.submit', [] as string[], async () => {
      const { l, session } = await current($)
      const { config } = l
      // A need only the project file defines counts for a trusted root alone; nothing is classified while paused.
      const trusted = isTrustedRoot(config, l.root)
      const needs = Object.fromEntries(Object.entries(config.needs).filter(([name]) => trusted || !(config.projectNeeds ?? []).includes(name)))
      const wanted = fromUser && answered === undefined && !session.paused && Object.keys(needs).length > 0
      // After repeated failures of call A the classifier pauses for a number of prompts.
      const breaker = wanted && (session.classifyPause ?? 0) > 0
      const classify = wanted && !breaker
      // After repeated failures of call B alone, B is skipped for a number of the prompts A calls code work.
      const workBreaker = (session.workPause ?? 0) > 0
      // The skill listing runs beside the classification and gives up after its own short budget.
      const listing = fromUser ? safe($, 'installed', undefined, () => refreshInstalled($)) : undefined
      const verdict = classify
        ? await classifyDeliverable(
            e.text,
            needs,
            async (text, labels, timeoutMs) => {
              const r = await callModel($, { model: 'haiku', system: CLASSIFIER_SYSTEM, prompt: `Labels: ${labels.join(', ')}\n\nText:\n${text}`, maxTokens: 10, timeoutMs })
              return r.isAnswered ? r.text : ''
            },
            (ms) => $.clock.sleep(ms),
            undefined,
            undefined,
            { workCheck: config.workCheck ?? 'parallel', skipWork: workBreaker },
          )
        : undefined
      await listing
      const { actions } = await apply($, (l2) => ({ type: 'prompt', now: now(), text: e.text, fromUser, ...(!fromUser && startsTurn(e) ? { startsTurn: true } : {}), matched: verdict?.matched ?? [], root: l2.root, ...(breaker ? { classifierSkipped: true } : {}), ...(verdict === undefined ? {} : { classifierFailed: verdict.failed }), ...(verdict?.kind === undefined ? {} : { deliverable: verdict.kind }), ...(verdict?.kind === 'code-or-repo-work' && workBreaker && Object.values(needs).some((n) => n.for === 'work') ? { workSkipped: true } : verdict?.bFailure !== undefined ? { workFailed: true } : verdict?.kind === 'code-or-repo-work' ? { workFailed: false } : {}) }))
      const classifierLine = verdict?.failure !== undefined ? `classifier: ${verdict.failure}` : verdict?.bFailure !== undefined ? `classifier B: ${verdict.bFailure}` : undefined
      if (classifierLine !== undefined) {
        try {
          $.ui.log(classifierLine, { to: 'debug' })
        } catch {
          // a debug line is a courtesy
        }
      }
      for (const a of actions) {
        if (a.kind !== 'debug') continue
        try {
          $.ui.log(a.text, { to: 'debug' })
        } catch {
          // a debug line is a courtesy; the restore context below must still reach the model
        }
      }
      return actions.flatMap((a) => (a.kind === 'context' ? [a.text] : []))
    })
    if (answered !== undefined) texts.push(answered)
    return texts.length ? next({ ...e, context: [...(e.context ?? []), ...texts] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    await syncClock($)
    const r = await next(e)
    const text = await safe($, 'prompt.compose', undefined as string | undefined, async () => {
      const { l, session } = await current($)
      const chat = Object.entries(l.config.skills)
        .filter(([name, rule]) => rule.always === true && audienceOf(l.config, name) === 'chat' && session.ledger[name]?.state !== 'not installed here' && !excludedIn(rule, l.root) && (rule.from === 'user' || isTrustedRoot(l.config, l.root)))
        .map(([name]) => name)
      const always = Object.entries(l.config.skills)
        .filter(([name, rule]) => rule.always === true && audienceOf(l.config, name) !== 'chat' && session.ledger[name]?.state !== 'not installed here' && !excludedIn(rule, l.root) && (rule.from === 'user' || isTrustedRoot(l.config, l.root)))
        .map(([name]) => name)
      const notes = sectionNotes(l.config, l.root).text
      return `${RULE} Each skill applies only to the output named with it.${chat.length ? ` Replies in this chat follow ${chat.join(', ')}; a skill for other readers or for product users never changes how you reply here.` : ''}${always.length ? ` Always-on skills: ${always.join(', ')}.` : ''}${proposeReady && l.setUp ? PROPOSE_SENTENCE : ''}${notes ? `\n\n${notes}` : ''}`
    })
    return text === undefined ? r : { ...r, sections: [...r.sections, { id: 'souffleur', scope: 'session' as const, text }] }
  })

  on('tool.call', async ($, e, next) => {
    await syncClock($)
    const actions = await safe($, 'tool.call', [] as Action[], async () => {
      const fields = toolFields(e)
      const r = await apply($, (l) => ({
        type: 'tool',
        now: now(),
        tool: e.tool,
        ...fields,
        present: presentArgs(e),
        ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
        root: l.root,
        tree: l.tree,
      }))
      return r.actions
    })
    const deny = actions.find((a) => a.kind === 'deny')
    if (deny) return { deny: deny.reason }
    const r = await next(e)
    const extra = actions.flatMap((a) => (a.kind === 'toolContext' ? [a.text] : []))
    if (!extra.length || r.deny !== undefined) return r
    return { ...r, context: [...(r.context ?? []), ...extra] }
  }).catch(($, e, next) => next(e))

  on('tool.run', { tool: PROPOSE_TOOL }, async ($, e) => {
    await syncClock($)
    const text = await safe($, 'souffleur_propose', 'Souffleur could not queue the proposal. Tell the user and carry on.', () => runPropose($, e as unknown as Record<string, unknown>))
    return { result: text }
  }).catch(() => ({ result: 'Souffleur could not queue the proposal. Tell the user and carry on.' }))

  // The agent's `skills` are preloaded before its first turn and `turn.start` fires only before its first model call, so a
  // placeholder holds the window of the spawn; the agent's id replaces it once the result names it.
  let spawnSeq = 0
  on('agent.spawn', async ($, e, next) => {
    await syncClock($)
    const token = `${SPAWN_PREFIX}${now()}:${++spawnSeq}`
    await safe($, 'agent.spawn', undefined, async () => {
      await apply($, () => ({ type: 'agentStart', now: now(), agentId: token }))
    })
    try {
      const r = await next(e)
      const agentId = (r as { agentId?: string }).agentId
      if (agentId !== undefined) {
        await safe($, 'agent.spawn', undefined, async () => {
          await apply($, () => ({ type: 'agentStart', now: now(), agentId }))
        })
      }
      return r
    } finally {
      await safe($, 'agent.spawn', undefined, async () => {
        await apply($, () => ({ type: 'agentDone', now: now(), agentId: token }))
      })
    }
  })

  // A live agent run is what tells a skill load of the main session from an agent's: `skill.prompt` has no agentId, and a
  // background agent's Agent call returns at launch. A run starts with its `turn.start` and ends with its `turn.complete` or `agent.report`.
  on('turn.start', async ($, e, next) => {
    await syncClock($)
    const r = await next(e)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await safe($, 'turn.start', undefined, async () => {
        await apply($, () => ({ type: 'agentStart', now: now(), agentId }))
      })
    }
    return r
  })

  on('agent.report', async ($, e, next) => {
    await syncClock($)
    const r = await next(e)
    await safe($, 'agent.report', undefined, async () => {
      await apply($, () => ({ type: 'agentDone', now: now(), agentId: e.agentId }))
    })
    return r
  })

  // At the end of a turn: one question about the first waiting proposal; where no dialog opens, a notice with a reply hint.
  on('turn.complete', async ($, e, next) => {
    await syncClock($)
    const r = await next(e)
    if (e.agentId !== undefined) {
      const agentId = e.agentId
      await safe($, 'turn.agentDone', undefined, async () => {
        await apply($, () => ({ type: 'agentDone', now: now(), agentId }))
      })
    }
    // The main loop is alive: stamp the time the status line shows. A subagent's turn end says nothing about the session.
    if (e.agentId === undefined) {
      await safe($, 'turn.seen', undefined, async () => {
        await apply($, () => ({ type: 'seen', now: now() }))
      })
    }
    if (e.agentId === undefined && e.reason === 'answer' && personTurn && typeof e.answer === 'string') {
      await safe($, 'turn.reply', undefined, async () => {
        await apply($, (l) => ({ type: 'reply', now: now(), answer: e.answer, fromCommand: lastPromptCommand, aborted: e.isAborted, root: l.root }))
      })
      // One check per person prompt: a later turn without its own prompt (a background completion) is not the person's.
      personTurn = false
    }
    if (e.agentId === undefined && e.reason === 'answer' && (!sess.askStopped || sess.askAtTurnEnd || sess.noDialog)) {
      await safe($, 'turn.complete', undefined, async () => {
        if ((await current($)).session.paused) return
        // While an offer is armed no person prompt has ended it yet: a new notice would redirect the reply, and a new
        // dialog would add one more open question. The offer stays until a prompt of the person ends it.
        if (sess.shownHash !== undefined) return
        sess.askAtTurnEnd = false
        if (sess.pendingSetUp && !sess.noDialog && (await runPendingSetUp($))) return
        if (sess.noDialog) {
          // A dialog was tried and nobody can answer: no new attempt, only a notice for a proposal not shown yet.
          const { l, session } = await current($)
          noticeFirst($, l, session)
          if (!session.proposals.length) await askOwnSkills($, false)
          return
        }
        const hadProposals = (await current($)).session.proposals.length > 0
        const line = await askFirst($, true)
        if (!hadProposals && line === undefined && !sess.noDialog && !sess.askStopped) await askOwnSkills($, interactive || lastPromptKind !== 'sdk')
        if (line !== undefined) {
          try {
            $.ui.toast(line)
          } catch {
            // a toast is a courtesy
          }
        }
      })
    }
    return r
  })

  on('command.run', async ($, e, next) => {
    await syncClock($)
    if (e.command === 'souffleur') {
      const verb0 = (e.args ?? '').trim().split(/\s+/)[0]
      // Only a read-only status is open to a plugin or the model; every other verb changes state or opens a dialog.
      if (verb0 !== '' && verb0 !== 'status' && !isUserOrigin(e)) return { text: `Souffleur: only the user can run /souffleur ${verb0}; a plugin or the model cannot.` }
      if (verb0 === 'init' || verb0 === 'migrate') {
        const text = await safe($, `command.run.${verb0}`, undefined as string | undefined, async () => {
          loaded = undefined // read the files again: another session may have changed them
          if (verb0 === 'init') sess.pendingSetUp = undefined // init asks about these names itself
          const { l } = await current($)
          return verb0 === 'init' ? runInit($, l) : runMigrate($, l)
        })
        if (text !== undefined) return { text }
        return next(e)
      }
      if (verb0 === 'block' || verb0 === 'unblock' || verb0 === 'project') {
        const rest = (e.args ?? '').trim().slice(verb0.length).trim()
        const text = await safe($, `command.run.${verb0}`, undefined as string | undefined, async () => {
          loaded = undefined
          const { l } = await current($)
          return verb0 === 'project' ? runProject($, l) : runBlock($, l, verb0, rest)
        })
        if (text !== undefined) return { text }
        return next(e)
      }
      if (verb0 === 'update') {
        const text = await safe($, 'command.run.update', undefined as string | undefined, async () => {
          loaded = undefined
          const { l } = await current($)
          return runUpdate($, l)
        })
        if (text !== undefined) return { text }
        return next(e)
      }
      if (verb0 === 'rule' || verb0 === 'review' || verb0 === 'accept' || verb0 === 'decline') {
        const rest = (e.args ?? '').trim().slice(verb0.length).trim()
        const text = await safe($, `command.run.${verb0}`, undefined as string | undefined, async () => {
          loaded = undefined
          return verb0 === 'rule' ? runRule($, rest) : verb0 === 'review' ? runReview($) : verb0 === 'accept' ? runAccept($, rest.split(/\s+/).filter(Boolean)) : runDecline($, rest.split(/\s+/).filter(Boolean))
        })
        if (text !== undefined) return { text }
        return next(e)
      }
      const reply = await safe($, 'command.run', undefined as string | undefined, async () => {
        // Read the files again, so a hand edit applies at once.
        loaded = undefined
        await apply($, (l0) => ({ type: 'config', now: now(), errors: l0.errors }))
        const total = await readTotal($)
        const update = await updateInfo($)
        const { actions, l } = await apply($, (l0) => ({ type: 'command', now: now(), args: e.args ?? '', root: l0.root, update, ...(total === undefined ? {} : { total }) }))
        let text = actions.flatMap((a) => (a.kind === 'reply' ? [a.text] : []))[0]
        const verb = (e.args ?? '').trim().split(/\s+/)[0] ?? ''
        const note = `\n\nSouffleur is not set up: there is no ${await shownUserFile($)}. Run /souffleur init to add one.`
        const table = verb === '' || verb === 'status'
        if (text !== undefined && table && l.legacy !== undefined && legacyTold !== (await $.session.id())) {
          legacyTold = await $.session.id()
          const cfgDir = shownPath(await homeOf($), l.legacy)
          text = `${text}\n${legacyLine(cfgDir)}`
        }
        return text !== undefined && !l.setUp && table ? `${text}${note}` : text
      })
      if (reply !== undefined) return { text: reply }
      return next(e)
    }
    await safe($, 'command.typed', undefined, async () => {
      await apply($, () => ({ type: 'typed', now: now(), name: e.command }))
    })
    return next(e)
  }).catch(($, e, next) => next(e))
}
