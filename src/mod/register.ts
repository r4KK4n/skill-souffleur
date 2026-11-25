import type { Register } from 'claude-code'
import { parseConfig } from '../core/config.ts'
import { decide, initSession } from '../core/decide.ts'
import type { Action, CoreEvent, Session } from '../core/decide.ts'
import { classifyPrompt } from '../core/needs.ts'
import { statusLine } from '../core/status.ts'
import type { Config } from '../core/types.ts'
import { isFromUser, toolFields } from './map.ts'

// The hooks' `$` is the engine interface; the adapter calls only documented members.
type Dollar = any
type Loaded = { config: Config; errors: string[]; root: string }

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
  loaded = { config: parsed.config, errors: [...errors, ...parsed.errors], root }
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

async function persist($: Dollar, config: Config, s: Session): Promise<void> {
  $.ui.status(statusLine(s, config.mode))
  await $.state.set(REF, s)
  await $.store.set(`session:${s.id}`, s)
}

/** Feeds one event to the core and stores the result. */
async function apply($: Dollar, make: (l: Loaded) => CoreEvent): Promise<{ actions: Action[]; l: Loaded }> {
  const { l, session } = await current($)
  const r = decide(l.config, session, make(l))
  await persist($, l.config, r.session)
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
      await persist($, l.config, s)
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
      const reply = await safe($, 'command.run', undefined as string | undefined, async () => {
        const { actions } = await apply($, () => ({ type: 'command', now: now(), args: e.args ?? '' }))
        return actions.flatMap((a) => (a.kind === 'reply' ? [a.text] : []))[0]
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
