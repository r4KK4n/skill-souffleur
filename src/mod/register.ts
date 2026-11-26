import type { Register } from 'claude-code'
import { MAX_LIST, MAX_PROJECT_ROOTS, excludedIn, isTrustedRoot, normRoot, parseConfig } from '../core/config.ts'
import { decide, initSession, normalizeSession } from '../core/decide.ts'
import { MIGRATE_INTRO, describeHook, findHookOverlaps, findPassages, hookQuestion, hookSteps, isGuess, migrateSteps, passageLines, removeHook } from '../core/migrate.ts'
import type { HookOverlap, Passage } from '../core/migrate.ts'
import { CHOICE_LABEL, INJECTED_HELP, addSkillToProject, hasProjectKey, ignoreInProject, NOT_SET_UP, SETUP_INTRO, applyChoice, candidates, choiceOf, cleanNeedText, configProblem, currentChoice, describePlan, explicitOnly, injectedWarning, needKeyFor, options, parsePicks, parseSkips, picksPrompt, setupSteps } from '../core/setup.ts'
import type { LoadChoice, NeedText, Plan, StartHooks, Suggestion } from '../core/setup.ts'
import type { Action, CoreEvent, Session } from '../core/decide.ts'
import { audienceOf, classifyDeliverable, needTexts } from '../core/needs.ts'
import { EXTRACT_SYSTEM, MAX_SKILL_TEXT, extractPrompt, hashKey, parseAnswer, shouldRead, skillHash, trusted } from '../core/learn.ts'
import type { Proposal } from '../core/proposals.ts'
import { NO, YES_EVERYWHERE, YES_PROJECT, addEntry, answer, describeProposal, enqueue, findProposal, makeProposal, nextQuestion, parseReply, parseShaped, proposalLines, proposalNotice, shapePrompt } from '../core/proposals.ts'
import { ruleSkillNames, sectionNotes } from '../core/rules.ts'
import { statusLine } from '../core/status.ts'
import type { Config, Note, Rule } from '../core/types.ts'
import { notices, startNotice } from '../core/notices.ts'
import { PLUGIN_VERSION } from './version.ts'
import { isFromUser, isUserOrigin, presentArgs, toolFields } from './map.ts'

// The hooks' `$` is the engine interface; the adapter calls only documented members.
type Dollar = any
/** `root` is the main repository root (what `where` names), `tree` the session's own working tree (what globs are relative to). */
type Loaded = { config: Config; errors: string[]; root: string; tree: string; cwd: string; setUp: boolean }

const REF = { plugin: 'skill-souffleur', key: 'session' } as const
const RULE =
  'Souffleur keeps track of skills in this session. If a message from Souffleur asks you to load skills, invoke each one with the Skill tool before you continue.'
const PROPOSE_SENTENCE =
  ' Call the souffleur_propose tool only (a) when the user gives a standing instruction meant to hold beyond the current task, as a note, or (b) when something went wrong that a checkable rule would have caught (a skill loaded before a call, a field a call carries, evidence after a call), as a rule. Never for facts about one task, issue or file. Souffleur then asks the user; do not write the entry anywhere yourself.'
const PROPOSE_TOOL = 'mcp__skill-souffleur__souffleur_propose'
const DECLINED_KEY = 'souffleur:declined'

// Module variables start over on a reload; the config is read again by `session.start`, which a reload runs.
let loaded: Loaded | undefined
/** The session this process stored last, with its revision. */
let latest: Session | undefined
/** Set by `session.start`: a person is at the prompt, and the propose tool is registered. */
let interactive = false
let proposeReady = false
/** A dialog was dismissed or could not open: no more questions at turn end in this process; only a dismissal is stored in the session. */
let askStopped = false
/** The hash of the proposal a notice showed because no dialog opens; only the person's very next prompt can answer it, by one reply word. */
let shownHash: string | undefined
/** A typed `/souffleur review` could not open its dialog: the next turn end asks even after a dismissal. */
let askAtTurnEnd = false
/** `$.ui.ask` rejected in this session: nobody can answer a dialog, so waiting proposals are shown as notices. */
let noDialog = false
/** The origin kind of the last prompt of the person; under `claude -p` that is `sdk`, and no later prompt can carry a reply. */
let lastPromptKind: string | undefined
/** The last prompt of the person was a typed command: its reply is not checked against the chat skill's limits. */
let lastPromptCommand = false
/** The turn now running was started by a prompt of the person (typed or a command); background and agent notification turns are not counted. */
let personTurn = false
/** How long a dialog may stay open before it counts as a rejection (turn end) or the typed command returns without it. */
const ASK_WAIT_MS = 120_000
/** The proposals a notice showed (kept after the offer ended), so each proposal gets one notice. */
const noticed = new Set<string>()

/** Set by `session.start` from the session it restored: a reload or resume keeps a dismissed dialog dismissed. */
let restoredAskStopped = false

const now = () => Date.now()
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

const stripBom = (text: string) => text.replace(/^\uFEFF/, '')
const parseJson = (text: string): unknown => JSON.parse(stripBom(text))
const shownPath = (home: string | undefined, path: string) => (home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)
/** An error text with the home folder written as `~`. */
const scrub = (home: string | undefined, text: string) => (home ? text.split(home).join('~') : text)

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
  const home = await $.env.get('HOME')
  const root = (await $.session.repo())?.root ?? (await $.session.cwd())
  const cwd: string = await $.session.cwd()
  const userText = home ? await readOptional($, `${home}/.claude/souffleur.json`, errors, home) : undefined
  const projectText = await readOptional($, `${root}/.claude/souffleur.json`, errors, home)
  const parsed = parseConfig(userText === undefined ? undefined : stripBom(userText), projectText === undefined ? undefined : stripBom(projectText), root)
  let tree = cwd
  try {
    const copy = await $.vcs.detect({ path: cwd })
    if (copy && typeof copy.root === 'string') tree = copy.root
  } catch {
    // outside a repository, or no detection: the working directory is the tree
  }
  loaded = { config: parsed.config, errors: [...errors, ...parsed.errors], root, tree, cwd, setUp: userText !== undefined }
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
  // A different id with no session.start in between is /clear (D6).
  if (held) {
    askStopped = false // a cleared session starts without the stop, like proposalsStopped
    return { l, session: await freshSession($, l, id, 'clear') }
  }
  const stored = await $.store.get(`session:${id}`)
  if (isSession(stored, id)) return { l, session: heal(l, stored) }
  return { l, session: await freshSession($, l, id, 'startup') }
}

