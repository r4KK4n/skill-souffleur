import type { Register } from 'claude-code'
import { parseConfig } from '../core/config.ts'
import { decide, initSession } from '../core/decide.ts'
import { MIGRATE_INTRO, describeHook, findHookOverlaps, findPassages, hookSteps, isGuess, migrateSteps, passageLines, removeHook } from '../core/migrate.ts'
import type { HookOverlap, Passage } from '../core/migrate.ts'
import { CHOICE_LABEL, NOT_SET_UP, SETUP_INTRO, applyChoice, candidates, choiceOf, cleanNeedText, configProblem, currentChoice, describePlan, needKeyFor, options, parsePicks, picksPrompt, setupSteps } from '../core/setup.ts'
import type { LoadChoice, NeedText, Plan, Suggestion } from '../core/setup.ts'
import type { Action, CoreEvent, Session } from '../core/decide.ts'
import { classifyPrompt } from '../core/needs.ts'
import { statusLine } from '../core/status.ts'
import type { Config } from '../core/types.ts'
import { isFromUser, toolFields } from './map.ts'

// The hooks' `$` is the engine interface; the adapter calls only documented members.
type Dollar = any
type Loaded = { config: Config; errors: string[]; root: string; cwd: string; setUp: boolean }

const REF = { plugin: 'skill-souffleur', key: 'session' } as const
const RULE =
  'Souffleur keeps track of skills in this session. If a message from Souffleur asks you to load skills, invoke each one with the Skill tool before you continue.'

// Module variables start over on a reload; the config is read again by `session.start`, which a reload runs.
let loaded: Loaded | undefined

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
  const parsed = parseConfig(userText === undefined ? undefined : stripBom(userText), projectText === undefined ? undefined : stripBom(projectText))
  loaded = { config: parsed.config, errors: [...errors, ...parsed.errors], root, cwd, setUp: userText !== undefined }
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
  const held: Session | undefined = (await $.state.get(REF)).value
  if (held && held.id === id) return { l, session: held }
  // A different id with no session.start in between is /clear (D6).
  if (held) return { l, session: await freshSession($, l, id, 'clear') }
  const stored = await $.store.get(`session:${id}`)
  if (isSession(stored, id)) return { l, session: stored }
  return { l, session: await freshSession($, l, id, 'startup') }
}

async function persist($: Dollar, l: Loaded, s: Session): Promise<void> {
  // A broken file shows as degraded; only a clean start without a user file says "not set up".
  $.ui.status(!l.setUp && !s.errors.length ? NOT_SET_UP : statusLine(s, l.config.mode))
  await $.state.set(REF, s)
  await $.store.set(`session:${s.id}`, s)
}

/** Feeds one event to the core and stores the result. */
async function apply($: Dollar, make: (l: Loaded) => CoreEvent): Promise<{ actions: Action[]; l: Loaded }> {
  const { l, session } = await current($)
  const r = decide(l.config, session, make(l))
  await persist($, l, r.session)
  return { actions: r.actions, l }
}

/** Runs the adapter's own work. A throw becomes an `error` event and `fallback`; it never reaches the event. */
async function safe<T>($: Dollar, where: string, fallback: T, work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    try {
      await apply($, () => ({ type: 'error', now: now(), where, message: message(err) }))
    } catch {
      // Recording failed too; the event still goes through.
    }
    return fallback
  }
}

