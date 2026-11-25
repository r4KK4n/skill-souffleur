import type { Register } from 'claude-code'
import { parseConfig } from '../core/config.ts'
import { decide, initSession } from '../core/decide.ts'
import { MIGRATE_INTRO, describeHook, findHookOverlaps, findPassages, hookSteps, migrateSteps, removeHook } from '../core/migrate.ts'
import type { HookOverlap, Passage } from '../core/migrate.ts'
import { CHOICE_LABEL, NOT_SET_UP, SETUP_INTRO, applyChoice, candidates, choiceOf, currentChoice, describePlan, options, parsePicks, picksPrompt, setupSteps } from '../core/setup.ts'
import type { LoadChoice, NeedText, Plan, Suggestion } from '../core/setup.ts'
import type { Action, CoreEvent, Session } from '../core/decide.ts'
import { classifyPrompt } from '../core/needs.ts'
import { statusLine } from '../core/status.ts'
import type { Config } from '../core/types.ts'
import { isFromUser, toolFields } from './map.ts'

// The hooks' `$` is the engine interface; the adapter calls only documented members.
type Dollar = any
type Loaded = { config: Config; errors: string[]; root: string; setUp: boolean }

const REF = { plugin: 'skill-souffleur', key: 'session' } as const
const RULE =
  'Souffleur keeps track of skills in this session. If a message from Souffleur asks you to load skills, invoke each one with the Skill tool before you continue.'

// Module variables start over on a reload; the config is read again by `session.start`, which a reload runs.
let loaded: Loaded | undefined

const now = () => Date.now()
const message = (err: unknown) => (err instanceof Error ? err.message : String(err))

async function readOptional($: Dollar, path: string, errors: string[]): Promise<string | undefined> {
  try {
    if (!(await $.fs.exists(path))) return undefined
    return await $.fs.read(path)
  } catch (err) {
    errors.push(`cannot read ${path}: ${message(err)}`)
    return undefined
  }
}