/** A session whose ledger lists other skills than the config (a session that missed a config change) follows the config. */
function heal(l: Loaded, held: Session): Session {
  const s = normalizeSession(held)
  const want = [...new Set([...Object.keys(l.config.skills), ...ruleSkillNames(l.config)])]
  const have = Object.keys(s.ledger)
  if (want.length === have.length && want.every((name) => name in s.ledger)) return s
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

/**
 * Stores `s0` and writes the notices for what changed since the copy this process stored last. `quiet` skips the
 * comparison (a subagent's change, a session start): another session id has no relation to the last copy either.
 */
async function persist($: Dollar, l: Loaded, s0: Session, quiet = false): Promise<void> {
  let next = s0
  let lines: string[] = []
  if (!quiet && latest && latest.id === s0.id) ({ lines, session: next } = notices(l.config, latest, s0, l.root))
  const s: Session = { ...next, rev: (next.rev ?? 0) + 1, touched: now() }
  latest = s
  for (const line of lines) say($, l, line)
  // A broken file shows as degraded; only a clean start without a user file says "not set up".
  $.ui.status(!l.setUp && !s.errors.length ? NOT_SET_UP : statusLine(s, l.config.mode, sectionNotes(l.config, l.root).leftOut.length, l.config, l.root))
  await $.state.set(REF, s)
  await $.store.set(`session:${s.id}`, s)
}

/** Stored copies of sessions not touched for this long are removed at session start. */
const SESSION_TTL_MS = 30 * 86_400_000

/**
 * Housekeeping at session start: removes `session:*` entries of the plugin store whose copy was stored more than 30 days
 * ago. A copy without a timestamp (stored before this existed) gets one now and goes after 30 days. Never touches the
 * session in use or other keys. A failure here is not an error of the session: the next start tries again.
 */
async function pruneStore($: Dollar, currentId: string): Promise<void> {
  try {
    const keys: string[] = await $.store.keys()
    for (const key of keys) {
      if (!key.startsWith('session:') || key === `session:${currentId}`) continue
      const copy: unknown = await $.store.get(key)
      const touched = typeof copy === 'object' && copy !== null ? (copy as { touched?: unknown }).touched : undefined
      if (typeof touched === 'number') {
        if (now() - touched > SESSION_TTL_MS) await $.store.delete(key)
      } else if (typeof copy === 'object' && copy !== null) await $.store.set(key, { ...copy, touched: now() })
    }
  } catch {
    // housekeeping only
  }
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
    const { l, session } = await current($)
    const event = make(l)
    const r = decide(l.config, session, event)
    // What a subagent does is not the main session's news.
    await persist($, l, r.session, 'agentId' in event && event.agentId !== undefined)
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
    if (!listed?.length) return undefined
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
async function pluginStartHooks($: Dollar, home: string, skill: string): Promise<StartHooks> {
  const plugin = skill.split(':')[0]!
  const bareName = skill.split(':').pop()!
  const names = new RegExp(`(^|[^A-Za-z0-9])${bareName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^A-Za-z0-9]|$)`)
  try {
    const listed: unknown = parseJson(await $.fs.read(`${home}/.claude/plugins/installed_plugins.json`))
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

/**
 * The standing instructions to scan: user and project CLAUDE.md, the files a CLAUDE.md imports with `@path` (one level),
 * and the memory index of the project (named after the main repository root).
 */
async function readStanding($: Dollar, l: Loaded, home: string, notes: string[]): Promise<{ file: string; text: string; project: boolean }[]> {
  const slug = l.root.replace(/[^A-Za-z0-9]/g, '-')
  const claudeMds = [...new Set([`${home}/.claude/CLAUDE.md`, `${l.root}/CLAUDE.md`, `${l.cwd}/CLAUDE.md`])]
  const files: { file: string; text: string; project: boolean }[] = []
  const seen = new Set<string>()
  for (const path of claudeMds) {
    const text = await readOptional($, path, notes, home)
    if (text === undefined) continue
    seen.add(path)
    const project = path !== `${home}/.claude/CLAUDE.md`
    files.push({ file: shownPath(home, path), text, project })
    const dir = path.slice(0, path.lastIndexOf('/'))
    for (const m of text.matchAll(/(?:^|\s)@([^\s@]+\.[A-Za-z0-9]+)/g)) {
      const ref = m[1]!
      const target = ref.startsWith('/') ? ref : ref.startsWith('~/') ? `${home}/${ref.slice(2)}` : `${dir}/${ref.replace(/^\.\//, '')}`
      if (seen.has(target)) continue
      seen.add(target)
      const imported = await readOptional($, target, notes, home)
      if (imported !== undefined) files.push({ file: shownPath(home, target), text: imported, project })
    }
  }
  const memory = `${home}/.claude/projects/${slug}/memory/MEMORY.md`
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
  const home: string | undefined = await $.env.get('HOME')
  if (!home) return 'Souffleur init: the home folder is unknown, so nothing was changed.'
  const configPath = `${home}/.claude/souffleur.json`
  const settingsPath = `${home}/.claude/settings.json`
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
  const rawKey = isRecord(userDoc) && isRecord(userDoc.projects) ? Object.keys(userDoc.projects).find((k) => normRoot(k) === normRoot(l0.root)) : undefined
  const rawBlock = rawKey === undefined ? undefined : ((userDoc as Record<string, Record<string, unknown>>).projects[rawKey])
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
  const reloadHooked = [...new Set(hooks.flatMap((o) => (o.skill !== undefined && installed.includes(o.skill) && !(o.skill in config.skills) ? [o.skill] : [])))]
  const startHooked = new Set(hooks.flatMap((o) => (o.event === 'SessionStart' && o.skill !== undefined ? [o.skill] : [])))
  const passages = only === undefined ? findPassages(await readStanding($, l0, home, notes), configured, Infinity) : []

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
      const r = await $.model.complete({ model: 'haiku', prompt: picksPrompt(pool, needTexts(config.needs)) })
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
  const ownHere = new Set((await projectInstalled($)).filter((n) => !(n in config.skills) && !skip.includes(n)))
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
  const injectedLine = async (skill: string) => injectedWarning(skill, await pluginStartHooks($, home, skill))
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

  try {
    for (const [i, p] of toAsk.entries()) {
      const prop = proposal(p)
      const lines = [
        `${describePlan(p)}.`,
        prop.fallback
          ? `No description was proposed, so "When the task needs it" would read: "${prop.need.text}" Text typed under Other replaces it.`
          : `Description for "When the task needs it": ${prop.need.text} Text typed under Other replaces it.`,
        ...(p.skill.includes(':') ? [INJECTED_HELP] : []),
        'How should Souffleur keep it?',
      ]
      const question = `${asked ? '' : `${SETUP_INTRO}\n\n`}${lines.join(' ')}`
      const answer: unknown = await $.ui.ask(question, { options: options(p.skill, p.current, p.recommended), header: 'Souffleur' })
      asked = true
      const picked = typeof answer === 'string' && answer !== '' ? choiceOf(answer) : 'stop'
      if (picked === 'stop') {
        done.push(`Stopped at ${p.skill}; ${plural(toAsk.length - i, 'skill')} not asked.`)
        break
      }
      let choice: LoadChoice
      let need: NeedText | undefined
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
      let scope: 'project' | 'everywhere' = 'everywhere'
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

      // Read again: the file may have changed since the scan, and earlier answers are already in it.
      const now2 = await readState($, configPath, home)
      if (now2.kind === 'error') {
        done.push(`Stopped: could not read ${shown(configPath)} (${now2.why}). Nothing was written for ${p.skill}.`)
        break
      }
      if (now2.kind === 'missing' && user.kind === 'ok') {
        done.push(`Stopped: ${shown(configPath)} was there at the start and is not now. Nothing was written for ${p.skill}.`)
        break
      }
      let doc: unknown
      if (now2.kind === 'ok') {
        try {
          doc = parseJson(now2.text)
        } catch (err) {
          done.push(`Stopped: ${shown(configPath)} is not valid JSON now (${message(err)}). Nothing was written for ${p.skill}.`)
          break
        }
        const problem = configProblem(doc)
        if (problem) {
          done.push(`Stopped: ${shown(configPath)} cannot be edited because ${problem}. Nothing was written for ${p.skill}.`)
          break
        }
      }
      const r =
        scope === 'everywhere'
          ? applyChoice(doc, p.skill, choice, need, projectSkills)
          : choice === 'none'
            ? ignoreInProject(doc, l0.root, p.skill)
            : addSkillToProject(doc, l0.root, p.skill, choice === 'need' ? 'need' : choice, need)
      if (r.note) done.push(r.note)
      const label = choice === 'none' ? 'not watched' : CHOICE_LABEL[choice]
      if (r.note || JSON.stringify(r.config) === JSON.stringify(doc) || (now2.kind === 'missing' && choice === 'none')) {
        if (!r.note) {
          done.push(`Kept ${p.skill}: ${label}. Nothing was written.`)
          if (choice === 'injected') {
            const line = await injectedLine(p.skill)
            if (line) done.push(line)
          }
        }
        continue
      }
      if (!backedUp && now2.kind === 'ok') {
        await $.fs.write(`${configPath}.bak-${Date.now()}`, now2.text)
        backedUp = true
      }
      await $.fs.write(configPath, `${JSON.stringify(r.config, null, 2)}\n`)
      wrote = true
      const need2 = choice === 'need' ? `for ${need?.text ?? 'its description'}` : choice === 'start' ? 'from the start' : choice === 'injected' ? 'as its plugin injects it' : ''
      setUp.push(choice === 'none' ? `${p.skill}: ${scope === 'project' ? 'ignored here' : 'not watched'}` : `${p.skill}: watched ${need2.replace(/\.$/, '')} ${scope === 'project' ? 'in this project' : 'everywhere'}`)
      loaded = undefined // the session reads the new file on its next event
      done.push(`${p.skill}: ${label}.`)
      if (choice === 'injected') {
        const line = await injectedLine(p.skill)
        if (line) done.push(line)
      }
      if (r.pruned?.length) done.push(`Removed the unused ${r.pruned.length === 1 ? 'need' : 'needs'} ${r.pruned.join(', ')}.`)
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
  const home: string | undefined = await $.env.get('HOME')
  if (!home) return 'Souffleur migrate: the home folder is unknown, so nothing was changed.'
  const settingsPath = `${home}/.claude/settings.json`
  const shown = (path: string) => shownPath(home, path)
  const settings = await readSettings($, settingsPath, home)
  if (settings.error) return `Souffleur migrate: ${settings.error}, so nothing was changed.`

  const files = await readStanding($, l, home, notes)
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

/**
 * `/souffleur block <name>` and `unblock <name>`: edits `projects[<this root>].block` in the user file.
 * Reads fresh, stops on a read error or a file that cannot be edited, keeps every other key, and saves
 * `souffleur.json.bak-<epoch ms>` before the first write of this process.
 */
async function runBlock($: Dollar, l0: Loaded, verb: 'block' | 'unblock', name: string): Promise<string> {
  const home: string | undefined = await $.env.get('HOME')
  if (!home) return 'Souffleur: the home folder is unknown, so nothing was written.'
  if (name === '') return `Souffleur: usage /souffleur ${verb} <skill, note or rule name>.`
  if (!BLOCK_NAME.test(name) || name === '__proto__') return `Souffleur: ${JSON.stringify(name.slice(0, 80))} is not a valid name.`
  const path = `${home}/.claude/souffleur.json`
  const st = await readState($, path, home)
  if (st.kind === 'error') return `Souffleur: could not read ${shownPath(home, path)} (${st.why}), so nothing was written.`
  if (st.kind === 'missing') return 'Souffleur: there is no ~/.claude/souffleur.json yet, so there is no standard to block in. Run /souffleur init.'
  let doc: unknown
  try {
    doc = parseJson(st.text)
  } catch (err) {
    return `Souffleur: ${shownPath(home, path)} is not valid JSON (${scrub(home, message(err))}), so nothing was written.`
  }
  const problem = configProblem(doc)
  if (problem) return `Souffleur: ${shownPath(home, path)} cannot be edited because ${problem}, so nothing was written.`
  const root = normRoot(l0.root)
  if (!/^(\/|[A-Za-z]:[\\/])/.test(root)) return 'Souffleur: the project root is unknown, so nothing was written.'
  const base = doc as Record<string, unknown>
  if (base.projects !== undefined && !isRecord(base.projects)) return `Souffleur: "projects" in ${shownPath(home, path)} is not an object, so nothing was written.`
  const projects: Record<string, unknown> = { ...(base.projects as Record<string, unknown> | undefined) }
  const key = Object.keys(projects).find((k) => normRoot(k) === root) ?? root
  if (projects[key] !== undefined && !isRecord(projects[key])) return `Souffleur: the block for ${root} in ${shownPath(home, path)} is not an object, so nothing was written.`
  const block: Record<string, unknown> = { ...(projects[key] as Record<string, unknown> | undefined) }
  if (block.block !== undefined && !(Array.isArray(block.block) && block.block.every((n) => typeof n === 'string'))) return `Souffleur: "block" for ${root} is not a list of names, so nothing was written.`
  const names: string[] = [...((block.block as string[] | undefined) ?? [])]
  const projectText = await readOptional($, `${l0.root}/.claude/souffleur.json`, [], home)
  const std = standardNames(parseConfig(stripBom(st.text), projectText === undefined ? undefined : stripBom(projectText)).config)
  if (!std.has(name) && !names.includes(name)) return `Souffleur: ${name} is not in your standard or this project's block.`
  if (verb === 'block') {
    if (names.includes(name)) return `Souffleur: ${name} is already blocked in ${root}.`
    if (names.length >= MAX_LIST) return `Souffleur: the block of ${root} already has ${MAX_LIST} names, so nothing was written.`
    if (!(key in projects) && Object.keys(projects).length >= MAX_PROJECT_ROOTS) return `Souffleur: at most ${MAX_PROJECT_ROOTS} project blocks are read, so nothing was written.`
    names.push(name)
    block.block = names
  } else {
    if (!names.includes(name)) return `Souffleur: ${name} is not blocked in ${root}.`
    const left = names.filter((n) => n !== name)
    if (left.length) block.block = left
    else delete block.block
  }
  if (Object.keys(block).length) projects[key] = block
  else delete projects[key]
  const next: Record<string, unknown> = { ...base }
  if (Object.keys(projects).length) next.projects = projects
  else delete next.projects
  // Read once more right before the write: another session or the user may have saved the file since.
  const again = await readState($, path, home)
  if (again.kind !== 'ok' || again.text !== st.text) return `Souffleur: ${shownPath(home, path)} changed since it was read, so nothing was written.`
  try {
    if (!backedUp) {
      await $.fs.write(`${path}.bak-${Date.now()}`, st.text)
      backedUp = true
    }
    await $.fs.write(path, `${JSON.stringify(next, null, 2)}\n`)
  } catch (err) {
    return `Souffleur: could not write ${shownPath(home, path)} (${scrub(home, message(err))}).`
  }
  loaded = undefined // the next event reads the new block
  await apply($, (l) => ({ type: 'config', now: now(), errors: l.errors }))
  return verb === 'block' ? `Souffleur: ${name} blocked in ${root}; other projects keep it.` : `Souffleur: ${name} unblocked in ${root}; the standard applies here again.`
}

/** Every skill name, note id and rule id of a config (the standard when it was read without a root). */
function standardNames(c: Config): Set<string> {
  return new Set([...Object.keys(c.skills), ...c.notes.map((n) => n.id), ...c.rules.map((r) => r.id)])
}

/** `/souffleur project`: what applies here, as a few short lines. Empty lines are left out. */
async function runProject($: Dollar, l: Loaded): Promise<string> {
  const home: string | undefined = await $.env.get('HOME')
  const st = home ? await readState($, `${home}/.claude/souffleur.json`, home) : ({ kind: 'missing' } as FileState)
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
  const mine = [...(p?.own ?? [])].map((n) => `${n in c.skills ? 'skill' : c.notes.some((x) => x.id === n) ? 'note' : 'rule'} ${n}`)
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
    if (!listed?.length) return []
    if (typeof skills.totalSkills === 'number' && typeof skills.includedSkills === 'number' && skills.includedSkills < skills.totalSkills) return []
    return [...new Set(listed.filter((x) => x.source === 'projectSettings' || x.source === 'project').map((x) => x.name))]
  } catch {
    return []
  }
}

/**
 * Changes the user file through the same careful path as `block`: read fresh, stop on a read error or a file that cannot be edited,
 * read again right before the write, save `souffleur.json.bak-<epoch ms>` before the first write of a session, then reload.
 */
async function editUserFile($: Dollar, change: (doc: unknown) => { config: unknown; note?: string }): Promise<{ ok: boolean; text: string }> {
  const home: string | undefined = await $.env.get('HOME')
  if (!home) return { ok: false, text: 'the home folder is unknown, so nothing was written' }
  const path = `${home}/.claude/souffleur.json`
  const st = await readState($, path, home)
  if (st.kind !== 'ok') return { ok: false, text: st.kind === 'error' ? `could not read ${shownPath(home, path)} (${st.why}), so nothing was written` : 'there is no user file, so nothing was written' }
  let doc: unknown
  try {
    doc = parseJson(st.text)
  } catch (err) {
    return { ok: false, text: `${shownPath(home, path)} is not valid JSON (${scrub(home, message(err))}), so nothing was written` }
  }
  const problem = configProblem(doc)
  if (problem) return { ok: false, text: `${shownPath(home, path)} cannot be edited because ${problem}, so nothing was written` }
  const r = change(doc)
  if (r.note) return { ok: false, text: r.note }
  const again = await readState($, path, home)
  if (again.kind !== 'ok' || again.text !== st.text) return { ok: false, text: `${shownPath(home, path)} changed since it was read, so nothing was written` }
  try {
    if (!backedUp) {
      await $.fs.write(`${path}.bak-${Date.now()}`, st.text)
      backedUp = true
    }
    await $.fs.write(path, `${JSON.stringify(r.config, null, 2)}\n`)
  } catch (err) {
    return { ok: false, text: `could not write ${shownPath(home, path)} (${scrub(home, message(err))})` }
  }
  loaded = undefined
  await apply($, (l) => ({ type: 'config', now: now(), errors: l.errors }))
  return { ok: true, text: 'written' }
}

/** Set once the question about the project's own skills was handled in this session. */
let ownHandled = false
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
  if (ownHandled) return
  const { l, session } = await current($)
  if (session.paused || session.proposals.length || !l.setUp) return
  let repo: unknown
  try {
    repo = await $.session.repo()
  } catch {
    return
  }
  if (!repo) return
  ownHandled = true
  const home: string | undefined = await $.env.get('HOME')
  if (!home) return
  const st = await readState($, `${home}/.claude/souffleur.json`, home)
  if (st.kind !== 'ok') return
  let doc: unknown
  try {
    doc = parseJson(st.text)
  } catch {
    return
  }
  if (configProblem(doc) || hasProjectKey(doc, l.root)) return
  const names = (await projectInstalled($)).filter((n) => !(n in l.config.skills))
  if (!names.length) return
  const notice = () => void say($, l, `Souffleur: this project has ${names.length} skills not in your config. /souffleur init asks about them.`)
  if (!dialog) return notice()
  const shown = names.slice(0, 5).join(', ') + (names.length > 5 ? ', …' : '')
  const question = `This project has ${names.length} skill${names.length === 1 ? '' : 's'} not in your config: ${shown}. Set ${names.length === 1 ? 'it' : 'them'} up now?`
  let answer: unknown
  try {
    const asking = Promise.resolve().then(() => $.ui.ask(question, { options: [OWN_NOW, OWN_IGNORE, OWN_LATER], header: 'Souffleur' }))
    asking.catch(() => undefined) // a late rejection after a timeout is nobody's business
    answer = await Promise.race([asking, $.clock.sleep(ASK_WAIT_MS).then(() => Promise.reject(new TimedOut()))])
  } catch (err) {
    // Dismissed or timed out: ask again next session. Nobody can answer: say so once.
    if (!(err instanceof TimedOut) && !DISMISSED.test(message(err))) notice()
    return
  }
  if (answer === OWN_NOW) {
    say($, l, await runInit($, l, names))
    return
  }
  if (answer !== OWN_IGNORE) return
  const kept = names.slice(0, MAX_LIST)
  const r = await editUserFile($, (d) => {
    let config: unknown = d
    for (const name of kept) config = ignoreInProject(config, l.root, name).config
    return { config }
  })
  if (!r.ok) say($, l, `Souffleur: ${r.text}.`)
  else if (names.length > kept.length) say($, l, `Souffleur: the ignored list of this project holds ${MAX_LIST} names; ${names.length - kept.length} skills stay unasked. /souffleur init asks about them.`)
}

/**
 * Adds one entry to the user file. Same care as `init`: read fresh, stop on a read error or a file that cannot be edited,
 * write only now (the caller has the user's yes), keep every other key. Returns the user-facing line.
 */
async function writeEntry($: Dollar, kind: 'rule' | 'note', entry: Rule | Note): Promise<{ ok: boolean; text: string; wrote?: boolean }> {
  const home: string | undefined = await $.env.get('HOME')
  if (!home) return { ok: false, text: 'the home folder is unknown, so nothing was written' }
  const path = `${home}/.claude/souffleur.json`
  const st = await readState($, path, home)
  if (st.kind === 'error') return { ok: false, text: `could not read ${shownPath(home, path)} (${st.why}), so nothing was written` }
  let doc: unknown
  if (st.kind === 'ok') {
    try {
      doc = parseJson(st.text)
    } catch (err) {
      return { ok: false, text: `${shownPath(home, path)} is not valid JSON (${scrub(home, message(err))}), so nothing was written` }
    }
    const problem = configProblem(doc)
    if (problem) return { ok: false, text: `${shownPath(home, path)} cannot be edited because ${problem}, so nothing was written` }
  }
  const r = addEntry(doc, kind, entry)
  if (r.note) return { ok: true, text: r.note }
  // Read once more right before the write: another session or the user may have saved the file since.
  const again = await readState($, path, home)
  if (again.kind === 'error' || again.kind !== st.kind || (again.kind === 'ok' && st.kind === 'ok' && again.text !== st.text)) {
    return { ok: false, text: `${shownPath(home, path)} changed since it was read, so nothing was written` }
  }
  await $.fs.write(path, `${JSON.stringify(r.config, null, 2)}\n`)
  return { ok: true, wrote: true, text: `added ${kind} ${entry.id} to ${shownPath(home, path)}${entry.where === undefined ? '' : ` for ${entry.where}`}` }
}

/** The session after a change the core has no event for: read, change, store. */
function update($: Dollar, change: (l: Loaded, s: Session) => Session): Promise<void> {
  return serial(async () => {
    const { l, session } = await current($)
    await persist($, l, change(l, await withStoredDeclined($, session)))
  })
}

/** The person declined a proposal or dismissed a dialog (never a failure or a timeout): kept in the session, so a reload does not forget it. */
async function markStopped($: Dollar, flags: { proposals?: boolean; ask?: boolean }): Promise<void> {
  if (flags.ask) askStopped = true
  await update($, (_l, s) => ({ ...s, ...(flags.proposals ? { proposalsStopped: true } : {}), ...(flags.ask ? { askStopped: true } : {}) }))
}

/** A prompt of the person ends the offer a notice made. Without an answer the proposal just stays queued: no stop. */
function endOffer(): void {
  shownHash = undefined
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
      w = await writeEntry($, r.write.kind, r.write.entry)
    } catch (err) {
      w = { ok: false, text: `writing failed (${scrub(await $.env.get('HOME'), message(err))}), so nothing was written` }
    }
    if (!w.ok) {
      await persist($, l, session)
      return `Souffleur: ${w.text}. The proposal stays queued.`
    }
    loaded = undefined // the file changed: read it again
    const l2 = await getLoaded($)
    await persist($, l2, decide(l2.config, r.session, { type: 'config', now: now(), errors: l2.errors }).session)
    await markVersionDone($, session, r.session, hash)
    // The file is what counts: confirm that the reader kept the entry before saying it is there.
    const kept = [...l2.config.rules, ...l2.config.notes].some((x) => x.id === r.write!.entry.id)
    if (w.wrote && !kept) {
      const why = l2.errors.filter((m) => m.startsWith('user config')).slice(-2).join('; ')
      return `Souffleur: wrote ${r.write.entry.id} to the file, but the reader did not keep it${why ? ` (${why})` : ''}. Check ~/.claude/souffleur.json.`
    }
    return `Souffleur: ${w.text}.`
  }
  await persist($, l, label === NO ? { ...r.session, proposalsStopped: true } : r.session)
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
  const p = session.proposals.find((x) => !noticed.has(x.hash))
  // A session that takes no person prompt (`claude -p`) cannot be answered by a reply word: name the command.
  const form = !interactive && lastPromptKind === 'sdk' ? 'command' : 'reply'
  if (p === undefined || !say($, l, proposalNotice(p, form))) return
  shownHash = p.hash
  noticed.add(p.hash)
}

/** One dialog about the first waiting proposal. Returns the line to show, or undefined when nothing was asked or the dialog gave no answer. */
async function askFirst($: Dollar, atTurnEnd = false): Promise<string | undefined> {
  const { l, session } = await current($)
  // A proposal whose dialog timed out (at a turn end or in a typed command) is not asked again while that dialog is still open.
  const waiting = await withStoredDeclined($, session)
  const q = nextQuestion({ ...waiting, proposals: waiting.proposals.filter((p) => !timedOutAsk.has(p.hash)) })
  if (!q) return undefined
  let label: unknown
  const asking = Promise.resolve().then(() => $.ui.ask(q.question, { options: q.options, header: 'Souffleur' }))
  try {
    // A client that shows no dialog may never answer: after two minutes the turn end falls back to a notice and a typed command returns.
    label = await Promise.race([asking, $.clock.sleep(ASK_WAIT_MS).then(() => Promise.reject(new TimedOut()))])
  } catch (err) {
    if (err instanceof TimedOut) {
      // Only this proposal falls back. The dialog stays open: a later tap still counts while the proposal waits.
      timedOutAsk.add(q.hash)
      asking.then((late) => lateAnswer($, q.hash, late), () => undefined).finally(() => timedOutAsk.delete(q.hash))
      // A typed command answers for itself: no notice, no stop.
      if (!atTurnEnd) return ASK_TIMEOUT_LINE
      noticeFirst($, l, session)
    } else if (DISMISSED.test(message(err))) {
      // The person closed the dialog: a skip. Nothing more is asked at turn end, and the model proposes no more.
      await markStopped($, { proposals: true, ...(atTurnEnd ? { ask: true } : {}) })
    } else if (atTurnEnd) {
      // Nobody can answer a dialog here: show the proposal once and let a one-word reply answer it.
      // Only this process knows it: a session resumed in a client that can open a dialog asks again, and no stop is set.
      noDialog = true
      askStopped = true
      noticeFirst($, l, session)
    } else {
      // A dialog in a typed command that cannot open: the turn-end question still comes.
      askAtTurnEnd = true
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
/** Proposals whose dialog timed out (turn end or typed command) and may still be answered. */
const timedOutAsk = new Set<string>()

/** A dialog answered after its timeout: counts only while the proposal still waits (a reply may have answered it first). */
async function lateAnswer($: Dollar, hash: string, label: unknown): Promise<void> {
  if (typeof label !== 'string' || label.trim() === '') return
  try {
    const { session } = await current($)
    if (session.paused || !session.proposals.some((p) => p.hash === hash)) return
    if (shownHash === hash) shownHash = undefined
    askAtTurnEnd = true
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
  const hash = shownHash
  shownHash = undefined
  const verdict = parseReply(text)
  if (hash === undefined || verdict === undefined) return undefined
  const { l, session } = await current($)
  const p = session.paused ? undefined : session.proposals.find((x) => x.hash === hash)
  if (!p) return undefined
  const id = p.entry.id
  // By the full hash: the short id may name another waiting proposal.
  try {
    const line = await commitAnswer($, hash, verdict === 'accept' ? YES_EVERYWHERE : NO)
    askAtTurnEnd = true // the next waiting proposal gets its question or notice at the next turn end
    try {
      $.ui.toast(line)
    } catch {
      say($, l, line)
    }
    const { l: l3, session: after } = await current($)
    const active = [...l3.config.rules, ...l3.config.notes].some((x) => x.id === id)
    if (verdict === 'accept' && !after.proposals.some((x) => x.hash === hash) && !active) return `Souffleur: the user accepted proposal ${id}, but the reader did not keep the entry; it is not active. Tell the user to check ~/.claude/souffleur.json.`
    if (after.proposals.some((x) => x.hash === hash)) return `Souffleur: the user tried to ${verdict} proposal ${id}, but it could not be written; it stays queued. Do not retry it.`
    return `Souffleur: the user ${verdict === 'accept' ? 'accepted' : 'declined'} proposal ${id}; nothing else to do for it.`
  } catch {
    // Something failed during or after the write; the model must not assume either outcome.
    return `Souffleur: the answer may not have been written; check ~/.claude/souffleur.json or /souffleur.`
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

/** Skill versions whose read is under way in this process. */
const reading = new Set<string>()
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
    if (reading.has(hash)) {
      hash = undefined
      return
    }
    reading.add(hash)
    const key = hashKey(hash)
    const l = await serial(async () => {
      const { l, session } = await current($)
      const stored = await $.store.get(key)
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
    const r = await $.model.complete({ model: 'haiku', system: EXTRACT_SYSTEM, prompt: extractPrompt(a.skill, text, nonce), maxTokens: 1500, timeoutMs: READ_TIMEOUT_MS })
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
    if (!full) await $.store.set(key, queued.length === 0 ? { done: true } : { offers: offers + 1 })
  } catch {
    if (claimed && hash !== undefined) {
      try {
        await apply($, () => ({ type: 'learned', now: now(), ok: false }))
        await serial(async () => {
          const { l, session } = await current($)
          await persist($, l, { ...session, skillReads: Math.max(0, (session.skillReads ?? 0) - 1) })
          await $.store.set(hashKey(hash!), { fails: fails + 1 })
        })
      } catch {
        // the version stays as it was
      }
    }
  } finally {
    if (hash !== undefined) reading.delete(hash)
  }
}

const withoutSkillHash = ({ skillHash: _gone, ...rest }: Proposal): Proposal => rest

/** After an answer: the skill version the answered proposal came from is done once none of its proposals waits any more. */
async function markVersionDone($: Dollar, before: Session, after: Session, hash: string): Promise<void> {
  const version = before.proposals.find((q) => q.hash === hash)?.skillHash
  if (version === undefined || after.proposals.some((q) => q.skillHash === version)) return
  try {
    await $.store.set(hashKey(version), { done: true })
  } catch {
    // the version stays offered and is read again next time, within the cap
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
    const r = await $.model.complete({ model: 'haiku', prompt: shapePrompt(text, l.config.needs) })
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
    out.push(done.length ? 'Still waiting:' : rest.proposals.some((p) => timedOutAsk.has(p.hash)) ? 'Waiting for your answer; a dialog for it is still open:' : 'Waiting for your answer, and no dialog can open here:', ...proposalLines(rest), 'Add one with /souffleur accept <id> (everywhere) or /souffleur accept <id> here (this project only).')
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

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await safe($, 'session.start', undefined, async () => {
      loaded = undefined
      ownHandled = false
      backedUp = false // a session start is a fresh run: the first change saves a new backup
      const l = await getLoaded($)
      const id: string = await $.session.id()
      const version = (await $.session.version()).version
      const held: Session | undefined = (await $.state.get(REF)).value
      const stored = held?.id === id ? undefined : await $.store.get(`session:${id}`)
      const before = held?.id === id ? held : isSession(stored, id) ? stored : undefined
      let s: Session
      restoredAskStopped = false
      if (before) {
        // Resume or reload: the ledger stays, what the config said last time does not.
        s = decide(l.config, { ...before, errors: [] }, { type: 'start', now: now(), start: held?.id === id ? 'reload' : 'resume', version }).session
        s = decide(l.config, s, { type: 'config', now: now(), errors: l.errors }).session
      } else s = await freshSession($, l, id, 'startup')
      restoredAskStopped = s.askStopped === true
      // Problems that hold at the start are news once; a resumed session's stored `noticed` keeps them from repeating.
      const first = notices(l.config, s, s, l.root)
      s = first.session
      await persist($, l, s, true)
      say($, l, startNotice(l.config, s, l.setUp, PLUGIN_VERSION))
      for (const line of first.lines) say($, l, line)
    })
    await pruneStore($, await $.session.id())
    await safe($, 'installed', undefined, () => refreshInstalled($))
    await safe($, 'command.register', undefined, async () => {
      await $.command.register({ name: 'souffleur', description: 'Show which skills Souffleur keeps loaded', argumentHint: '[status | need <name> | drop <name> | pause | resume | init | migrate | rule <text> | review | accept <id> | decline <id> | block <name> | unblock <name> | project]' })
    })
    interactive = e.isInteractive === true
    lastPromptKind = undefined
    lastPromptCommand = false
    personTurn = false
    askStopped = restoredAskStopped
    shownHash = undefined
    noticed.clear()
    timedOutAsk.clear()
    noDialog = false
    askAtTurnEnd = false
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
    await safe($, 'skill.prompt', undefined, async () => {
      const { actions } = await apply($, () => ({ type: 'skill', now: now(), skill: e.skill, text: e.text, ...(e.source === undefined ? {} : { source: e.source }), ...(e.pluginName === undefined ? {} : { pluginName: e.pluginName }), ...(e.path === undefined ? {} : { path: e.path }) }))
      for (const a of actions) if (a.kind === 'learn') void learnFrom($, a)
    })
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
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
    const fromUser = isFromUser(e)
    if (fromUser) lastPromptKind = e.origin?.kind
    personTurn = fromUser || (e.command !== undefined && isUserOrigin(e))
    lastPromptCommand = e.command !== undefined
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
      const classify = fromUser && answered === undefined && !session.paused && Object.keys(needs).length > 0
      // The skill listing runs beside the classification and gives up after its own short budget.
      const listing = fromUser ? safe($, 'installed', undefined, () => refreshInstalled($)) : undefined
      const verdict = classify
        ? await classifyDeliverable(
            e.text,
            needs,
            async (text, labels) => (await $.model.classify(text, labels)) ?? '',
            (ms) => $.clock.sleep(ms),
          )
        : undefined
      await listing
      const { actions } = await apply($, (l2) => ({ type: 'prompt', now: now(), text: e.text, fromUser, matched: verdict?.matched ?? [], root: l2.root, ...(verdict === undefined ? {} : { classifierFailed: verdict.failed }), ...(verdict?.kind === undefined ? {} : { deliverable: verdict.kind }), ...(verdict?.bFailure !== undefined ? { workFailed: true } : verdict?.kind === 'code-or-repo-work' ? { workFailed: false } : {}) }))
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
    let r
    try {
      r = await next(e)
    } finally {
      if (e.tool === 'Agent' && e.agentId === undefined) {
        await safe($, 'tool.done', undefined, async () => {
          await apply($, () => ({ type: 'agentDone', now: now() }))
        })
      }
    }
    const extra = actions.flatMap((a) => (a.kind === 'toolContext' ? [a.text] : []))
    if (!extra.length || r.deny !== undefined) return r
    return { ...r, context: [...(r.context ?? []), ...extra] }
  }).catch(($, e, next) => next(e))

  on('tool.run', { tool: PROPOSE_TOOL }, async ($, e) => {
    const text = await safe($, 'souffleur_propose', 'Souffleur could not queue the proposal. Tell the user and carry on.', () => runPropose($, e as unknown as Record<string, unknown>))
    return { result: text }
  })

  // At the end of a turn: one question about the first waiting proposal; where no dialog opens, a notice with a reply hint.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId === undefined && e.reason === 'answer' && personTurn && typeof e.answer === 'string') {
      await safe($, 'turn.reply', undefined, async () => {
        await apply($, (l) => ({ type: 'reply', now: now(), answer: e.answer, fromCommand: lastPromptCommand, aborted: e.isAborted, root: l.root }))
      })
      // One check per person prompt: a later turn without its own prompt (a background completion) is not the person's.
      personTurn = false
    }
    if (e.agentId === undefined && e.reason === 'answer' && (!askStopped || askAtTurnEnd || noDialog)) {
      await safe($, 'turn.complete', undefined, async () => {
        if ((await current($)).session.paused) return
        // While an offer is armed no person prompt has ended it yet: a new notice would redirect the reply, and a new
        // dialog would add one more open question. The offer stays until a prompt of the person ends it.
        if (shownHash !== undefined) return
        askAtTurnEnd = false
        if (noDialog) {
          // A dialog was tried and nobody can answer: no new attempt, only a notice for a proposal not shown yet.
          const { l, session } = await current($)
          noticeFirst($, l, session)
          if (!session.proposals.length) await askOwnSkills($, false)
          return
        }
        const hadProposals = (await current($)).session.proposals.length > 0
        const line = await askFirst($, true)
        if (!hadProposals && line === undefined && !noDialog && !askStopped) await askOwnSkills($, interactive || lastPromptKind !== 'sdk')
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
    if (e.command === 'souffleur') {
      const verb0 = (e.args ?? '').trim().split(/\s+/)[0]
      if (verb0 === 'init' || verb0 === 'migrate') {
        const text = await safe($, `command.run.${verb0}`, undefined as string | undefined, async () => {
          loaded = undefined // read the files again: another session may have changed them
          const { l } = await current($)
          return verb0 === 'init' ? runInit($, l) : runMigrate($, l)
        })
        if (text !== undefined) return { text }
        return next(e)
      }
      if (verb0 === 'block' || verb0 === 'unblock' || verb0 === 'project') {
        if (!isUserOrigin(e)) return { text: `Souffleur: only the user can run /souffleur ${verb0}; a plugin or the model cannot.` }
        const rest = (e.args ?? '').trim().slice(verb0.length).trim()
        const text = await safe($, `command.run.${verb0}`, undefined as string | undefined, async () => {
          loaded = undefined
          const { l } = await current($)
          return verb0 === 'project' ? runProject($, l) : runBlock($, l, verb0, rest)
        })
        if (text !== undefined) return { text }
        return next(e)
      }
      if (verb0 === 'rule' || verb0 === 'review' || verb0 === 'accept' || verb0 === 'decline') {
        if (!isUserOrigin(e)) return { text: `Souffleur: only the user can run /souffleur ${verb0}; a plugin or the model cannot.` }
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
        const { actions, l } = await apply($, (l0) => ({ type: 'command', now: now(), args: e.args ?? '', root: l0.root }))
        const text = actions.flatMap((a) => (a.kind === 'reply' ? [a.text] : []))[0]
        const verb = (e.args ?? '').trim().split(/\s+/)[0] ?? ''
        const note = '\n\nSouffleur is not set up: there is no ~/.claude/souffleur.json. Run /souffleur init to add one.'
        return text !== undefined && !l.setUp && (verb === '' || verb === 'status') ? `${text}${note}` : text
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