/** Names of the skills this session lists. `$.session.usage` carries the skill listing; `$.command.list` is the fallback. */
async function installedSkills($: Dollar): Promise<string[]> {
  try {
    const usage = await $.session.usage({ breakdown: 'summary' })
    const listed: { name: string }[] | undefined = usage?.context?.breakdown?.skills?.skillFrontmatter
    if (listed?.length) return [...new Set(listed.map((x) => x.name))]
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
async function readStanding($: Dollar, l: Loaded, home: string, notes: string[]): Promise<{ file: string; text: string }[]> {
  const slug = l.root.replace(/[^A-Za-z0-9]/g, '-')
  const claudeMds = [...new Set([`${home}/.claude/CLAUDE.md`, `${l.root}/CLAUDE.md`, `${l.cwd}/CLAUDE.md`])]
  const files: { file: string; text: string }[] = []
  const seen = new Set<string>()
  for (const path of claudeMds) {
    const text = await readOptional($, path, notes, home)
    if (text === undefined) continue
    seen.add(path)
    files.push({ file: shownPath(home, path), text })
    const dir = path.slice(0, path.lastIndexOf('/'))
    for (const m of text.matchAll(/(?:^|\s)@([^\s@]+\.[A-Za-z0-9]+)/g)) {
      const ref = m[1]!
      const target = ref.startsWith('/') ? ref : ref.startsWith('~/') ? `${home}/${ref.slice(2)}` : `${dir}/${ref.replace(/^\.\//, '')}`
      if (seen.has(target)) continue
      seen.add(target)
      const imported = await readOptional($, target, notes, home)
      if (imported !== undefined) files.push({ file: shownPath(home, target), text: imported })
    }
  }
  const memory = `${home}/.claude/projects/${slug}/memory/MEMORY.md`
  const text = await readOptional($, memory, notes, home)
  if (text !== undefined) files.push({ file: shownPath(home, memory), text })
  return files
}

const withNotes = (text: string, notes: string[]) => (notes.length ? `${text}\n\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}` : text)

/**
 * `/souffleur init`: asks per skill how it is kept and writes each answer to the user file as it comes.
 * It reads the files fresh, writes only the user file, and writes nothing when the file cannot be read or edited.
 * Where no dialog answers, it returns the recommendations and the config they give, and writes nothing.
 */
async function runInit($: Dollar, l0: Loaded): Promise<string> {
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
  const parsed = parseConfig(user.kind === 'ok' ? stripBom(user.text) : undefined, projectText === undefined ? undefined : stripBom(projectText))
  const config = parsed.config
  notes.push(...parsed.errors)
  const projectSkills: Record<string, unknown> = Object.fromEntries(Object.entries(config.skills).filter(([, r]) => r.from === 'project'))

  const settings = await readSettings($, settingsPath, home)
  if (settings.error) notes.push(`${settings.error}, so its hooks were not checked.`)
  const described = await installedWithDescriptions($)
  const installed = described.map((x) => x.name)
  const configured = Object.keys(config.skills)
  const hooks = findHookOverlaps(settings.value, configured, installed.filter((n) => !configured.includes(n)))
  const reloadHooked = [...new Set(hooks.flatMap((o) => (o.skill !== undefined && installed.includes(o.skill) && !(o.skill in config.skills) ? [o.skill] : [])))]
  const startHooked = new Set(hooks.flatMap((o) => (o.event === 'SessionStart' && o.skill !== undefined ? [o.skill] : [])))
  const passages = findPassages(await readStanding($, l0, home, notes), configured, Infinity)

  // One small-model call over the installed skills that have no need yet: unconfigured, hook-reloaded, or in the user file without one.
  const pool = described.filter((x) => {
    const rule = config.skills[x.name]
    return rule === undefined || (rule.from === 'user' && rule.need === undefined)
  })
  let picks: Suggestion[] = []
  if (pool.length) {
    try {
      const r = await $.model.complete({ model: 'haiku', prompt: picksPrompt(pool, config.needs) })
      if (r.isAnswered) picks = parsePicks(r.text, pool.map((x) => x.name), config.needs)
      else notes.push('The small model gave no answer, so no descriptions are proposed.')
    } catch (err) {
      notes.push(`The small model failed (${scrub(home, message(err))}), so no descriptions are proposed.`)
    }
  }

  const plans: Plan[] = candidates(config, installed, reloadHooked, picks.map((x) => x.skill)).map(({ skill, source }) => {
    const current = currentChoice(config.skills[skill])
    const pick = picks.find((x) => x.skill === skill)
    const need = pick ? { need: pick.need } : {}
    if (source === 'hook') return { skill, source, recommended: startHooked.has(skill) ? 'start' : 'need', ...need }
    if (source === 'model') return { skill, source, recommended: 'need', ...need }
    return { skill, source, ...(current === undefined ? {} : { current }), recommended: current ?? 'need', ...need }
  })
  const watched = new Set(plans.map((p) => p.skill))
  const unwatched = installed.filter((name) => !watched.has(name))
  const toAsk = plans.filter((p) => p.source !== 'project')

  const noDialog = () => withNotes(setupSteps({ plans, userConfig: userDoc, configPath: shown(configPath), unwatched }), notes)
  const done: string[] = []
  let asked = false
  let wrote = false
  /** The description a dialog shows for "When the task needs it", and whether it is only the fallback. */
  const proposal = (p: Plan): { need: NeedText; fallback: boolean } => {
    if (p.need) return { need: p.need, fallback: false }
    const key = config.skills[p.skill]?.need
    const text = key === undefined ? undefined : config.needs[key]
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
        ...(p.skill.includes(':') ? ['Injected by its plugin fits plugins that put their own text in at session start.'] : []),
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
      const r = applyChoice(doc, p.skill, choice, need, projectSkills)
      if (r.note) done.push(r.note)
      const label = choice === 'none' ? 'not watched' : CHOICE_LABEL[choice]
      if (r.note || JSON.stringify(r.config) === JSON.stringify(doc) || (now2.kind === 'missing' && choice === 'none')) {
        if (!r.note) done.push(`Kept ${p.skill}: ${label}. Nothing was written.`)
        continue
      }
      await $.fs.write(configPath, `${JSON.stringify(r.config, null, 2)}\n`)
      wrote = true
      loaded = undefined // the session reads the new file on its next event
      done.push(`${p.skill}: ${label}.`)
      if (r.pruned?.length) done.push(`Removed the unused ${r.pruned.length === 1 ? 'need' : 'needs'} ${r.pruned.join(', ')}.`)
    }
  } catch (err) {
    if (!asked) return noDialog()
    done.push(`Stopped early: ${scrub(home, message(err))}. Answers given so far are kept.`)
  }
  if (!asked && toAsk.length && !done.length) return noDialog()

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
  if (wrote) out.push('', 'New entries apply from the next session start. The default mode is observe: nothing is blocked until you set "mode": "enforce" in the user file.')
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
  const installed = await installedSkills($)
  const hooks: HookOverlap[] = findHookOverlaps(settings.value, configured, installed.filter((n) => !configured.includes(n)))
  const passages: Passage[] = findPassages(files, configured, Infinity)
  const known = { configured, installedOnly: installed.filter((n) => !configured.includes(n)) }

  const noDialog = () => withNotes(migrateSteps({ hooks, passages, settingsPath: shown(settingsPath) }), notes)
  const done: string[] = []
  const manual: string[] = []
  const label = (o: HookOverlap) => `${o.event} hook ${o.command}`
  let asked = false
  let backedUp = false
  let expected = settings.text // what settings.json should hold; anything else means it changed under us
  try {
    for (const [i, o] of hooks.entries()) {
      const question = `${asked ? '' : `${MIGRATE_INTRO}\n\n`}Turn off the ${describeHook(o)} hook? Souffleur now does this job.`
      const answer: unknown = await $.ui.ask(question, { options: ['Turn off', 'Keep', 'Show me what to do', 'Stop'], header: 'Souffleur' })
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

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    await safe($, 'session.start', undefined, async () => {
      loaded = undefined
      const l = await getLoaded($)
      const id: string = await $.session.id()
      const version = (await $.session.version()).version
      const held: Session | undefined = (await $.state.get(REF)).value
      const stored = held?.id === id ? undefined : await $.store.get(`session:${id}`)
      const before = held?.id === id ? held : isSession(stored, id) ? stored : undefined
      let s: Session
      if (before) {
        // Resume or reload: the ledger stays, what the config said last time does not.
        s = decide(l.config, { ...before, errors: [] }, { type: 'start', now: now(), start: 'resume', version }).session
        for (const msg of l.errors) s = decide(l.config, s, { type: 'error', now: now(), where: 'config', message: msg }).session
      } else s = await freshSession($, l, id, 'startup')
      await persist($, l, s)
    })
    await safe($, 'command.register', undefined, async () => {
      await $.command.register({ name: 'souffleur', description: 'Show which skills Souffleur keeps loaded', argumentHint: '[status | need <name> | drop <name> | pause | init | migrate]' })
    })
    return next(e)
  })

  on('skill.prompt', async ($, e, next) => {
    await safe($, 'skill.prompt', undefined, async () => {
      await apply($, () => ({ type: 'skill', now: now(), skill: e.skill }))
    })
    return next(e)
  })

  on('session.compact', async ($, e, next) => {
    const agentId = e.agentId === undefined ? {} : { agentId: e.agentId }
    await safe($, 'session.compact', undefined, async () => {
      await apply($, () => ({ type: 'compact', now: now(), phase: 'before', trigger: e.trigger, ...agentId }))
    })
    // The engine always sends the messages; the test kit's compaction call sends none, and next() refuses that.
    const r = await next(Array.isArray(e.messages) ? e : { ...e, messages: [{ role: 'user' as const, text: '', toolUses: [] }] })
    await safe($, 'session.compact', undefined, async () => {
      const skipped = 'skip' in r && r.skip !== undefined
      await apply($, () => ({ type: 'compact', now: now(), phase: 'after', trigger: e.trigger, skipped, ...agentId }))
    })
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    const fromUser = isFromUser(e)
    const texts = await safe($, 'prompt.submit', [] as string[], async () => {
      const { config } = await getLoaded($)
      const matched =
        fromUser && Object.keys(config.needs).length > 0
          ? await classifyPrompt(
              e.text,
              config.needs,
              async (text, labels) => (await $.model.classify(text, labels)) ?? '',
              (ms) => $.clock.sleep(ms),
            )
          : []
      const { actions } = await apply($, () => ({ type: 'prompt', now: now(), text: e.text, fromUser, matched }))
      return actions.flatMap((a) => (a.kind === 'context' ? [a.text] : []))
    })
    return texts.length ? next({ ...e, context: [...(e.context ?? []), ...texts] }) : next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const text = await safe($, 'prompt.compose', undefined as string | undefined, async () => {
      const { config } = await getLoaded($)
      const always = Object.entries(config.skills)
        .filter(([, rule]) => rule.always === true)
        .map(([name]) => name)
      return `${RULE}${always.length ? ` Always-on skills: ${always.join(', ')}.` : ''}`
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
        ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
        root: l.root,
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
        await safe($, 'tool.call', undefined, async () => {
          await apply($, () => ({ type: 'agentDone', now: now() }))
        })
      }
    }
    const extra = actions.flatMap((a) => (a.kind === 'toolContext' ? [a.text] : []))
    if (!extra.length || r.deny !== undefined) return r
    return { ...r, context: [...(r.context ?? []), ...extra] }
  }).catch(($, e, next) => next(e))

  on('command.run', async ($, e, next) => {
    if (e.command === 'souffleur') {
      const verb0 = (e.args ?? '').trim().split(/\s+/)[0]
      if (verb0 === 'init' || verb0 === 'migrate') {
        const text = await safe($, 'command.run', undefined as string | undefined, async () => {
          const { l } = await current($)
          return verb0 === 'init' ? runInit($, l) : runMigrate($, l)
        })
        if (text !== undefined) return { text }
        return next(e)
      }
      const reply = await safe($, 'command.run', undefined as string | undefined, async () => {
        const { actions, l } = await apply($, () => ({ type: 'command', now: now(), args: e.args ?? '' }))
        const text = actions.flatMap((a) => (a.kind === 'reply' ? [a.text] : []))[0]
        const verb = (e.args ?? '').trim().split(/\s+/)[0] ?? ''
        const note = '\n\nSouffleur is not set up: there is no ~/.claude/souffleur.json. Run /souffleur init to add one.'
        return text !== undefined && !l.setUp && (verb === '' || verb === 'status') ? `${text}${note}` : text
      })
      if (reply !== undefined) return { text: reply }
      return next(e)
    }
    await safe($, 'command.run', undefined, async () => {
      await apply($, () => ({ type: 'typed', now: now(), name: e.command }))
    })
    return next(e)
  }).catch(($, e, next) => next(e))
}