async function getLoaded($: Dollar): Promise<Loaded> {
  if (loaded) return loaded
  const errors: string[] = []
  const home = await $.env.get('HOME')
  const root = (await $.session.repo())?.root ?? (await $.session.cwd())
  const userText = home ? await readOptional($, `${home}/.claude/souffleur.json`, errors) : undefined
  const projectText = await readOptional($, `${root}/.claude/souffleur.json`, errors)
  const parsed = parseConfig(userText, projectText)
  loaded = { config: parsed.config, errors: [...errors, ...parsed.errors], root, setUp: userText !== undefined }
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
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 16).replace(':', '')}`
}

const shownPath = (home: string, path: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

/** `~/.claude/settings.json` as a value; undefined when it is missing or broken (a note says which). */
async function readSettings($: Dollar, path: string, shown: string, notes: string[]): Promise<{ text?: string; value?: unknown }> {
  const text = await readOptional($, path, notes)
  if (text === undefined) return {}
  try {
    return { text, value: JSON.parse(text) }
  } catch {
    notes.push(`${shown} is not valid JSON, so its hooks were not checked.`)
    return { text }
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

const bareName = (skill: string) => (skill.split(':').pop() ?? skill).replace(/[^A-Za-z0-9:_-]/g, '-')

/**
 * `/souffleur init`: asks per skill how it is kept and writes each answer to the user file as it comes.
 * It reads settings only to see which skills a hook reloads, and writes nothing else. Where no dialog
 * answers, it returns the recommendations and the config they give, and writes nothing.
 */
async function runInit($: Dollar, l: Loaded): Promise<string> {
  const notes: string[] = []
  const home: string | undefined = await $.env.get('HOME')
  if (!home) return 'Souffleur init: the home folder is unknown, so nothing was changed.'
  const configPath = `${home}/.claude/souffleur.json`
  const settingsPath = `${home}/.claude/settings.json`
  const shown = (path: string) => shownPath(home, path)

  const userText = await readOptional($, configPath, notes)
  let userDoc: unknown
  if (userText !== undefined) {
    try {
      userDoc = JSON.parse(userText)
    } catch (err) {
      return `Souffleur init: ${shown(configPath)} is not valid JSON (${message(err)}), so nothing was changed. Fix the file and run /souffleur init again.`
    }
  }
  const settings = (await readSettings($, settingsPath, shown(settingsPath), notes)).value
  const described = await installedWithDescriptions($)
  const installed = described.map((x) => x.name)
  const configured = Object.keys(l.config.skills)
  const hooks = findHookOverlaps(settings, [...new Set([...installed, ...configured])])
  const reloadHooked = [...new Set(hooks.flatMap((o) => (o.skill !== undefined ? [o.skill] : [])))]

  // One small-model call over the installed skills nobody has configured yet.
  const pool = described.filter((x) => !configured.includes(x.name) && !reloadHooked.includes(x.name))
  let picks: Suggestion[] = []
  if (pool.length) {
    try {
      const r = await $.model.complete({ model: 'haiku', prompt: picksPrompt(pool, l.config.needs) })
      if (r.isAnswered) picks = parsePicks(r.text, pool.map((x) => x.name), l.config.needs)
      else notes.push('The small model gave no answer, so no further skills are proposed.')
    } catch (err) {
      notes.push(`The small model failed (${message(err)}), so no further skills are proposed.`)
    }
  }

  const plans: Plan[] = candidates(l.config, installed, reloadHooked, picks.map((x) => x.skill)).map(({ skill, source }) => {
    const rule = l.config.skills[skill]
    const current = currentChoice(rule)
    const pick = picks.find((x) => x.skill === skill)
    if (source === 'hook') return { skill, source, recommended: 'start' }
    if (source === 'model') return { skill, source, recommended: 'need', ...(pick ? { need: pick.need } : {}) }
    return { skill, source, ...(current === undefined ? {} : { current }), recommended: current ?? 'need' }
  })
  const watched = new Set(plans.map((p) => p.skill))
  const unwatched = installed.filter((name) => !watched.has(name))
  const toAsk = plans.filter((p) => p.source !== 'project')

  const noDialog = () =>
    `${setupSteps({ plans, userConfig: userDoc, configPath: shown(configPath), unwatched })}${notes.length ? `\n\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}` : ''}`
  const done: string[] = []
  let asked = false
  const needOf = (p: Plan): NeedText | undefined => {
    if (p.need) return p.need
    const key = l.config.skills[p.skill]?.need
    const text = key === undefined ? undefined : l.config.needs[key]
    return key !== undefined && text !== undefined ? { key, text } : undefined
  }

  try {
    for (const p of toAsk) {
      const proposed = needOf(p)
      const lines = [
        `${p.skill}: ${describePlan(p).slice(p.skill.length + 2)}.`,
        ...(proposed ? [`Description for "When the task needs it": ${proposed.text} Text typed under Other replaces it.`] : ['Text typed under Other becomes the description for "When the task needs it".']),
        ...(p.skill.includes(':') ? ['Injected by its plugin fits plugins that put their own text in at session start.'] : []),
        'How should Souffleur keep it?',
      ]
      const question = `${asked ? '' : `${SETUP_INTRO}\n\n`}${lines.join(' ')}`
      const answer: string = await $.ui.ask(question, { options: options(p.skill, p.current, p.recommended), header: 'Souffleur' })
      asked = true
      const picked = choiceOf(answer)
      if (picked === 'stop') break
      const choice: LoadChoice = picked ?? 'need'
      const need: NeedText | undefined = picked === undefined ? { key: proposed?.key ?? bareName(p.skill), text: answer.trim() } : choice === 'need' ? proposed : undefined
      // Read again: the file may have changed since the scan, and earlier answers are already in it.
      const text = await readOptional($, configPath, notes)
      const doc: unknown = text === undefined ? undefined : JSON.parse(text)
      const r = applyChoice(doc, p.skill, choice, need)
      if (r.note) done.push(r.note)
      const same = text !== undefined && JSON.stringify(r.config) === JSON.stringify(doc)
      if (same || (text === undefined && choice === 'none')) {
        if (!r.note) done.push(`${p.skill}: ${choice === 'none' ? 'not watched' : CHOICE_LABEL[choice]} (no change).`)
        continue
      }
      await $.fs.write(configPath, `${JSON.stringify(r.config, null, 2)}\n`)
      done.push(`${p.skill}: ${choice === 'none' ? 'not watched any more' : CHOICE_LABEL[choice]}.`)
    }
  } catch (err) {
    if (!asked) return noDialog()
    done.push(`Stopped early: ${message(err)}. Answers given so far are kept.`)
  }
  if (!asked && toAsk.length && !done.length) return noDialog()

  const out = ['Souffleur init', '', ...(done.length ? done.map((d) => `- ${d}`) : ['- Nothing to ask: no skill is configured yet and none looks worth watching.'])]
  const project = plans.filter((p) => p.source === 'project')
  if (project.length) out.push('', `Set only in the project file, so init leaves ${project.length === 1 ? 'it' : 'them'} alone: ${project.map((p) => p.skill).join(', ')}.`)
  if (unwatched.length) out.push('', `Installed and not watched: ${unwatched.slice(0, 30).join(', ')}${unwatched.length > 30 ? `, and ${unwatched.length - 30} more` : ''}.`)
  if (hooks.length) out.push('', `Found ${hooks.length} hook${hooks.length === 1 ? '' : 's'} in your settings that may do the same job. /souffleur migrate goes through ${hooks.length === 1 ? 'it' : 'them'} with you.`)
  if (notes.length) out.push('', 'Notes:', ...notes.map((n) => `- ${n}`))
  if (done.some((d) => !d.includes('(no change)') && !d.startsWith('Stopped'))) out.push('', 'New entries apply from the next session start. The default mode is observe: nothing is blocked until you set "mode": "enforce" in the user file.')
  return out.join('\n')
}

/**
 * `/souffleur migrate`: goes through hooks in settings.json that do what Souffleur does, one dialog each.
 * `Turn off` copies settings.json first and removes only that entry. Scripts, CLAUDE.md and memory are never edited.
 */
async function runMigrate($: Dollar, l: Loaded): Promise<string> {
  const notes: string[] = []
  const home: string | undefined = await $.env.get('HOME')
  if (!home) return 'Souffleur migrate: the home folder is unknown, so nothing was changed.'
  const settingsPath = `${home}/.claude/settings.json`
  const shown = (path: string) => shownPath(home, path)
  const settings = (await readSettings($, settingsPath, shown(settingsPath), notes)).value

  const slug = l.root.replace(/[^A-Za-z0-9]/g, '-')
  const sources = [`${home}/.claude/CLAUDE.md`, `${l.root}/CLAUDE.md`, `${home}/.claude/projects/${slug}/memory/MEMORY.md`]
  const files: { file: string; text: string }[] = []
  for (const path of sources) {
    const text = await readOptional($, path, notes)
    if (text !== undefined) files.push({ file: shown(path), text })
  }
  const configured = Object.keys(l.config.skills)
  const known = [...new Set([...(await installedSkills($)), ...configured])]
  const passages: Passage[] = findPassages(files, configured)
  const hooks: HookOverlap[] = findHookOverlaps(settings, known)

  const noDialog = () => `${migrateSteps({ hooks, passages, settingsPath: shown(settingsPath) })}${notes.length ? `\n\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}` : ''}`
  const done: string[] = []
  const manual: string[] = []
  let asked = false
  let backedUp = false
  try {
    for (const o of hooks) {
      const question = `${asked ? '' : `${MIGRATE_INTRO}\n\n`}Turn off the ${describeHook(o)} hook? Souffleur now does this job.`
      const answer: string = await $.ui.ask(question, { options: ['Turn off', 'Keep', 'Show me what to do', 'Stop'], header: 'Souffleur' })
      asked = true
      if (answer === 'Stop') break
      if (answer === 'Show me what to do') manual.push(hookSteps(o, shown(settingsPath)))
      if (answer !== 'Turn off') continue
      // Read again: an earlier removal moved the indexes, and the file may have changed since the scan.
      const text = await $.fs.read(settingsPath)
      const current: unknown = JSON.parse(text)
      const target = findHookOverlaps(current, known).find((x) => x.event === o.event && x.matcher === o.matcher && x.command === o.command)
      if (!target) {
        done.push(`Already gone: ${o.event} hook ${o.command}.`)
        continue
      }
      if (!backedUp) {
        const backup = `${settingsPath}.bak-souffleur-${stamp(now())}`
        await $.fs.write(backup, text)
        backedUp = true
        done.push(`Copied settings to ${shown(backup)}.`)
      }
      await $.fs.write(settingsPath, `${JSON.stringify(removeHook(current, target), null, 2)}\n`)
      done.push(`Turned off the ${o.event} hook ${o.command}.`)
    }
  } catch (err) {
    if (!asked) return noDialog()
    done.push(`Stopped early: ${message(err)}.`)
  }
  if (!asked && hooks.length && !done.length) return noDialog()

  const out = [MIGRATE_INTRO, '', ...(done.length ? done.map((d) => `- ${d}`) : ['- Nothing to migrate: no overlapping hooks.'])]
  if (manual.length) out.push('', 'To do by hand:', ...manual.map((m) => `- ${m}`))
  if (passages.length) out.push('', 'Standing instructions that name a configured skill (Souffleur never edits these):', ...passages.map((x) => `- ${x.file}:${x.line} ${x.text}`))
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
