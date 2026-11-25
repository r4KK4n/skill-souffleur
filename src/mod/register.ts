import type { Register } from 'claude-code'
import { parseConfig } from '../core/config.ts'
import { decide, initSession } from '../core/decide.ts'
import {
  NOT_SET_UP,
  describeHook,
  describeProposal,
  findHookOverlaps,
  findPassages,
  hookSteps,
  initSteps,
  mergeUserConfig,
  parseSkillProposals,
  proposalPrompt,
  removeHook,
} from '../core/init.ts'
import type { HookOverlap, Passage, SkillProposal } from '../core/init.ts'
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

/**
 * `/souffleur init`. Reads settings hooks, CLAUDE.md files and the memory index (never writes them, apart from
 * removing one hook entry from settings.json after a backup), asks one dialog per item, and merges skill
 * entries into the user config. Where no dialog answers, it returns the proposals and steps and writes nothing.
 */
async function runInit($: Dollar, l: Loaded): Promise<string> {
  const notes: string[] = []
  const home: string | undefined = await $.env.get('HOME')
  if (!home) return 'Souffleur init: the home folder is unknown, so nothing was changed.'
  const configPath = `${home}/.claude/souffleur.json`
  const settingsPath = `${home}/.claude/settings.json`
  const shown = (path: string) => (path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path)

  const settingsText = await readOptional($, settingsPath, notes)
  let settings: unknown
  if (settingsText !== undefined) {
    try {
      settings = JSON.parse(settingsText)
    } catch {
      notes.push(`${shown(settingsPath)} is not valid JSON, so its hooks were not checked.`)
    }
  }
  const slug = l.root.replace(/[^A-Za-z0-9]/g, '-')
  const sources = [`${home}/.claude/CLAUDE.md`, `${l.root}/CLAUDE.md`, `${home}/.claude/projects/${slug}/memory/MEMORY.md`]
  const files: { file: string; text: string }[] = []
  for (const path of sources) {
    const text = await readOptional($, path, notes)
    if (text !== undefined) files.push({ file: shown(path), text })
  }

  const installed = await installedSkills($)
  const configured = Object.keys(l.config.skills)
  const known = [...new Set([...installed, ...configured])]
  const passages: Passage[] = findPassages(files, known)
  const hooks: HookOverlap[] = findHookOverlaps(settings, known)

  let proposals: SkillProposal[] = []
  const candidates = installed.filter((name) => !configured.includes(name))
  if (candidates.length) {
    try {
      const r = await $.model.complete({ model: 'haiku', prompt: proposalPrompt(candidates, passages, configured) })
      if (r.isAnswered) proposals = parseSkillProposals(r.text, candidates)
      else notes.push('The small model gave no answer, so no skill entries are proposed.')
    } catch (err) {
      notes.push(`The small model failed (${message(err)}), so no skill entries are proposed.`)
    }
  }

  const noDialog = () => `${initSteps({ proposals, hooks, passages, configPath: shown(configPath), settingsPath: shown(settingsPath) })}${notes.length ? `\n\nNotes:\n${notes.map((n) => `- ${n}`).join('\n')}` : ''}`
  const done: string[] = []
  const manual: string[] = []
  let asked = false
  let backedUp = false
  const ask = async (question: string, options: string[]): Promise<string> => {
    const answer: string = await $.ui.ask(question, { options, header: 'Souffleur' })
    asked = true
    return answer
  }

  try {
    for (const p of proposals) {
      const answer = await ask(`Add ${describeProposal(p)} to ${shown(configPath)}?`, ['Add', 'Skip', 'Stop'])
      if (answer === 'Stop') break
      if (answer !== 'Add') continue
      const merged = mergeUserConfig(await readOptional($, configPath, notes), [p])
      if ('error' in merged) done.push(`Not added: ${p.name} (${merged.error}).`)
      else if (!merged.added.length) done.push(`Already configured: ${p.name}.`)
      else {
        await $.fs.write(configPath, merged.text)
        done.push(`Added ${p.name} to ${shown(configPath)}.`)
      }
    }
    for (const o of hooks) {
      const answer = await ask(`Turn off the ${describeHook(o)} hook? Souffleur now does this.`, ['Turn off', 'Keep', 'Show me what to do', 'Stop'])
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
  if (!asked && !done.length) {
    if (proposals.length || hooks.length) return noDialog()
    done.push('Nothing to propose: no new skill entries and no overlapping hooks.')
  }

  const out = ['Souffleur init', '', ...done.map((d) => `- ${d}`)]
  if (manual.length) out.push('', 'To do by hand:', ...manual.map((m) => `- ${m}`))
  if (passages.length) out.push('', 'Standing instructions that name a skill (Souffleur never edits these):', ...passages.map((x) => `- ${x.file}:${x.line} ${x.text}`))
  if (notes.length) out.push('', 'Notes:', ...notes.map((n) => `- ${n}`))
  if (done.some((d) => d.startsWith('Added'))) out.push('', 'New entries apply from the next session start. The default mode is observe: nothing is blocked until you set "mode": "enforce" in the user file.')
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
      await $.command.register({ name: 'souffleur', description: 'Show which skills Souffleur keeps loaded' })
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
      if ((e.args ?? '').trim().split(/\s+/)[0] === 'init') {
        const text = await safe($, 'command.run', undefined as string | undefined, async () => runInit($, (await current($)).l))
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
