import { expect, mock, test } from 'claude-code/testing'
import { PLUGIN_VERSION } from './version.ts'
import type { On } from 'claude-code'
import { decide, initSession } from '../core/decide.ts'
import { parseConfig } from '../core/config.ts'
import { clip } from '../core/needs.ts'
import { makeProposal } from '../core/proposals.ts'
import { hashKey, skillHash } from '../core/learn.ts'

/** The fake clock of the world the running test built; `settle` flushes work the mod left detached. */
let fakeClock: { settle: () => Promise<void>; advance: (ms: number) => Promise<void> }
/** The fake clock starts here: stored times in the tests are relative to it, never to the system clock. */
const T0 = 1_800_000_000_000
const HOME = '/users/test'
const USER_FILE = `${HOME}/.claude/souffleur.json`
const PROJECT_FILE = '/work/proj/.claude/souffleur.json'

type World = {
  statuses: (string | undefined)[]
  setId: (id: string) => void
  seen: { prompts: { text: string; context?: readonly string[] }[] }
  writes: { path: string; text: string }[]
  asked: string[]
  options: string[][]
  clock: { advance: (ms: number) => Promise<void> }
  hide: (path: string) => void
  files: Record<string, string>
  tools: { name: string }[]
  toasts: string[]
  failRead: string[]
  /** Answers a later dialog gives. */
  answers: string[]
  /** After `n` more reads of `path` its text changes under the reader. */
  driftAfter: (path: string, n: number, forever?: boolean) => void
  /** A hand edit or another writer: sets the file and moves its mtime. */
  edit: (path: string, text: string) => void
  /** The writes to `<path>.tmp-<time>-<random>`, which `writes` leaves out. */
  tmpWrites: { path: string; text: string }[]
  stored: Record<string, unknown>
  /** The keys written with `$.store.set`, in order. */
  storeSets: string[]
  /** How many classifier calls the mod made. */
  classifyCalls: () => number
  /** The lines written with `$.ui.log` (transcript). */
  logs: string[]
  /** Every `$.process.run` call: its argv and timeout. */
  runs: { argv: readonly string[]; timeoutMs?: number }[]
  /** The lines written with `$.ui.log(..., { to: 'debug' })`. */
  debugLogs: string[]
  /** From now on `$.tool.list` does not show the propose tool, as after a disconnect. */
  dropTool: () => void
}

type Opts = {
  classify?: string | ((labels?: readonly string[]) => string)
  stored?: Record<string, unknown>
  skipCompact?: boolean
  /** Installed skill names `$.session.usage` lists. */
  skills?: string[]
  /** Installed skills whose source is the project (`projectSettings`). */
  projectSkills?: string[]
  /** What the small model answers to the init prompt. */
  proposals?: string
  /** The labels the user picks, in order; 'reject' makes every dialog reject, as in a `-p` run. */
  answers?: string[] | 'reject'
  /** Paths that exist but whose read throws, as a permission error would. */
  failRead?: string[]
  /** Writes to a path that matches throw. */
  failWrite?: RegExp
  /** `mkdir` of the update lock folder always fails, as when another session wins the race. */
  holdLock?: boolean
  /** Every `mkdir` fails and makes nothing, as on a host without it. */
  noMkdir?: boolean
  /** The first `mkdir` of the user file lock fails although no folder is there, as when a holder released in between. */
  mkdirFailsOnce?: boolean
  /** Modification times `$.fs.stat` reports for folders. */
  dirMtime?: Record<string, number>
  /** `$.env.get('HOME')` answers nothing. */
  noHome?: boolean
  /** `$.fs.exists` throws for these paths. */
  failExists?: string[]
  /** Other variables `$.env.get` answers by name, such as `CLAUDE_CONFIG_DIR` or `USERPROFILE`. */
  env?: Record<string, string>
  /** `mv -f` exits 1 and moves nothing. */
  failMv?: boolean
  /** `$.fs.stat(path, { resolve: true })` says the path is a symlink to this target. */
  linkTo?: Record<string, string>
  /** Runs after each successful write, with its path. */
  onWrite?: (path: string) => void
  /** The skill listing is empty and `$.command.list` names these. */
  listOnly?: string[]
  /** The skill listing says it holds fewer skills than there are. */
  incomplete?: boolean
  /** `$.session.usage` never answers. */
  hangUsage?: boolean
  /** `$.session.usage` rejects. */
  failUsage?: boolean
  /** Runs when a dialog opens. */
  onAsk?: () => void
  /** The main repository root `$.session.repo` answers. */
  repoRoot?: string
  /** `$.tool.register` rejects. */
  failToolRegister?: boolean
  /** What the small model answers to `/souffleur rule`. */
  shaped?: string
  /** What the small model answers when it reads a skill text; sees the prompt. Records every call in `skillCalls`. */
  skillAnswer?: (prompt: string) => string | null | Promise<string | null>
  skillCalls?: string[]
  /** The whole request of every skill read. */
  skillRequests?: Record<string, unknown>[]
  /** `$.tool.list` never shows the tool, throws, answers a non-array, or never answers. */
  listMode?: 'hidden' | 'throws' | 'junk' | 'hangs'
  /** `$.ui.log` throws. */
  failLog?: boolean
  /** The usage every answered `$.model.complete` returns. */
  usage?: Record<string, number>
  /** Every classifier request (call A and B). */
  classifyRequests?: Record<string, unknown>[]
  /** The classifier answers only after this resolves (a late answer). */
  holdClassify?: Promise<void>
  /** The classifier call comes back not answered. */
  classifyRejected?: boolean
  /** `$.store.set` of this key throws. */
  failStoreKey?: string
  /** True while `$.clock.now()` should throw. */
  clockDown?: () => boolean
  /** The working directory `$.session.cwd` answers. */
  cwd?: string
  /** `$.fs.stat` of these paths throws something other than not-found. */
  failStat?: string[]
  /** `$.store.keys` answers only after this resolves, as a slow store does. */
  holdKeys?: Promise<void>
  /** `$.store.keys` rejects. */
  failKeys?: boolean
  /** `$.store.set` of the total waits for this. */
  holdTotal?: Promise<void>
  /** An Agent tool call stays open until this resolves, as a running subagent keeps it open. */
  holdAgent?: Promise<void>
  /** A dialog never answers and never rejects, as in a session whose client does not show it. */
  holdAsk?: boolean | Promise<string>
  /** Only the first dialog is held until this resolves; later dialogs take `answers`. */
  holdFirstAsk?: Promise<string>
  /** The first dialogs are held, one promise each, in order; later dialogs take `answers`. */
  holdQueue?: Promise<string>[]
  /** What `$.process.run` answers; sees the argv. Absent: every run exits 0 with no output. */
  run?: (argv: readonly string[], init?: { timeoutMs?: number }) => { exitCode: number; stdout: string; stderr: string } | Promise<{ exitCode: number; stdout: string; stderr: string }> | Error
}

/** Answers every call the mod makes on `$`; files maps an absolute path to its text, a missing path throws. */
const registeredCommands: unknown[] = []

function world(on: On, files: Record<string, string>, opts: Opts = {}): World {
  let id = 's1'
  const statuses: (string | undefined)[] = []
  const seen: World['seen'] = { prompts: [] }
  const writes: World['writes'] = []
  const asked: string[] = []
  let firstHeld = false
  const hidden = new Set<string>()
  const answers = opts.answers === 'reject' ? [] : [...(opts.answers ?? [])]
  const storeData: Record<string, unknown> = opts.stored ?? {}
  const storeSets: string[] = []
  on('store.get', (_, e) => ({ value: storeData[e.key] === undefined ? undefined : JSON.parse(JSON.stringify(storeData[e.key])) }) as never)
  on('store.set', (_, e) => {
    storeSets.push(e.key)
    if (opts.failStoreKey === e.key) throw new Error('disk full')
    if (opts.holdTotal && e.key === 'modelUseTotal') return opts.holdTotal.then(() => { storeData[e.key] = JSON.parse(JSON.stringify(e.value)); return { value: undefined } as never })
    storeData[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined } as never
  })
  on('store.delete', (_, e) => {
    delete storeData[e.key]
    return { value: undefined } as never
  })
  // `opts.clockDown()` true makes `$.clock.now()` throw, as an older or broken host would.
  const clock = mock.clock(((event: string, ...rest: unknown[]) => (event === 'clock.now' ? undefined : (on as any)(event, ...rest))) as typeof on, { now: T0 })
  on('clock.now', () => {
    if (opts.clockDown?.()) throw new Error('clock gone')
    return { value: clock.now() } as never
  })
  fakeClock = clock
  mock.session(on)
  const options: string[][] = []
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: opts.cwd ?? '/work/proj' }))
  on('session.repo', () => ({ value: opts.repoRoot ? { root: opts.repoRoot, remote: null, internal: false, name: null } : null }))
  const tools: { name: string }[] = []
  const failRead: string[] = []
  const drift = { path: '', left: -1, forever: false, count: 0 }
  const mtimes: Record<string, number> = {}
  let tick = 0
  const tmpWrites: World['tmpWrites'] = []
  const put = (path: string, text: string) => {
    files[path] = text
    mtimes[path] = ++tick
  }
  const toasts: string[] = []
  on('tool.register', (_, e) => {
    if (opts.failToolRegister) throw new Error('refused')
    toolGone = false
    tools.push(e as { name: string })
    return { value: { tool: `mcp__skill-souffleur__${e.name}` } } as never
  })
  let toolGone = false
  const logs: string[] = []
  const debugLogs: string[] = []
  on('tool.list', () => {
    if (opts.listMode === 'throws') throw new Error('list failed')
    if (opts.listMode === 'junk') return { value: 'nope' } as never
    if (opts.listMode === 'hangs') return new Promise(() => {}) as never
    if (opts.listMode === 'hidden') return { value: [] } as never
    return { value: toolGone ? [] : tools.map((t) => ({ name: `mcp__skill-souffleur__${t.name}`, description: '', mcp: true })) } as never
  })
  on('ui.log', (_, e) => {
    if (opts.failLog) throw new Error('no transcript here')
    if ((e as { to?: string }).to === 'debug') {
      debugLogs.push(e.text)
      return { value: undefined } as never
    }
    logs.push(e.text)
    return { value: undefined } as never
  })
  const runs: World['runs'] = []
  const dirs = new Set<string>()
  on('process.run', (_, e) => {
    const init = (e as { init?: { timeoutMs?: number } }).init
    runs.push({ argv: e.argv, ...(init?.timeoutMs === undefined ? {} : { timeoutMs: init.timeoutMs }) })
    if (e.argv[0] === 'mv' && e.argv[1] === '-f') {
      if (opts.failMv || files[e.argv[2]!] === undefined) return { value: { exitCode: 1, stdout: '', stderr: 'mv: failed' } } as never
      const text = files[e.argv[2]!]!
      delete files[e.argv[2]!]
      put(e.argv[3]!, text)
      writes.push({ path: e.argv[3]!, text })
      opts.onWrite?.(e.argv[3]!)
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    }
    if (e.argv[0] === 'mkdir') {
      const dir = e.argv[e.argv.length - 1]!
      if (opts.mkdirFailsOnce && dir.endsWith('/user-file.lock')) { opts.mkdirFailsOnce = false; return { value: { exitCode: 1, stdout: '', stderr: 'mkdir: File exists' } } as never }
      if (opts.noMkdir) return { value: { exitCode: 127, stdout: '', stderr: 'mkdir: not found' } } as never
      if (e.argv[1] === '-p') { dirs.add(dir); return { value: { exitCode: 0, stdout: '', stderr: '' } } as never }
      if (opts.holdLock && dir.endsWith('/update.lock')) return { value: { exitCode: 1, stdout: '', stderr: 'mkdir: File exists' } } as never
      if (dirs.has(dir) || Object.keys(files).some((f) => f.startsWith(`${dir}/`))) return { value: { exitCode: 1, stdout: '', stderr: 'mkdir: File exists' } } as never
      dirs.add(dir)
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    }
    if (e.argv[0] === 'rm' && e.argv[1] === '-rf') {
      const dir = e.argv[2]!
      dirs.delete(dir)
      for (const f of Object.keys(files)) if (f.startsWith(`${dir}/`)) delete files[f]
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    }
    if (e.argv[0] === 'rm' && e.argv[1] === '-f') {
      for (const f of e.argv.slice(2)) delete files[f]
      return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
    }
    const out = opts.run ? opts.run(e.argv, init) : { exitCode: 0, stdout: '', stderr: '' }
    if (out instanceof Error) return { deny: out.message } as never
    return (out instanceof Promise ? out.then((value) => ({ value })) : { value: out }) as never
  })
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined } as never
  })
  on('session.version', () => ({ value: { version: '2.1.332' } }))
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? (opts.noHome ? undefined : HOME) : opts.env?.[e.name] }))
  on('process.hookEnv', () => ({ value: { CLAUDE_PLUGIN_DATA: '/data/souffleur' } }))
  on('fs.exists', (_, e) => {
    if (opts.failExists?.includes(e.path)) throw new Error('EIO: i/o error')
    return { value: files[e.path] !== undefined && !hidden.has(e.path) }
  })
  on('fs.read', (_, e) => {
    if (failRead.includes(e.path) || opts.failRead?.includes(e.path)) throw new Error('EACCES: permission denied')
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    if (e.path === drift.path && drift.left-- < 0) return { value: drift.forever ? `${text}${' '.repeat(++drift.count)}` : `${text} ` }
    return { value: text }
  })
  let classifyCalls = 0
  on('store.keys', () => {
    if (opts.failKeys) throw new Error('store gone')
    const keys = () => ({ value: Object.keys(storeData) }) as never
    return opts.holdKeys ? opts.holdKeys.then(keys) : keys()
  })
  on('ui.status', (_, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  on('command.register', (_$, e) => { registeredCommands.push(e); return { value: { command: 'souffleur' } } })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => {
    seen.prompts.push({ text: e.text, ...(e.context ? { context: e.context } : {}) })
    return { text: e.text, ...(e.context ? { context: e.context } : {}) }
  })
  on('fs.write', (_, e) => {
    if (opts.failWrite?.test(e.path)) throw new Error('ENOSPC: no space left')
    if (/\.tmp-/.test(e.path)) tmpWrites.push({ path: e.path, text: e.text })
    else if (!e.path.endsWith('/user-file.lock/owner')) writes.push({ path: e.path, text: e.text }) // the lock stamp is not a config write
    put(e.path, e.text)
    opts.onWrite?.(e.path)
    return { value: undefined }
  })
  on('fs.stat', (_, e) => {
    const text = files[e.path]
    if (opts.failStat?.includes(e.path)) throw new Error('EIO: i/o error')
    if (text === undefined && (dirs.has(e.path) || Object.keys(files).some((f) => f.startsWith(`${e.path}/`)))) {
      const m = opts.dirMtime?.[e.path]
      return { value: { kind: 'dir', size: 0, ...(m === undefined ? {} : { mtimeMs: m }), isLink: false } } as never
    }
    if (text === undefined || hidden.has(e.path)) throw new Error(`stat ${e.path} failed: ENOENT`)
    const real = opts.linkTo?.[e.path]
    return { value: { kind: 'file', size: text.length, mtimeMs: mtimes[e.path] ?? 0, isLink: real !== undefined, ...(real === undefined ? {} : { realPath: real }) } } as never
  })
  on('fs.list', (_, e) => {
    const dir = (e as { path?: string }).path ?? ''
    return { value: Object.keys(files).filter((f) => f.slice(0, f.lastIndexOf('/')) === dir).map((f) => ({ name: f.slice(f.lastIndexOf('/') + 1), kind: 'file', size: files[f]!.length, mtimeMs: mtimes[f] ?? 0, isLink: false })) } as never
  })
  if (opts.listOnly) on('command.list', () => ({ value: opts.listOnly!.map((name) => ({ name, description: '' })) }) as never)
  on('session.usage', () => {
    if (opts.hangUsage) return new Promise(() => {}) as never
    if (opts.failUsage) throw new Error('usage unavailable')
    const projectNames = opts.listOnly ? [] : (opts.projectSkills ?? [])
    const names = opts.listOnly ? [] : [...(opts.skills ?? []), ...projectNames]
    return {
      value: {
        startedAt: 0,
        context: { window: 1, breakdown: { skills: { totalSkills: names.length + (opts.incomplete ? 1 : 0), includedSkills: names.length, tokens: 0, skillFrontmatter: names.map((name) => ({ name, source: projectNames.includes(name) ? 'projectSettings' : 'plugin', tokens: 1 })) } } },
        rateLimits: [],
        cost: {},
      },
    } as never
  })
  on('model.complete', (_, e) => {
    const call = e as { system?: string; prompt?: string; maxTokens?: number; model?: string }
    if (/^Labels: /.test(call.prompt ?? '')) {
      classifyCalls += 1
      opts.classifyRequests?.push(e as Record<string, unknown>)
      const labels = call.prompt!.split('\n')[0]!.slice('Labels: '.length).split(', ')
      const raw = typeof opts.classify === 'function' ? opts.classify(labels) : (opts.classify ?? 'no-match')
      // 'match' / 'no-match' stand for the old per-need answers: A answers code work, B picks the first need.
      const text = raw !== 'match' && raw !== 'no-match' ? raw : labels.includes('chat-reply') ? (raw === 'match' ? 'code-or-repo-work' : 'chat-reply') : raw === 'match' ? labels[0]! : 'none'
      const answer = () => ({ value: opts.classifyRejected ? { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage: {} } : { isAnswered: true, text, usage: opts.usage ?? {} } }) as never
      return opts.holdClassify ? opts.holdClassify.then(answer) : answer()
    }
    if (/checkable obligations/.test(call.system ?? '')) {
      opts.skillCalls?.push(String(call.prompt))
      opts.skillRequests?.push(e as Record<string, unknown>)
      return Promise.resolve(opts.skillAnswer ? opts.skillAnswer(String(call.prompt)) : '[]').then((text) => (text === null ? ({ value: { isAnswered: false, usage: {} } } as never) : ({ value: { isAnswered: true, text, usage: opts.usage ?? {} } } as never)))
    }
    return { value: { isAnswered: true, text: /Turn the user instruction/.test(String(call.prompt)) ? (opts.shaped ?? '') : (opts.proposals ?? '{"skills":[]}'), usage: opts.usage ?? {} } } as never
  })
  on('tool.call', async (_, e) => {
    if (e.tool === 'Agent' && opts.holdAgent) await opts.holdAgent
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    asked.push(question)
    options.push(((e as unknown as { questions: { options?: ({ label: string } | string)[] }[] }).questions[0]!.options ?? []).map((o) => (typeof o === 'string' ? o : o.label)))
    opts.onAsk?.()
    if (opts.holdQueue?.length) {
      return opts.holdQueue.shift()!.then((l) => ({ result: { questions: [], answers: { [question]: l } } })) as never
    }
    if (opts.holdFirstAsk && !firstHeld) {
      firstHeld = true
      return opts.holdFirstAsk.then((l) => ({ result: { questions: [], answers: { [question]: l } } })) as never
    }
    if (opts.holdAsk) return (opts.holdAsk === true ? new Promise(() => {}) : opts.holdAsk.then((l) => ({ result: { questions: [], answers: { [question]: l } } }))) as never
    const label = answers.shift()
    if (opts.answers === 'reject' || label === undefined) throw new Error('nobody to ask')
    if (label === '__undefined__') return { result: { questions: [], answers: { [question]: undefined } } } as never
    return { result: { questions: [], answers: { [question]: label } } } as never
  })
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('session.compact', () => (opts.skipCompact ? { skip: 'vetoed' } : { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  on('command.run', () => ({}))
  return { statuses, setId: (next) => { id = next }, seen, writes, asked, options, clock, hide: (path) => void hidden.add(path), files, tools, toasts, failRead, answers, driftAfter: (path, n, forever = false) => { drift.path = path; drift.left = n; drift.forever = forever }, edit: put, tmpWrites, stored: storeData, storeSets, classifyCalls: () => classifyCalls, logs, runs, debugLogs, dropTool: () => { toolGone = true } }
}

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never
const start = ($: any) => $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
const skillLoaded = ($: any, skill: string) => $.skill.prompt({ skill, text: 'x', len: 1, head: 'x', tail: 'x' })
const agentRuns = ($: any, agentId: string) => $.turn.start({ text: '', turnId: `t-${agentId}`, agentId })
const agentEnds = ($: any, agentId: string) => turnEnd($, { agentId, turnId: `t-${agentId}` })
const table = async ($: any) => (await $.command.run({ command: 'souffleur', args: '' })).text as string

const ALWAYS = JSON.stringify({ skills: { 'writing-guide': { always: true } } })
const UI = JSON.stringify({
  mode: 'enforce',
  skills: { 'ui-checklist': { need: 'ui', gate: { tools: ['Write'], paths: ['**/*.html'] } } },
  needs: { ui: 'Designing something a user sees.' },
})

test('prompt from composer gets a context block naming missing always skills', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  const r = await $.prompt.submit({ text: 'hello' })
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
  expect(w.seen.prompts.length).toBe(1)
})

test('prompt with e.command set is passed through unchanged', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  await start($)
  const r = await $.prompt.submit({ text: '/compact', command: { name: 'compact', args: '' } } as never)
  expect(r.context).toBe(undefined)
  expect(r.text).toBe('/compact')
})

test('Write to x.html is denied while ui-checklist is needed and not loaded', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  const r = await $.tool.call({ tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never)
  expect(r.deny).toMatch(/ui-checklist/)
  await skillLoaded($, 'ui-checklist')
  const again = await $.tool.call({ tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never)
  expect(again.deny).toBe(undefined)
})

test('observe mode: Write to x.html passes although ui-checklist is missing', async ($, on) => {
  world(on, { [USER_FILE]: UI.replace('enforce', 'observe') }, { classify: 'match' })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  const r = await $.tool.call({ tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never)
  expect(r.deny).toBe(undefined)
  expect(await table($)).toMatch(/Would have denied/)
})

test('missing config file: no deny, status degraded only if a file was invalid', async ($, on) => {
  const w = world(on, {})
  await start($)
  const r = await $.tool.call({ tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never)
  expect(r.deny).toBe(undefined)
  expect(w.statuses.some((s) => s?.includes('degraded'))).toBe(false)
})

test('invalid project JSON: status line says degraded', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [PROJECT_FILE]: '{ not json' })
  await start($)
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · degraded, see \/souffleur$/)
})

test('a hook error passes the event through and shows degraded', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  let fail = false
  let held: unknown
  on('state.get', () => {
    if (fail) {
      fail = false
      return { value: { value: { id: 's1' }, version: 0 } } // a session the core cannot read
    }
    return { value: { value: held, version: 0 } }
  })
  on('state.set', (_, e) => {
    if ((e.value as { id?: string } | null)?.id) held = e.value
    return { value: { isSet: true, version: 1 } }
  })
  await start($)
  fail = true
  const r = await $.prompt.submit({ text: 'hello there' })
  expect(r.text).toBe('hello there')
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · degraded, see \/souffleur$/)
})

test('a hook that works again clears its error and logs back to normal', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  let fail = false
  let held: unknown
  on('state.get', () => {
    if (fail) {
      fail = false
      return { value: { value: { id: 's1' }, version: 0 } }
    }
    return { value: { value: held, version: 0 } }
  })
  on('state.set', (_, e) => {
    if ((e.value as { id?: string } | null)?.id) held = e.value
    return { value: { isSet: true, version: 1 } }
  })
  await start($)
  fail = true
  await $.prompt.submit({ text: 'hello there' })
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · degraded, see \/souffleur$/)
  await $.prompt.submit({ text: 'and again' })
  expect(w.statuses.at(-1)).not.toMatch(/degraded/)
  expect(w.logs).toContain('Souffleur: back to normal.')
})

test('hook A error survives hook B success', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  let fail = false
  let held: unknown
  on('state.get', () => {
    if (fail) {
      fail = false
      return { value: { value: { id: 's1' }, version: 0 } }
    }
    return { value: { value: held, version: 0 } }
  })
  on('state.set', (_, e) => {
    if ((e.value as { id?: string } | null)?.id) held = e.value
    return { value: { isSet: true, version: 1 } }
  })
  await start($)
  fail = true
  await $.prompt.submit({ text: 'hello there' }) // prompt.submit fails
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · degraded, see \/souffleur$/)
  await $.tool.call({ tool: 'Read', path: 'a.txt' } as never) // tool.call works
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · degraded, see \/souffleur$/)
})

test('a failed pre-step of an Agent call shows degraded', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  let fail = false
  let held: unknown
  on('state.get', () => {
    if (fail) {
      fail = false
      return { value: { value: { id: 's1' }, version: 0 } }
    }
    return { value: { value: held, version: 0 } }
  })
  on('state.set', (_, e) => {
    if ((e.value as { id?: string } | null)?.id) held = e.value
    return { value: { isSet: true, version: 1 } }
  })
  await start($)
  fail = true
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'd', subagent_type: 'general-purpose' } as never)
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · degraded, see \/souffleur$/)
})

test('/souffleur prints the ledger table', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  await start($)
  const text = await table($)
  expect(text).toMatch(/\| Skill \| State \| Since \| Reason \|/)
  expect(text).toMatch(/writing-guide/)
  expect(text).toMatch(/Claude Code 2\.1\.332/)
})

test('session restored from $.store when $.state is empty', async ($, on) => {
  const { config } = parseConfig(ALWAYS, undefined)
  const first = decide(config, initSession(config, 's1', 1, 'startup', '2.1.331'), { type: 'skill', now: 2, skill: 'writing-guide' }).session
  world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:s1': first } })
  await start($)
  expect(await table($)).toMatch(/writing-guide \| loaded/)
  const r = await $.prompt.submit({ text: 'carry on' })
  expect(r.context).toBe(undefined)
})

test('a reload of the held state keeps per-run counters', async ($, on) => {
  const { config } = parseConfig(ALWAYS, undefined)
  const busy = { ...initSession(config, 's1', 1, 'startup', '2.1.331'), liveAgents: ['a1', 'a2'] }
  const written: any[] = []
  on('state.get', () => ({ value: { value: busy, version: 0 } }) as never)
  on('state.set', (_, e) => {
    written.push(e.value)
    return { value: { isSet: true, version: 1 } }
  })
  world(on, { [USER_FILE]: ALWAYS })
  await start($)
  expect(written.filter((v) => v?.id).at(-1).liveAgents).toEqual(['a1', 'a2'])
})

test('a resume from the store resets per-run counters', async ($, on) => {
  const { config } = parseConfig(ALWAYS, undefined)
  const busy = { ...initSession(config, 's1', 1, 'startup', '2.1.331'), liveAgents: ['a1', 'a2'] }
  const written: any[] = []
  on('state.get', () => ({ value: { value: undefined, version: 0 } }) as never)
  on('state.set', (_, e) => {
    written.push(e.value)
    return { value: { isSet: true, version: 1 } }
  })
  world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:s1': busy } })
  await start($)
  expect(written.filter((v) => v?.id).at(-1).liveAgents).toEqual([])
})

test('compaction marks the skill stale and the next prompt asks for it again', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  await $.session.compact({ trigger: 'manual' })
  const r = await $.prompt.submit({ text: 'after compact' })
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
})

test('a skipped compaction leaves the ledger alone', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS }, { skipCompact: true })
  await start($)
  await skillLoaded($, 'writing-guide')
  await $.session.compact({ trigger: 'manual' })
  const r = await $.prompt.submit({ text: 'after skip' })
  expect(r.context).toBe(undefined)
})

test('skill loaded by a subagent does not mark the main ledger', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  on('tool.call', { tool: 'Agent' }, async () => {
    await agentRuns($, 'a1')
    await $.tool.call({ tool: 'Skill', skill: 'writing-guide', agentId: 'a1' } as never)
    await skillLoaded($, 'writing-guide')
    return { result: {} }
  })
  await start($)
  await $.tool.call({ tool: 'Agent', prompt: 'skills: writing-guide', description: 'd', subagent_type: 'general-purpose' } as never)
  expect(await table($)).toMatch(/writing-guide \| not needed yet/)
})

const writeHtml = ($: any) => $.tool.call({ tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never)

test('a background agent loads a skill after its Agent call returned: not main, a gated Write is denied', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  on('tool.call', { tool: 'Agent' }, () => ({ result: {} }))
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'd', subagent_type: 'general-purpose', run_in_background: true } as never)
  await agentRuns($, 'a1')
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).not.toMatch(/ui-checklist \| loaded/)
  expect((await writeHtml($)).deny).toMatch(/ui-checklist/)
})

test('after the agent run ends a load counts for main again', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  on('tool.call', { tool: 'Agent' }, () => ({ result: {} }))
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'd', subagent_type: 'general-purpose' } as never)
  await agentRuns($, 'a1')
  await agentEnds($, 'a1')
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).toMatch(/ui-checklist \| loaded/)
  expect((await writeHtml($)).deny).toBe(undefined)
})

test('a main Skill call counts for main while an agent runs', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  await agentRuns($, 'a1')
  await $.tool.call({ tool: 'Skill', skill: 'ui-checklist' } as never)
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).toMatch(/ui-checklist \| loaded/)
})

test('a failed Agent tool call does not end a run that is live', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  on('tool.call', { tool: 'Agent' }, () => {
    throw new Error('launch failed')
  })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  await agentRuns($, 'a1')
  await $.tool.call({ tool: 'Agent', prompt: 'x', description: 'd', subagent_type: 'general-purpose' } as never).catch(() => undefined)
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).not.toMatch(/ui-checklist \| loaded/)
})

test('a skill preloaded while the agent spawns does not count for main', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  let release = () => {}
  const held = new Promise<void>((r) => { release = r })
  on('agent.spawn', async () => {
    await held
    return { model: 'm', agentId: 'a1' } as never
  })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  const spawn = $.agent.spawn({ prompt: 'x' } as never)
  await settle()
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).not.toMatch(/ui-checklist \| loaded/)
  release()
  await spawn
  // the placeholder became the agent's id: still not main until the run ends
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).not.toMatch(/ui-checklist \| loaded/)
  await agentEnds($, 'a1')
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).toMatch(/ui-checklist \| loaded/)
})

test('a spawn that fails leaves no placeholder behind', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  on('agent.spawn', () => {
    throw new Error('no')
  })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  await $.agent.spawn({ prompt: 'x' } as never).catch(() => undefined)
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).toMatch(/ui-checklist \| loaded/)
})

test('a live run the engine lists as failed is pruned at the next prompt', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  on('agent.list', () => ({ value: [{ id: 'a1', status: 'failed' }] }) as never)
  await start($)
  await agentRuns($, 'a1')
  await $.prompt.submit({ text: 'build me a login screen' })
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).toMatch(/ui-checklist \| loaded/)
})

test('a run the engine lists as completed is pruned, a running one is kept', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  on('agent.list', () => ({ value: [{ id: 'a1', status: 'completed' }, { id: 'a2', status: 'running' }] }) as never)
  await start($)
  await agentRuns($, 'a1')
  await agentRuns($, 'a2')
  await $.prompt.submit({ text: 'build me a login screen' })
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).not.toMatch(/ui-checklist \| loaded/)
  await agentEnds($, 'a2')
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).toMatch(/ui-checklist \| loaded/)
})

test('a live run the list does not name survives a prompt (a workflow agent)', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  on('agent.list', () => ({ value: [] }) as never)
  await start($)
  await agentRuns($, 'wf1')
  await $.prompt.submit({ text: 'build me a login screen' })
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).not.toMatch(/ui-checklist \| loaded/)
})

test('the agent list is not asked while no run is live, and a slow list prunes nothing', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  let asked = 0
  let slow = false
  on('agent.list', () => {
    asked += 1
    return slow ? (new Promise(() => {}) as never) : ({ value: [{ id: 'a1', status: 'completed' }] } as never)
  })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  expect(asked).toBe(0)
  await agentRuns($, 'a1')
  slow = true
  await $.prompt.submit({ text: 'build me a login screen' })
  expect(asked).toBe(1)
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).not.toMatch(/ui-checklist \| loaded/)
})

test('nothing is pruned when the agent list fails', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  on('agent.list', () => {
    throw new Error('no list')
  })
  await start($)
  await agentRuns($, 'a1')
  await $.prompt.submit({ text: 'build me a login screen' })
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).not.toMatch(/ui-checklist \| loaded/)
})

test('an agent.report ends the run', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  on('agent.report', (_, e) => ({ text: e.text }) as never)
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  await agentRuns($, 'a1')
  await $.agent.report({ agentId: 'a1', subagentType: 'general-purpose', status: 'completed', text: 'done' } as never)
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).toMatch(/ui-checklist \| loaded/)
})

test('a main turn.start and turn.complete leave the live runs alone', async ($, on) => {
  world(on, { [USER_FILE]: UI }, { classify: 'match' })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  await agentRuns($, 'a1')
  await $.turn.start({ text: '', turnId: 'main1' } as never)
  await turnEnd($, { turnId: 'main1' })
  await skillLoaded($, 'ui-checklist')
  expect(await table($)).not.toMatch(/ui-checklist \| loaded/)
})

test('new session id after clear starts a fresh ledger', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  expect(await table($)).toMatch(/writing-guide \| loaded/)
  await $.command.run({ command: 'clear', args: '' })
  w.setId('s2')
  expect(await table($)).toMatch(/writing-guide \| not needed yet/)
  const r = await $.prompt.submit({ text: 'fresh' })
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
})

test('an id change inside the process restores the stored copy of the new id (an in-process resume)', async ($, on) => {
  const { config } = parseConfig(ALWAYS, undefined)
  const other = decide(config, initSession(config, 's2', 1, 'startup', '2.1.331'), { type: 'skill', now: 2, skill: 'writing-guide' }).session
  const w = world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:s2': other } })
  await start($)
  expect(await table($)).toMatch(/writing-guide \| not needed yet/)
  w.setId('s2')
  expect(await table($)).toMatch(/writing-guide \| loaded/)
})

test('an in-process resume goes through the resume step: a stored pause is not carried over, as at session.start', async ($, on) => {
  const { config } = parseConfig(ALWAYS, undefined)
  const other = { ...decide(config, initSession(config, 's2', 1, 'startup', '2.1.331'), { type: 'skill', now: 2, skill: 'writing-guide' }).session, paused: true }
  const w = world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:s2': other } })
  await start($)
  w.setId('s2')
  const text = await table($)
  expect(text).toMatch(/writing-guide \| loaded/)
  expect(text).not.toMatch(/\(paused\)/)
})

test('a stored copy without the rule fields still restores on an id change', async ($, on) => {
  const { config } = parseConfig(ALWAYS, undefined)
  const other: Record<string, unknown> = { ...decide(config, initSession(config, 's2', 1, 'startup', '2.1.331'), { type: 'skill', now: 2, skill: 'writing-guide' }).session }
  delete other.ruleSkills
  delete other.openRules
  delete other.duties
  const w = world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:s2': other } })
  await start($)
  w.setId('s2')
  expect(await table($)).toMatch(/writing-guide \| loaded/)
  expect(await table($)).toMatch(/writing-guide \| loaded/)
})

test('an id change with an empty $.state is found through the process copy and resumed', async ($, on) => {
  const { config } = parseConfig(ALWAYS, undefined)
  const other = { ...decide(config, initSession(config, 's2', 1, 'startup', '2.1.331'), { type: 'skill', now: 2, skill: 'writing-guide' }).session, paused: true }
  on('state.get', () => ({ value: { value: undefined, version: 0 } }) as never)
  on('state.set', () => ({ value: { isSet: true, version: 1 } }) as never)
  const w = world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:s2': other } })
  await start($)
  await skillLoaded($, 'writing-guide')
  w.setId('s2')
  const text = await table($)
  expect(text).toMatch(/writing-guide \| loaded/)
  expect(text).not.toMatch(/\(paused\)/)
  expect(JSON.stringify(w.stored['session:s1'])).toMatch(/"loaded"/)
})

test('an id change to a session with no stored copy starts fresh', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  w.setId('s3')
  expect(await table($)).toMatch(/writing-guide \| not needed yet/)
})

test('the old session copy is flushed when the id changes', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  expect(JSON.stringify(w.stored['session:s1'])).not.toMatch(/"loaded"/)
  w.setId('s2')
  await table($)
  expect(JSON.stringify(w.stored['session:s1'])).toMatch(/"loaded"/)
})

test('the system prompt section states the audience rule and depends on config only', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const r = await $.prompt.compose(COMPOSE)
  const section = r.sections.find((s: { id: string }) => s.id === 'souffleur')
  expect(section?.scope).toBe('session')
  expect(section?.text).toMatch(/invoke each one with the Skill tool/)
  expect(section?.text).toMatch(/Each skill applies only to the output named with it\./)
  expect(section?.text).toContain(' Always-on skills: writing-guide.')
  expect(section?.text).not.toMatch(/Replies in this chat/)
})

test('the system section names the chat skill', async ($, on) => {
  const chat = JSON.stringify({ mode: 'enforce', skills: { 'terse:terse-mode': { always: true, for: 'chat' }, 'ui-design': { always: true, for: 'users', notIn: ['/work/proj'] } } })
  world(on, { [USER_FILE]: chat })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const r = await $.prompt.compose(COMPOSE)
  const text = r.sections.find((s: { id: string }) => s.id === 'souffleur')?.text as string
  expect(text).toContain('Each skill applies only to the output named with it. Replies in this chat follow terse:terse-mode; a skill for other readers or for product users never changes how you reply here.')
  expect(text).not.toMatch(/Always-on skills: [^.]*terse:terse-mode/)
})


const SETTINGS_PATH = `${HOME}/.claude/settings.json`
const CLAUDE_MD = `${HOME}/.claude/CLAUDE.md`
const SETTINGS = JSON.stringify(
  {
    theme: 'dark',
    hooks: {
      SessionStart: [{ matcher: 'compact|resume|clear', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/writing-guide-reload.sh' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/gone-skill-preload.sh' }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'prettier --write .' }] }],
    },
  },
  null,
  2,
)
const PICKS = JSON.stringify({ skills: [{ name: 'ui-checklist', need: 'ui', needText: 'Building a screen.' }] })
const run = async ($: any, args: string) => (await $.command.run({ command: 'souffleur', args, origin: COMPOSER })).text as string
const SKILLS = ['writing-guide', 'ui-checklist', 'pdf']

test('init asks per skill and writes the user file', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, proposals: PICKS, answers: ['When the task needs it', 'When the task needs it'] })
  await start($)
  const text = await run($, 'init')
  // writing-guide is configured (asked first), then the hook skill is none (already configured), then the model pick.
  expect(w.asked.length).toBe(2)
  expect(w.asked[0]).toMatch(/writing-guide/)
  expect(w.asked[0]).toMatch(/From the start|always/i)
  expect(w.asked[1]).toMatch(/ui-checklist/)
  const written = JSON.parse(w.writes.filter((x) => x.path === USER_FILE).at(-1)!.text)
  expect(written.skills['writing-guide'].need).toBeTruthy()
  expect(written.skills['ui-checklist']).toEqual({ need: 'ui' })
  expect(written.needs.ui).toBe('Building a screen.')
  expect(w.writes.some((x) => x.path === SETTINGS_PATH)).toBe(false)
  expect(text).toMatch(/pdf/)
  expect(text).toMatch(/\/souffleur migrate/)
})

// Plugin groups (#43). A model pick gives each skill a proposal and no current choice, so these skills are groupable.
const GROUP = ['pk:a', 'pk:b', 'pk:c']
const GROUP_PICKS = JSON.stringify({ skills: GROUP.map((name) => ({ name, need: `k-${name.slice(3)}`, needText: `Need of ${name}.` })) })
const EMPTY = '{"skills":{}}'
const groupWrites = (w: any) => w.writes.filter((x: any) => x.path === USER_FILE)

test('a plugin group answered All when the task needs it writes every need after one dialog', async ($, on) => {
  const w = world(on, { [USER_FILE]: EMPTY }, { skills: GROUP, proposals: GROUP_PICKS, answers: ['All when the task needs it'] })
  await start($)
  await run($, 'init')
  expect(w.asked.length).toBe(1)
    expect(w.asked[0]).toMatch(/Need of pk:a\./)
  const written = JSON.parse(groupWrites(w).at(-1).text)
  for (const n of ['a', 'b', 'c']) {
    expect(written.skills[`pk:${n}`]).toEqual({ need: `k-${n}` })
    expect(written.needs[`k-${n}`]).toBe(`Need of pk:${n}.`)
  }
})

test("a plugin group answered Don't watch any writes no entry", async ($, on) => {
  const w = world(on, { [USER_FILE]: EMPTY }, { skills: GROUP, proposals: GROUP_PICKS, answers: ["Don't watch any"] })
  await start($)
  await run($, 'init')
  expect(w.asked.length).toBe(1)
  expect(groupWrites(w).length).toBe(0)
})

test('a plugin group answered Decide later writes nothing and says so for each skill', async ($, on) => {
  const w = world(on, { [USER_FILE]: EMPTY }, { skills: GROUP, proposals: GROUP_PICKS, answers: ['Decide later'] })
  await start($)
  const text = await run($, 'init')
  expect(w.asked.length).toBe(1)
  expect(groupWrites(w).length).toBe(0)
  for (const s of GROUP) expect(text).toContain(`${s}: decided later; /souffleur init asks again.`)
})

test('a plugin group answered Ask one by one leads to one dialog per skill', async ($, on) => {
  const w = world(on, { [USER_FILE]: EMPTY }, { skills: GROUP, proposals: GROUP_PICKS, answers: ['Ask one by one', 'When the task needs it', 'Decide later', "Don't watch"] })
  await start($)
  const text = await run($, 'init')
  expect(w.asked.length).toBe(4)
  for (const [i, s] of GROUP.entries()) expect(w.asked[i + 1]).toContain(`${s}:`)
  const written = JSON.parse(groupWrites(w).at(-1).text)
  expect(written.skills['pk:a']).toEqual({ need: 'k-a' })
  expect(written.skills['pk:b']).toBe(undefined)
  expect(text).toContain('pk:b: decided later; /souffleur init asks again.')
})

test('free text on a group question counts as Ask one by one', async ($, on) => {
  const w = world(on, { [USER_FILE]: EMPTY }, { skills: GROUP, proposals: GROUP_PICKS, answers: ['whatever I typed', 'Decide later', 'Decide later', 'Decide later'] })
  await start($)
  await run($, 'init')
  expect(w.asked.length).toBe(4)
})

test('dismissing a group question stops init', async ($, on) => {
  const w = world(on, { [USER_FILE]: EMPTY }, { skills: GROUP, proposals: GROUP_PICKS, answers: [''] })
  await start($)
  const text = await run($, 'init')
  expect(w.asked.length).toBe(1)
  expect(groupWrites(w).length).toBe(0)
  expect(text).toMatch(/Stopped/)
})

test('a plugin with one skill is asked per skill, not as a group', async ($, on) => {
  const w = world(on, { [USER_FILE]: EMPTY }, { skills: ['pk:a'], proposals: JSON.stringify({ skills: [{ name: 'pk:a', need: 'k-a', needText: 'Need of pk:a.' }] }), answers: ['When the task needs it'] })
  await start($)
  await run($, 'init')
  expect(w.asked.length).toBe(1)
  expect(w.asked[0]).not.toMatch(/All when the task needs it/)
  expect(JSON.parse(groupWrites(w).at(-1).text).skills['pk:a']).toEqual({ need: 'k-a' })
})

test('skills that already have a choice are not part of a group', async ($, on) => {
  const user = JSON.stringify({ skills: { 'pk:a': { always: true }, 'pk:b': { always: true } } })
  const w = world(on, { [USER_FILE]: user }, { skills: GROUP, proposals: GROUP_PICKS, answers: ['Decide later', 'Decide later', 'Decide later'] })
  await start($)
  await run($, 'init')
  // pk:a and pk:b are asked one by one; pk:c alone is no group.
  expect(w.asked.length).toBe(3)
  expect(w.asked.some((q) => /All when the task needs it/.test(q))).toBe(false)
})

const GROUP2 = ['qq:a', 'qq:b']
const BOTH_PICKS = JSON.stringify({ skills: [...GROUP, ...GROUP2].map((name) => ({ name, need: `k-${name.replace(':', '-')}`, needText: `Need of ${name}.` })) })

test('a group answer is written at once: a second group dismissed keeps the first', async ($, on) => {
  const w = world(on, { [USER_FILE]: EMPTY }, { skills: [...GROUP, ...GROUP2], proposals: BOTH_PICKS, answers: ['All when the task needs it', ''] })
  await start($)
  const text = await run($, 'init')
  const written = JSON.parse(groupWrites(w).at(-1).text)
  for (const n of ['a', 'b', 'c']) expect(written.skills[`pk:${n}`]).toBeTruthy()
  expect(written.skills['qq:a']).toBe(undefined)
  expect(text).toMatch(/Stopped at the plugin qq; 2 skills not asked/)
})

test('a group answer is written at once: a later per-skill dismiss keeps it', async ($, on) => {
  const w = world(on, { [USER_FILE]: EMPTY }, { skills: [...GROUP, 'solo'], proposals: JSON.stringify({ skills: [...GROUP.map((name) => ({ name, need: `k-${name.slice(3)}`, needText: `Need of ${name}.` })), { name: 'solo', need: 'k-solo', needText: 'Solo.' }] }), answers: ['All when the task needs it', ''] })
  await start($)
  const text = await run($, 'init')
  const written = JSON.parse(groupWrites(w).at(-1).text)
  for (const n of ['a', 'b', 'c']) expect(written.skills[`pk:${n}`]).toBeTruthy()
  expect(written.skills.solo).toBe(undefined)
  expect(text).toMatch(/Stopped at solo; 1 skill not asked/)
})

test('init starts its first dialog with the explanation', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['Decide later'] })
  await start($)
  await run($, 'init')
  expect(w.asked[0]).toMatch(/Souffleur init/)
  expect(w.asked[0]).toMatch(/Don't watch/)
})

test('closing the dialog stops init and keeps earlier answers', async ($, on) => {
  const both = JSON.stringify({ skills: { 'writing-guide': { always: true }, 'ui-checklist': { always: true } } })
  const w = world(on, { [USER_FILE]: both }, { skills: SKILLS, answers: ["Don't watch"] })
  await start($)
  const text = await run($, 'init')
  const written = JSON.parse(w.writes.filter((x) => x.path === USER_FILE).at(-1)!.text)
  expect(written.skills['writing-guide']).toBe(undefined)
  expect(written.skills['ui-checklist']).toEqual({ always: true })
  expect(text).toMatch(/Stopped/)
})

test('first dialog failing prints text and writes nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, proposals: PICKS, answers: 'reject' })
  await start($)
  const text = await run($, 'init')
  expect(text).toMatch(/nothing was changed/i)
  expect(text).toMatch(/writing-guide/)
  expect(text).toMatch(/"ui-checklist"/)
  expect(w.writes.length).toBe(0)
})

test('init lists a project-only skill and does not ask about it', async ($, on) => {
  const w = world(on, { [USER_FILE]: '{"skills":{}}', [PROJECT_FILE]: JSON.stringify({ skills: { 'ui-checklist': { always: true } } }) }, { skills: ['ui-checklist'], answers: [] })
  await start($)
  const text = await run($, 'init')
  expect(w.asked.length).toBe(0)
  expect(text).toMatch(/ui-checklist/)
  expect(text).toMatch(/project/i)
})

test('migrate starts with its explanation and asks per hook', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS, [CLAUDE_MD]: 'Always load writing-guide first.\nUse pdf for forms.' }, { skills: SKILLS, answers: ['Turn off', 'Keep'] })
  await start($)
  const text = await run($, 'migrate')
  expect(w.asked.length).toBe(2)
  expect(w.asked[0]).toMatch(/^Souffleur migrate/)
  expect(w.asked[0]).toMatch(/Turn off/)
  expect(w.asked[0]).toMatch(/writing-guide-reload\.sh/)
  expect(w.asked[1]).toMatch(/gone-skill-preload\.sh/)
  expect(w.asked[1]).toMatch(/guess/)
  expect(text.startsWith('Souffleur migrate')).toBe(true)
  expect(text).toMatch(/CLAUDE\.md:1/)
  expect(text).not.toMatch(/pdf for forms/)
})

test('migrate writes a backup before editing settings', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, answers: ['Turn off', 'Keep'] })
  await start($)
  const text = await run($, 'migrate')
  const backup = w.writes.findIndex((x) => /settings\.json\.bak-souffleur-\d{8}-\d{6}$/.test(x.path))
  const edit = w.writes.findIndex((x) => x.path === SETTINGS_PATH)
  expect(backup).toBeGreaterThan(-1)
  expect(edit).toBeGreaterThan(backup)
  expect(w.writes[backup]!.text).toBe(SETTINGS)
  const after = JSON.parse(w.writes[edit]!.text)
  expect(after.theme).toBe('dark')
  expect(after.hooks.SessionStart).toBe(undefined)
  expect(after.hooks.UserPromptSubmit.length).toBe(1)
  expect(after.hooks.PostToolUse.length).toBe(1)
  expect(w.writes.some((x) => x.path === USER_FILE)).toBe(false)
  expect(text).toMatch(/Turned off/)
})

test('migrate keeps a hook the user wants to keep and edits nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, answers: ['Keep', 'Keep'] })
  await start($)
  await run($, 'migrate')
  expect(w.writes.length).toBe(0)
})

test('migrate without dialog prints the explanation and steps and writes nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, answers: 'reject' })
  await start($)
  const text = await run($, 'migrate')
  expect(text.startsWith('Souffleur migrate')).toBe(true)
  expect(text).toMatch(/nothing was changed/i)
  expect(text).toMatch(/writing-guide-reload\.sh/)
  expect(w.writes.length).toBe(0)
})

test('no user config shows not-set-up status', async ($, on) => {
  const w = world(on, {})
  await start($)
  expect(w.statuses.at(-1)).toBe('not set up, run /souffleur init')
  expect(await table($)).toMatch(/not set up/)
})

test('a user config silences the not-set-up status', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  expect(w.statuses.at(-1)).not.toMatch(/not set up/)
})

test('the /souffleur command shows its arguments in the typeahead', async ($, on) => {
  registeredCommands.length = 0
  world(on, { [USER_FILE]: ALWAYS })
  await start($)
  expect(JSON.stringify(registeredCommands)).toContain('"argumentHint":"[status | need <name> | drop <name> | pause | resume | init | migrate | rule <text> | review | accept <id> | decline <id> | block <name> | unblock <name> | project | update]"')
})

// ---- review fixes ----

const written = (w: World, path: string) => w.writes.filter((x) => x.path === path)
const backups = (w: World) => w.writes.filter((x) => /settings\.json\.bak-souffleur-/.test(x.path))
const TWO = JSON.stringify({ skills: { 'writing-guide': { always: true }, 'ui-checklist': { always: true } } })

test('a read error on the user file stops init and writes nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['Decide later'], failRead: [USER_FILE] })
  await start($)
  const text = await run($, 'init')
  expect(w.writes.length).toBe(0)
  expect(text).toMatch(/could not read ~\/\.claude\/souffleur\.json/)
  expect(text).not.toContain(HOME)
})

test('a file the scan saw is never replaced by a fresh one when it seems to vanish', async ($, on) => {
  let vanish = () => {}
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['When the task needs it'], onAsk: () => vanish() })
  vanish = () => w.hide(USER_FILE) // while the dialog is open, exists() starts to say false
  await start($)
  const text = await run($, 'init')
  expect(w.writes.length).toBe(0)
  expect(text).toMatch(/Stopped: .* was there at the start/)
})

for (const bad of ['[]', '{"skills":"nope"}', '{"needs":[1]}', '"text"']) {
  test(`a user file ${bad} stops init and writes nothing`, async ($, on) => {
    const w = world(on, { [USER_FILE]: bad }, { skills: ['writing-guide'], answers: ['From the start'] })
    await start($)
    const text = await run($, 'init')
    expect(w.writes.length).toBe(0)
    expect(text).toMatch(/nothing was changed/i)
  })
}

// An answer that is undefined cannot reach the mod through the test kit (the engine rejects), so only '' is driven here.
for (const blank of ['']) {
  test(`init treats the answer ${JSON.stringify(blank)} as Stop`, async ($, on) => {
    const w = world(on, { [USER_FILE]: TWO, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, answers: [blank, 'Keep'] })
    await start($)
    const text = await run($, 'init')
    expect(w.writes.length).toBe(0)
    expect(w.asked.length).toBe(1)
    expect(text).toMatch(/Stopped at writing-guide/)
  })
  test(`migrate treats the answer ${JSON.stringify(blank)} as Stop`, async ($, on) => {
    const m = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, answers: [blank, 'Turn off'] })
    await start($)
    const mt = await run($, 'migrate')
    expect(m.writes.length).toBe(0)
    expect(m.asked.length).toBe(1)
    expect(mt).toMatch(/Stopped/)
  })
}

test('Other text is collapsed to one line and the written file passes parseConfig', async ($, on) => {
  const w = world(on, { [USER_FILE]: TWO }, { skills: ['writing-guide', 'ui-checklist'], answers: ['Writing\n  text   people read.'] })
  await start($)
  await run($, 'init')
  const out = written(w, USER_FILE).at(-1)!.text
  expect(parseConfig(out, undefined).errors).toEqual([])
  expect(JSON.parse(out).needs).toEqual({ 'writing-guide': 'Writing text people read.' })
})

for (const [name, bad] of [['blank', '   '], ['too long', 'x'.repeat(201)]] as const) {
  test(`Other text that is ${name} is skipped with a note and writes nothing`, async ($, on) => {
    const v = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: [bad] })
    await start($)
    const text = await run($, 'init')
    expect(v.writes.length).toBe(0)
    expect(text).toMatch(/writing-guide: skipped/i)
  })
}

test('init twice in one session shows the new current setting', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['When the task needs it', 'Decide later'] })
  await start($)
  await run($, 'init')
  await run($, 'init')
  expect(w.asked[0]).toMatch(/writing-guide: From the start/)
  expect(w.asked[1]).toMatch(/writing-guide: When the task needs it/)
})

test('an unchanged choice writes nothing and is reported as kept', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['From the start'] })
  await start($)
  const text = await run($, 'init')
  expect(w.writes.length).toBe(0)
  expect(text).toMatch(/Kept/)
  expect(text).not.toMatch(/Nothing to ask/)
})

const hooksOn = (event: string) => JSON.stringify({ hooks: { [event]: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/ui-checklist-reload.sh' }] }] } })

test('a SessionStart hook makes From the start the recommendation', async ($, on) => {
  const a = world(on, { [USER_FILE]: '{"skills":{}}', [SETTINGS_PATH]: hooksOn('SessionStart') }, { skills: ['ui-checklist'], answers: ['Decide later'] })
  await start($)
  await run($, 'init')
  expect(a.asked[0]).toMatch(/recommended: From the start/)
})

test('a hook on another event does not', async ($, on) => {
  const b = world(on, { [USER_FILE]: '{"skills":{}}', [SETTINGS_PATH]: hooksOn('UserPromptSubmit') }, { skills: ['ui-checklist'], answers: ['Decide later'] })
  await start($)
  await run($, 'init')
  expect(b.asked[0]).toMatch(/recommended: When the task needs it/)
})

test('a configured skill without a need shows the proposed description before the user picks', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['Decide later'], proposals: JSON.stringify({ skills: [{ name: 'writing-guide', need: 'prose', needText: 'Writing text people read.' }] }) })
  await start($)
  await run($, 'init')
  expect(w.asked[0]).toMatch(/Writing text people read\./)
})

test('without a proposal the dialog shows the fallback description', async ($, on) => {
  const v = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['Decide later'] })
  await start($)
  await run($, 'init')
  expect(v.asked[0]).toMatch(/The task calls for writing-guide\./)
})

test('init reports overlapping hooks and passages by count, not guesses', async ($, on) => {
  const files = { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS, [CLAUDE_MD]: 'Always load writing-guide first.' }
  world(on, files, { skills: ['writing-guide'], answers: ['From the start'] })
  await start($)
  const text = await run($, 'init')
  expect(text).toMatch(/1 hook and 1 passage/)
  expect(text).toMatch(/1 more guessed/)
})

test('two migrate runs leave two backups and the first holds the original', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, answers: ['Turn off', 'Keep', 'Turn off'] })
  await start($)
  await run($, 'migrate')
  const afterFirst = w.files[SETTINGS_PATH]!
  await run($, 'migrate')
  const b = backups(w)
  expect(b.length).toBe(2)
  expect(b[0]!.path).not.toBe(b[1]!.path)
  expect(b[0]!.text).toBe(SETTINGS)
  expect(b[1]!.text).toBe(afterFirst)
})

test('a failing backup write stops migrate before settings are touched', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, answers: ['Turn off', 'Turn off'], failWrite: /\.bak-souffleur-/ })
  await start($)
  const text = await run($, 'migrate')
  expect(w.writes.length).toBe(0)
  expect(w.files[SETTINGS_PATH]).toBe(SETTINGS)
  expect(text).toMatch(/backup/i)
  expect(w.asked.length).toBe(1)
})

test('migrate stops when settings changed after the edit was prepared', async ($, on) => {
  const files: Record<string, string> = { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS }
  const w = world(on, files, { skills: SKILLS, answers: ['Turn off', 'Turn off'], onWrite: (path) => { if (/\.bak-souffleur-/.test(path)) files[SETTINGS_PATH] = SETTINGS.replace('dark', 'light') } })
  await start($)
  const text = await run($, 'migrate')
  expect(written(w, SETTINGS_PATH).length).toBe(0)
  expect(files[SETTINGS_PATH]).toContain('light')
  expect(text).toMatch(/changed since/i)
})

test('migrate summarises Keep and Stop', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, answers: ['Keep', 'Stop'] })
  await start($)
  const text = await run($, 'migrate')
  expect(text).toMatch(/Kept/)
  expect(text).toMatch(/Stopped/)
  expect(text).not.toMatch(/Nothing to migrate/)
  expect(w.writes.length).toBe(0)
})

test('migrate says nothing to migrate only for an empty list', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: '{}' }, { skills: SKILLS })
  await start($)
  expect(await run($, 'migrate')).toMatch(/Nothing to migrate/)
})

test('a BOM in settings.json does not hide its hooks', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: `\uFEFF${SETTINGS}` }, { skills: SKILLS, answers: ['Turn off', 'Keep'] })
  await start($)
  await run($, 'migrate')
  expect(JSON.parse(written(w, SETTINGS_PATH).at(-1)!.text).theme).toBe('dark')
})

test('notes print paths in the ~ form and imports in CLAUDE.md are followed one level', async ($, on) => {
  const files = { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: '{}', [`${HOME}/.claude/CLAUDE.md`]: 'x', '/work/proj/CLAUDE.md': '@AGENTS.md', '/work/proj/AGENTS.md': 'Always load writing-guide first.\n@deeper.md', '/work/proj/deeper.md': 'Also load writing-guide.' }
  world(on, files, { skills: SKILLS, failRead: [`${HOME}/.claude/CLAUDE.md`] })
  await start($)
  const text = await run($, 'migrate')
  expect(text).toMatch(/AGENTS\.md:1/)
  expect(text).not.toMatch(/deeper\.md/)
  expect(text).toMatch(/~\/\.claude\/CLAUDE\.md/)
  expect(text).not.toContain(HOME)
})

test('CLAUDE.md imports outside the project root and ~/.claude are not read', async ($, on) => {
  const files = {
    [USER_FILE]: ALWAYS, [SETTINGS_PATH]: '{}', [`${HOME}/.claude/CLAUDE.md`]: 'x',
    '/work/proj/CLAUDE.md': '@/etc/outside.md\n@../secret.md\n@~/other/home.md\n@link.md\n@inside.md\n@~/.claude/extra.md',
    '/etc/outside.md': 'Always load writing-guide (absolute).',
    '/work/secret.md': 'Always load writing-guide (dotdot).',
    [`${HOME}/other/home.md`]: 'Always load writing-guide (home).',
    '/work/proj/link.md': 'Always load writing-guide (symlink).',
    '/work/proj/inside.md': 'Always load writing-guide (inside).',
    [`${HOME}/.claude/extra.md`]: 'Always load writing-guide (claude dir).',
  }
  world(on, files, { skills: SKILLS, failRead: [`${HOME}/.claude/CLAUDE.md`], linkTo: { '/work/proj/link.md': '/etc/outside.md' } })
  await start($)
  const text = await run($, 'migrate')
  expect(text).toMatch(/inside\.md:1/)
  expect(text).toMatch(/extra\.md:1/)
  expect(text).not.toMatch(/outside\.md/)
  expect(text).not.toMatch(/secret\.md/)
  expect(text).not.toMatch(/home\.md/)
  expect(text).not.toMatch(/link\.md/)
})

test('CLAUDE.md imports: a worktree outside the main root keeps its own files', async ($, on) => {
  const files = { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: '{}', [`${HOME}/.claude/CLAUDE.md`]: 'x', '/wt/feature/CLAUDE.md': '@AGENTS.md', '/wt/feature/AGENTS.md': 'Always load writing-guide first.' }
  world(on, files, { skills: SKILLS, failRead: [`${HOME}/.claude/CLAUDE.md`], repoRoot: '/work/main', cwd: '/wt/feature' })
  await $.session.start({ cwd: '/wt/feature', surface: 'terminal', isInteractive: true })
  expect(await run($, 'migrate')).toMatch(/AGENTS\.md:1/)
})

test('CLAUDE.md imports under ~/.claude must be .md files', async ($, on) => {
  const files = {
    [USER_FILE]: ALWAYS, [SETTINGS_PATH]: '{}', [`${HOME}/.claude/CLAUDE.md`]: 'x',
    '/work/proj/CLAUDE.md': '@~/.claude/.credentials.json\n@~/.claude/souffleur.json\n@~/.claude/rules.md',
    [`${HOME}/.claude/.credentials.json`]: 'Always load writing-guide (creds).',
    [`${HOME}/.claude/rules.md`]: 'Always load writing-guide (rules).',
  }
  world(on, files, { skills: SKILLS, failRead: [`${HOME}/.claude/CLAUDE.md`] })
  await start($)
  const text = await run($, 'migrate')
  expect(text).toMatch(/rules\.md:1/)
  expect(text).not.toMatch(/credentials/)
  expect(text).not.toMatch(/souffleur\.json:/)
})

test('CLAUDE.md imports: a failed stat skips the import and logs to debug', async ($, on) => {
  const files = { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: '{}', [`${HOME}/.claude/CLAUDE.md`]: 'x', '/work/proj/CLAUDE.md': '@AGENTS.md', '/work/proj/AGENTS.md': 'Always load writing-guide first.' }
  const w = world(on, files, { skills: SKILLS, failRead: [`${HOME}/.claude/CLAUDE.md`], failStat: ['/work/proj/AGENTS.md'] })
  await start($)
  const text = await run($, 'migrate')
  expect(text).not.toMatch(/AGENTS\.md:1/)
  expect(w.debugLogs.some((l) => /import skipped/.test(l))).toBe(true)
})

test('init applies at once: a new skill shows in the table and the status line', async ($, on) => {
  const w = world(on, {}, { skills: ['ui-checklist'], proposals: PICKS, answers: ['When the task needs it'] })
  await start($)
  expect(w.statuses.at(-1)).toBe('not set up, run /souffleur init')
  const text = await run($, 'init')
  expect(text).not.toMatch(/next session/)
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · observe · 0 loaded$/)
  const t = await table($)
  expect(t).toMatch(/\| ui-checklist \| not needed yet \|/)
  expect(t).not.toMatch(/not set up/)
})

test('init applies at once: a skill answered Dont watch leaves the table', async ($, on) => {
  const files = { [USER_FILE]: JSON.stringify({ skills: { 'writing-guide': { always: true }, 'old-skill': { always: true } } }) }
  world(on, files, { skills: ['writing-guide', 'old-skill'], answers: ['From the start', "Don't watch"] })
  await start($)
  expect(await table($)).toMatch(/old-skill/)
  await run($, 'init')
  const t = await table($)
  expect(t).toMatch(/writing-guide/)
  expect(t).not.toMatch(/old-skill/)
})

const PLUGINS = `${HOME}/.claude/plugins/installed_plugins.json`
const pluginFiles = (hooks: unknown) => ({
  [PLUGINS]: JSON.stringify({ version: 2, plugins: { 'flow@market': [{ installPath: '/plugins/flow' }] } }),
  '/plugins/flow/hooks/hooks.json': JSON.stringify({ hooks }),
})
const FLOW_PICKS = JSON.stringify({ skills: [{ name: 'flow:plan', need: 'plan', needText: 'Planning a change.' }] })

test('init warns when Injected is chosen for a plugin without a SessionStart hook', async ($, on) => {
  const w = world(on, pluginFiles({ PostToolUse: [] }), { skills: ['flow:plan'], proposals: FLOW_PICKS, answers: ['Loaded by its own plugin at start (rare)'] })
  await start($)
  const text = await run($, 'init')
  expect(text).toMatch(/flow:plan: Loaded by its own plugin at start \(rare\)\./)
  expect(text).toMatch(/Warning: the plugin flow has no SessionStart hook/)
  // The injected answer is not offered here, so its explanation is left out.
  expect(w.asked[0]).not.toMatch(/for example/i)
})

test('init does not warn when the plugin has a SessionStart hook', async ($, on) => {
  world(on, pluginFiles({ SessionStart: [{ hooks: [{ type: 'command', command: 'x' }] }] }), { skills: ['flow:plan'], proposals: FLOW_PICKS, answers: ['Loaded by its own plugin at start (rare)'] })
  await start($)
  expect(await run($, 'init')).not.toMatch(/Warning/)
})

test('migrate warns about a hook for something Souffleur does not watch', async ($, on) => {
  const settings = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/rules-preload.sh' }] }] } })
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: settings }, { skills: SKILLS, answers: ['Keep'] })
  await start($)
  const text = await run($, 'migrate')
  expect(w.asked[0]).toMatch(/does not watch|cannot tell which skill/)
  expect(w.asked[0]).toMatch(/without reminders/)
  expect(w.writes.length).toBe(0)
  expect(text).toMatch(/Kept/)
})

test('a configured skill that is not installed here is not requested and shows as not installed here', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['pdf'] })
  await start($)
  const r = await $.prompt.submit({ text: 'hello' })
  expect(r.context).toBe(undefined)
  expect(await table($)).toMatch(/\| writing-guide \| not installed here \|/)
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · observe · 0 loaded, 1 not installed here$/)
})


// ---- fix round: live setup ----

const LISTED = (names: string[]) => names
const FLOW_HOOK = { SessionStart: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/hooks/session-start' }] }] }
const flowInjected = JSON.stringify({ skills: { 'flow:plan': { always: true, startup: 'injected' } } })

test('a command list fallback marks nothing and the skill is still requested', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS }, { listOnly: ['pdf'] })
  await start($)
  const r = await $.prompt.submit({ text: 'hello' })
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
  expect(await table($)).not.toMatch(/not installed here/)
})

test('an incomplete skill listing marks nothing', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS }, { skills: LISTED(['pdf']), incomplete: true })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  expect(await table($)).not.toMatch(/not installed here/)
})

test('a bare config name matches a plugin skill in the list, and the other way round', async ($, on) => {
  world(on, { [USER_FILE]: JSON.stringify({ skills: { 'writing-guide': { always: true }, 'docs:ui-checklist': { always: true } } }) }, { skills: ['docs:writing-guide', 'ui-checklist'] })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  expect(await table($)).not.toMatch(/not installed here/)
})

test('a skill injected at startup but missing from the list shows as not installed here', async ($, on) => {
  world(on, { [USER_FILE]: flowInjected }, { skills: ['pdf'] })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  expect(await table($)).toMatch(/\| flow:plan \| not installed here \|/)
})

test('a skill not installed here is left out of the system prompt section', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS }, { skills: ['pdf'] })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const r = await $.prompt.compose(COMPOSE)
  const section = r.sections.find((x: { id: string }) => x.id === 'souffleur')
  expect(section?.text).not.toMatch(/writing-guide/)
})

test('session.start on a reload gives a skill added to the config a ledger entry', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  w.files[USER_FILE] = JSON.stringify({ skills: { 'writing-guide': { always: true }, 'ui-checklist': { always: true } } })
  await start($)
  expect(await table($)).toMatch(/\| ui-checklist \| not needed yet \|/)
})

test('a stored session that lacks a configured skill is healed on its first event', async ($, on) => {
  const config = parseConfig(ALWAYS, undefined).config
  const old = { ...initSession(config, 's1', 1, 'startup'), ledger: {} }
  world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:s1': old } })
  expect(await table($)).toMatch(/\| writing-guide \| not needed yet \|/)
})

test('a skill listing that never answers does not hold the prompt back', async ($, on) => {
  const w = world(on, { [USER_FILE]: UI }, { classify: 'match', hangUsage: true })
  const started = start($)
  await w.clock.advance(300)
  await started
  const p = $.prompt.submit({ text: 'build me a login screen' })
  await w.clock.advance(300)
  const r = await p
  expect(r.context?.join('\n')).toMatch(/ui-checklist/)
})

test('init still says the entries apply now when the skill listing fails', async ($, on) => {
  world(on, {}, { skills: ['ui-checklist'], proposals: PICKS, answers: ['When the task needs it'], failUsage: true })
  await start($)
  // With the listing down init has no candidates, so give it the command list instead.
  expect(await run($, 'init')).not.toMatch(/could not be applied/)
})

const plugins = (entries: Record<string, string[]>, files: Record<string, string> = {}) => ({
  [PLUGINS]: JSON.stringify({ version: 2, plugins: Object.fromEntries(Object.entries(entries).map(([k, paths]) => [k, paths.map((installPath) => ({ installPath }))])) }),
  ...files,
})

test('a SessionStart hook gives a soft line, not a warning', async ($, on) => {
  world(on, pluginFiles(FLOW_HOOK), { skills: ['flow:plan'], proposals: FLOW_PICKS, answers: ['Loaded by its own plugin at start (rare)'] })
  await start($)
  const text = await run($, 'init')
  expect(text).toMatch(/Note: the plugin flow has a SessionStart hook; Souffleur cannot tell whether it prints flow:plan/)
  expect(text).not.toMatch(/Warning/)
})

test('no note when a hook command names the skill', async ($, on) => {
  const hook = { SessionStart: [{ hooks: [{ type: 'command', command: 'cat plan.md' }] }] }
  world(on, pluginFiles(hook), { skills: ['flow:plan'], proposals: FLOW_PICKS, answers: ['Loaded by its own plugin at start (rare)'] })
  await start($)
  expect(await run($, 'init')).not.toMatch(/Note:|Warning/)
})

test('any installed copy of the plugin with a SessionStart hook counts', async ($, on) => {
  const files = plugins({ 'flow@a': ['/p1'], 'flow@b': ['/p2'] }, { '/p1/hooks/hooks.json': JSON.stringify({ hooks: {} }), '/p2/hooks/hooks.json': JSON.stringify({ hooks: FLOW_HOOK }) })
  world(on, files, { skills: ['flow:plan'], proposals: FLOW_PICKS, answers: ['Loaded by its own plugin at start (rare)'] })
  await start($)
  const text = await run($, 'init')
  expect(text).toMatch(/Note: the plugin flow has a SessionStart hook/)
  expect(text).not.toMatch(/Warning/)
})

test('hooks declared inline in plugin.json count', async ($, on) => {
  const files = plugins({ 'flow@a': ['/p1'] }, { '/p1/.claude-plugin/plugin.json': JSON.stringify({ name: 'flow', hooks: FLOW_HOOK }) })
  world(on, files, { skills: ['flow:plan'], proposals: FLOW_PICKS, answers: ['Loaded by its own plugin at start (rare)'] })
  await start($)
  expect(await run($, 'init')).toMatch(/Note: the plugin flow has a SessionStart hook/)
})

test('an unreadable plugin gives the unknown line, not the no-hook warning', async ($, on) => {
  const files = plugins({ 'flow@a': ['/p1'] }, { '/p1/hooks/hooks.json': '{ broken' })
  world(on, files, { skills: ['flow:plan'], proposals: FLOW_PICKS, answers: ['Loaded by its own plugin at start (rare)'] })
  await start($)
  const text = await run($, 'init')
  expect(text).toMatch(/could not check/i)
  expect(text).not.toMatch(/has no SessionStart hook/)
})

test('an injected skill that init keeps still gets the warning', async ($, on) => {
  const files = { ...pluginFiles({ PostToolUse: [] }), [USER_FILE]: flowInjected }
  const w = world(on, files, { skills: ['flow:plan'], answers: ['Loaded by its own plugin at start (rare)'] })
  await start($)
  const text = await run($, 'init')
  expect(w.asked[0]).toMatch(/for example/i)
  expect(text).toMatch(/Kept flow:plan/)
  expect(text).toMatch(/Warning: the plugin flow has no SessionStart hook/)
})

test('the no-dialog text warns about an injected skill too', async ($, on) => {
  const files = { ...pluginFiles({ PostToolUse: [] }), [USER_FILE]: flowInjected }
  world(on, files, { skills: ['flow:plan'], answers: 'reject' })
  await start($)
  expect(await run($, 'init')).toMatch(/Warning: the plugin flow has no SessionStart hook/)
})

const HOOK_SETTINGS = (command: string) => JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] } })

test('migrate: a hook that names an installed skill Souffleur does not watch says so and lists Keep first', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: HOOK_SETTINGS('bash ~/.claude/hooks/ui-checklist.sh') }, { skills: SKILLS, answers: ['Keep'] })
  await start($)
  await run($, 'migrate')
  expect(w.asked[0]).toMatch(/does not watch ui-checklist yet/)
  expect(w.options[0]![0]).toBe('Keep')
})

test('migrate: only skills in the user file count as watched', async ($, on) => {
  const files = { [USER_FILE]: ALWAYS, [PROJECT_FILE]: JSON.stringify({ skills: { 'ui-checklist': { always: true } } }), [SETTINGS_PATH]: HOOK_SETTINGS('bash ~/.claude/hooks/ui-checklist-reload.sh') }
  const w = world(on, files, { skills: SKILLS, answers: ['Keep'] })
  await start($)
  await run($, 'migrate')
  expect(w.asked[0]).toMatch(/does not watch ui-checklist yet/)
})

test('migrate: a bare word that names a watched skill is a guess with the warning', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: HOOK_SETTINGS('echo writing-guide') }, { skills: SKILLS, answers: ['Keep'] })
  await start($)
  await run($, 'migrate')
  expect(w.asked[0]).toMatch(/guess: /)
  expect(w.asked[0]).toMatch(/without reminders/)
  expect(w.options[0]![0]).toBe('Keep')
})

test('migrate: a script file that names a watched skill has no warning and Turn off first', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: HOOK_SETTINGS('bash ~/.claude/hooks/writing-guide-reload.sh') }, { skills: SKILLS, answers: ['Keep'] })
  await start($)
  await run($, 'migrate')
  expect(w.asked[0]).not.toMatch(/without reminders/)
  expect(w.options[0]![0]).toBe('Turn off')
})

test('migrate notes a watched skill that is not installed in this session', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS, [SETTINGS_PATH]: HOOK_SETTINGS('bash ~/.claude/hooks/writing-guide-reload.sh') }, { skills: ['pdf'], answers: ['Keep'] })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  expect(await run($, 'migrate')).toMatch(/writing-guide is configured but not installed in this session/)
})

test('migrate reads the config fresh', async ($, on) => {
  const w = world(on, { [USER_FILE]: '{}', [SETTINGS_PATH]: HOOK_SETTINGS('bash ~/.claude/hooks/writing-guide-reload.sh') }, { skills: SKILLS, answers: ['Keep'] })
  await start($)
  w.files[USER_FILE] = ALWAYS
  await run($, 'migrate')
  expect(w.asked[0]).not.toMatch(/does not watch writing-guide/)
})


// --- Rules, notes and proposals ---

const PROPOSE_TOOL = 'mcp__skill-souffleur__souffleur_propose'
const ENFORCE = JSON.stringify({ mode: 'enforce', skills: {}, needs: {} })
const propose = ($: any, input: Record<string, unknown>) => $.tool.run({ tool: PROPOSE_TOOL, ...input } as never)
const turnEnd = ($: any, extra: Record<string, unknown> = {}) => $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer', ...extra })
const userFile = (w: World) => JSON.parse(w.files[USER_FILE]!)
const AGENT_RULE = { kind: 'rule', before: { tools: ['Agent'] }, skill: 'dev-workflow' }

test('the model proposes through the registered tool and nothing is written without a dialog', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  expect(w.tools.map((t) => t.name)).toEqual(['souffleur_propose'])
  const r = await propose($, { kind: 'note', text: 'Answer in German.', source: 'user' })
  expect(String(r.result)).toMatch(/Queued as note-/)
  const text = await run($, 'review')
  expect(text).toMatch(/no dialog can open/)
  expect(text).toMatch(/Answer in German/)
  expect(w.writes.length).toBe(0)
  expect(w.asked.length).toBe(1)
})

test('a bad proposal is refused with the reason and queues nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE })
  await start($)
  const r = await propose($, { kind: 'rule', before: { tools: ['Agent'] } })
  expect(String(r.result)).toMatch(/Not queued/)
  expect(await run($, 'review')).toMatch(/no proposals/)
  expect(w.asked.length).toBe(0)
})

test('turn end asks one question, and yes everywhere writes the rule and keeps every other key', async ($, on) => {
  const file = JSON.stringify({ mode: 'enforce', trustProjects: ['/w'], skills: { a: { always: true } } })
  const w = world(on, { [USER_FILE]: file }, { answers: ['Yes, everywhere'] })
  await start($)
  await propose($, AGENT_RULE)
  await propose($, { kind: 'note', text: 'Answer in German.' })
  expect(w.asked.length).toBe(0)
  await turnEnd($)
  expect(w.asked).toEqual(['Add rule: before Agent: skill dev-workflow loaded?'])
  expect(w.options[0]).toEqual(['Yes, everywhere', 'Yes, this project only', 'No'])
  const doc = userFile(w)
  expect(doc.mode).toBe('enforce')
  expect(doc.trustProjects).toEqual(['/w'])
  expect(doc.skills).toEqual({ a: { always: true } })
  expect(doc.rules.length).toBe(1)
  expect('where' in doc.rules[0]).toBe(false)
  expect(w.toasts.join('\n')).toMatch(/added rule/)
  // The new rule is live at once: dev-workflow is a ledger entry and the rule denies.
  const denied = await $.tool.call({ tool: 'Agent', prompt: 'x' } as never)
  expect(denied.deny).toMatch(/dev-workflow/)
})

test('yes for this project writes a rule into projects[main root] and no where', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['Yes, this project only'], repoRoot: '/work/main' })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  const doc = userFile(w)
  expect(doc.rules).toBeUndefined()
  expect(doc.projects['/work/main'].rules.length).toBe(1)
  expect(doc.projects['/work/main'].rules[0].skill).toBe('dev-workflow')
  expect('where' in doc.projects['/work/main'].rules[0]).toBe(false)
  expect(w.toasts.join('\n')).toMatch(/added rule .* to .* for \/work\/main/)
  // The reload keeps it and `project` lists it as this project's own.
  expect(await run($, 'project')).toMatch(/This project only: rule /)
})

test('yes for this project writes a note into projects[main root], next to an own skill and need', async ($, on) => {
  const file = JSON.stringify({ mode: 'enforce', skills: {}, needs: {}, projects: { '/work/main': { skills: { own: { always: true } }, needs: { ui: { what: 'UI work' } } } } })
  const w = world(on, { [USER_FILE]: file }, { answers: ['Yes, this project only'], repoRoot: '/work/main' })
  await start($)
  await propose($, { kind: 'note', text: 'Answer in German.' })
  await turnEnd($)
  const block = userFile(w).projects['/work/main']
  expect(userFile(w).notes).toBeUndefined()
  expect(block.notes.length).toBe(1)
  expect('where' in block.notes[0]).toBe(false)
  expect(block.skills).toEqual({ own: { always: true } })
  expect(block.needs).toEqual({ ui: { what: 'UI work' } })
  expect(await run($, 'project')).toMatch(/This project only: skill own, note /)
})

test('accept <id> here writes into the project block too', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', repoRoot: '/work/main' })
  await start($)
  const id = idOf(await propose($, note('Answer in German.')))
  await run($, `accept ${id} here`)
  expect(userFile(w).notes).toBeUndefined()
  expect(userFile(w).projects['/work/main'].notes[0].id).toBe(id)
})

test('a project-only proposal that reuses a standard id is refused, nothing is written and it stays queued', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', repoRoot: '/work/main' })
  await start($)
  const id = idOf(await propose($, note('Keep it short.')))
  w.files[USER_FILE] = JSON.stringify({ mode: 'enforce', skills: {}, needs: {}, notes: [{ id, text: 'Standard text.' }] })
  const before = w.writes.length
  const out = await run($, `accept ${id} here`)
  expect(out).toMatch(/already in the standard; block it first or rename/)
  expect(out).toMatch(/stays queued/)
  expect(w.writes.length).toBe(before)
  expect(userFile(w).projects).toBeUndefined()
})

test('an existing top-level where entry still applies', async ($, on) => {
  const file = JSON.stringify({ mode: 'enforce', skills: {}, needs: {}, rules: [{ id: 'r-old', before: { tools: ['Agent'] }, skill: 'dev-workflow', where: '/work/main' }] })
  world(on, { [USER_FILE]: file }, { repoRoot: '/work/main' })
  await start($)
  const denied = await $.tool.call({ tool: 'Agent', prompt: 'x' } as never)
  expect(denied.deny).toMatch(/dev-workflow/)
})

test('no declines it for good: the hash is stored and the proposal is not queued again', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['No'] })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(w.writes.length).toBe(0)
  w.setId('s2')
  await start($)
  const again = await propose($, AGENT_RULE)
  expect(String(again.result)).toMatch(/declined this before/)
  expect(await run($, 'review')).toMatch(/no proposals/)
})

test('a headless run opens no dialog, even one that would never answer', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['Yes, everywhere'], holdAsk: true })
  await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: false })
  await $.prompt.submit({ text: 'hello', origin: { kind: 'sdk' } } as never)
  await propose($, AGENT_RULE)
  await propose($, { ...AGENT_RULE, before: { tools: ['Bash'] } })
  await turnEnd($)
  await turnEnd($)
  expect(w.asked.length).toBe(0)
  expect(w.writes.length).toBe(0)
  expect(await table($)).toMatch(/Open proposals \(2\)/)
})

test('a Remote Control session (not interactive, bridge prompt) still asks', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['Yes, everywhere'] })
  await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: false })
  await $.prompt.submit({ text: 'hello', origin: { kind: 'bridge' } } as never)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
})

test('a subagent turn end asks nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['Yes, everywhere'] })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($, { agentId: 'a1' })
  expect(w.asked.length).toBe(0)
})

test('a dismissed dialog leaves the proposal queued and stops asking this session', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(await table($)).toMatch(/Open proposals \(1\)/)
  expect(w.writes.length).toBe(0)
})

test('/souffleur accept writes in text mode, and "here" scopes it to the project', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', repoRoot: '/work/main' })
  await start($)
  const r1 = await propose($, AGENT_RULE)
  const id = /Queued as (\S+)\./.exec(String(r1.result))![1]!
  expect(await run($, 'accept nope')).toMatch(/no proposal nope/)
  expect(await run($, `accept ${id} here`)).toMatch(/added rule/)
  expect(userFile(w).rules).toBeUndefined()
  expect(userFile(w).projects['/work/main'].rules[0].skill).toBe('dev-workflow')
  expect(await run($, 'review')).toMatch(/no proposals/)
})

test('a user file that cannot be read keeps the proposal and writes nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const r = await propose($, AGENT_RULE)
  const id = /Queued as (\S+)\./.exec(String(r.result))![1]!
  w.files[USER_FILE] = '{ broken'
  const text = await run($, `accept ${id}`)
  expect(text).toMatch(/not valid JSON/)
  expect(text).toMatch(/stays queued/)
  expect(w.writes.length).toBe(0)
})

test('a user file whose rules key is not a list is never edited', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ rules: 'nope' }) }, { answers: 'reject' })
  await start($)
  const r = await propose($, AGENT_RULE)
  const id = /Queued as (\S+)\./.exec(String(r.result))![1]!
  expect(await run($, `accept ${id}`)).toMatch(/"rules" is not a list/)
  expect(w.writes.length).toBe(0)
})

test('a missing user file is created with just the new entry', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const r = await propose($, AGENT_RULE)
  const id = /Queued as (\S+)\./.exec(String(r.result))![1]!
  const l = w as unknown as { files: Record<string, string> }
  delete l.files[USER_FILE]
  // Missing file: it is created with just the new entry.
  expect(await run($, `accept ${id}`)).toMatch(/added rule/)
  expect(Object.keys(JSON.parse(w.writes.at(-1)!.text))).toEqual(['rules'])
})

test('text typed under Other asks the model to revise, in the next prompt context', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['Only when the brief is long'] })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(w.writes.length).toBe(0)
  const r = await $.prompt.submit({ text: 'go on' })
  expect(r.context?.join('\n')).toMatch(/Only when the brief is long/)
  expect(r.context?.join('\n')).toMatch(/souffleur_propose/)
  const r2 = await $.prompt.submit({ text: 'and more' })
  expect(r2.context?.join('\n') ?? '').not.toMatch(/Only when the brief is long/)
})

test('/souffleur rule: the small model shapes the words, and failure keeps them as a note', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['Yes, everywhere'], shaped: '{"kind":"rule","before":{"tools":["Agent"]},"field":"model"}' })
  await start($)
  expect(await run($, 'rule name a model for every Agent call')).toMatch(/added rule/)
  expect(userFile(w).rules[0].field).toBe('model')
})

test('/souffleur rule: a garbled model answer keeps the words as a note, queued without a dialog', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', shaped: 'garbage' })
  await start($)
  expect(await run($, 'rule Always answer in German')).toMatch(/queued note/)
  expect(await run($, 'review')).toMatch(/note .*Always answer in German/)
  expect(w.writes.length).toBe(0)
})

test('a confirmed note is sent once in the next prompt, and notes show in the system prompt section', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ notes: [{ id: 'lang', text: 'Reply in German.', source: 'user' }] }) }, { answers: ['Yes, everywhere'] })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const section = (await $.prompt.compose(COMPOSE)).sections.find((s: { id: string }) => s.id === 'souffleur')
  expect(section?.text).toMatch(/Reply in German\./)
  expect(section?.text).toMatch(/souffleur_propose/)
  await propose($, { kind: 'note', text: 'Keep answers short.' })
  await turnEnd($)
  expect(userFile(w).notes.length).toBe(2)
  const r = await $.prompt.submit({ text: 'hello' })
  expect(r.context?.join('\n')).toMatch(/Keep answers short\./)
  expect(r.context?.join('\n') ?? '').not.toMatch(/Reply in German/)
  expect((await $.prompt.submit({ text: 'again' })).context?.join('\n') ?? '').not.toMatch(/Keep answers short/)
})

test('the section leaves out the propose sentence when the tool did not register', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { failToolRegister: true })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const section = (await $.prompt.compose(COMPOSE)).sections.find((s: { id: string }) => s.id === 'souffleur')
  expect(section?.text).not.toMatch(/souffleur_propose/)
})

test('a field rule denies an Agent call without model once, with the real call fields', async ($, on) => {
  world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', rules: [{ id: 'agent-names-model', before: { tools: ['Agent'] }, field: 'model', source: 'slip' }] }) })
  await start($)
  const first = await $.tool.call({ tool: 'Agent', prompt: 'x' } as never)
  expect(first.deny).toMatch(/agent-names-model/)
  expect((await $.tool.call({ tool: 'Agent', prompt: 'x' } as never)).deny).toBe(undefined)
  expect((await $.tool.call({ tool: 'Agent', prompt: 'x', model: 'sonnet' } as never)).deny).toBe(undefined)
})

test('a field rule on tool_use_id treats the metadata key as missing when no argument carries it', async ($, on) => {
  world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', rules: [{ id: 'agent-names-tool-use-id', before: { tools: ['Agent'] }, field: 'tool_use_id', source: 'slip' }] }) })
  await start($)
  expect((await $.tool.call({ tool: 'Agent', prompt: 'x', tool_use_id: 't1' } as never)).deny).toMatch(/agent-names-tool-use-id/)
})

test('migrate queues the standing instructions it found as note proposals and writes nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS, [CLAUDE_MD]: 'Always invoke writing-guide before writing prose.\nOther text.' }, { skills: ['writing-guide'], answers: 'reject' })
  await start($)
  const text = await run($, 'migrate')
  expect(text).toMatch(/1 passage queued as note proposals/)
  expect(await run($, 'review')).toMatch(/invoke writing-guide before writing prose/)
  expect(w.writes.length).toBe(0)
})

test('a proposal from a session stored before rules existed still works', async ($, on) => {
  const old = { ...initSession(parseConfig(ALWAYS, undefined).config, 's1', 0, 'startup'), proposals: undefined, declined: undefined }
  world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:s1': old } })
  await start($)
  const r = await propose($, { kind: 'note', text: 'Reply in German.' })
  expect(String(r.result)).toMatch(/Queued/)
})

test('a read error on the user file stops the write and keeps the proposal', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const r = await propose($, AGENT_RULE)
  const id = /Queued as (\S+)\./.exec(String(r.result))![1]!
  w.failRead.push(USER_FILE)
  const text = await run($, `accept ${id}`)
  expect(text).toMatch(/could not read ~\/\.claude\/souffleur\.json/)
  expect(text).toMatch(/stays queued/)
  expect(w.writes.length).toBe(0)
})


// --- Fix round ---

const idOf = (r: { result?: unknown }) => /Queued as (\S+)\./.exec(String(r.result))![1]!
const note = (text: string) => ({ kind: 'note', text })

test('a written entry the reader drops is reported, not announced as added', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', onWrite: (path) => { if (path === USER_FILE) w.files[USER_FILE] = '{"mode":"enforce"}' } })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  const text = await run($, `accept ${id}`)
  expect(text).toMatch(/did not keep it/)
  expect(text).not.toMatch(/added note/)
})

test('accept takes only here or project as a second word', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', repoRoot: '/work/main' })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  expect(await run($, `accept ${id} banana`)).toMatch(/Usage: \/souffleur accept/)
  expect(w.writes.length).toBe(0)
  expect(await run($, `accept ${id} project`)).toMatch(/added note/)
  expect(userFile(w).notes).toBeUndefined()
  expect(userFile(w).projects['/work/main'].notes[0].id).toBe(id)
})

test('decline records the hash like No, and it survives a new session id through the store', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  expect(await run($, `decline ${id}`)).toMatch(/not added/)
  expect(await run($, 'decline nope')).toMatch(/no proposal nope/)
  expect(w.writes.length).toBe(0)
  w.setId('s2')
  await start($)
  expect(String((await propose($, note('Reply in German.'))).result)).toMatch(/declined this before/)
})

test('accept, decline, rule and review only act when the user typed them', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', shaped: '' })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  for (const args of [`accept ${id}`, `decline ${id}`, 'rule Always say hi', 'review']) {
    const r = await $.command.run({ command: 'souffleur', args, origin: { kind: 'plugin', name: 'other' } } as never)
    expect(String(r.text)).toMatch(/only the user can run/i)
  }
  expect(w.writes.length).toBe(0)
  expect(await run($, 'review')).toMatch(new RegExp(id))
})

test('/souffleur rule falls back to the queued text when no dialog opens', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', shaped: '{"kind":"note","text":"Always say hi"}' })
  await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: false })
  expect(await run($, 'rule Always say hi')).toMatch(/queued note/)
  expect(w.writes.length).toBe(0)
})

test('the user file is read again just before the write, and a changed file stops it', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  w.driftAfter(USER_FILE, 1, true)
  const text = await run($, `accept ${id}`)
  expect(text).toMatch(/kept changing/)
  expect(text).toMatch(/stays queued/)
  expect(w.writes.length).toBe(0)
})

test('proposals made at the same moment are all kept', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const calls = ['a', 'b', 'c', 'd'].map((x) => propose($, note(`Note number ${x}.`)))
  await Promise.all(calls)
  const text = await run($, 'review')
  for (const x of ['a', 'b', 'c', 'd']) expect(text).toMatch(new RegExp(`Note number ${x}`))
})

test('a subagent may not propose, and the model gets five proposals per session', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  expect(String((await propose($, { ...note('From a subagent.'), agentId: 'a1' })).result)).toMatch(/main session/)
  for (let i = 0; i < 5; i++) expect(String((await propose($, note(`Note ${i} here.`))).result)).toMatch(/Queued/)
  expect(String((await propose($, note('One too many.'))).result)).toMatch(/five proposals/)
})

test('a dialog that cannot open does not stop proposals, and the reply still says a notice or dialog follows', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('First note here.'))
  await turnEnd($)
  expect(String((await propose($, note('Second note here.'))).result)).toMatch(/Queued as note-.*notice they answer with a reply/)
})

test('a dialog that fails under /souffleur rule does not stop the turn-end questions', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: [], shaped: '{"kind":"note","text":"Always say hi"}' })
  await start($)
  await run($, 'rule Always say hi')
  w.answers.push('No')
  await turnEnd($)
  expect(w.asked.length).toBe(2)
})

test('a passage proposal names its file and line, and a project file offers this project first', async ($, on) => {
  const line = 'Always invoke writing-guide before writing prose.'
  const w = world(on, { [USER_FILE]: ALWAYS, ['/work/proj/CLAUDE.md']: `Intro\n${line}\n${line}` }, { skills: ['writing-guide'], answers: ['No'] })
  await start($)
  const text = await run($, 'migrate')
  expect(text).toMatch(/1 passage queued/)
  expect(text).toMatch(/1 skipped/)
  expect(text).toMatch(/already (known|waiting)/)
  await run($, 'review')
  expect(w.asked[0]).toMatch(/from .*CLAUDE\.md:2/)
  expect(w.options[0]![0]).toBe('Yes, this project only')
})

// ---- learning from skills ----

const OBLIGATION = 'Always run `npm test` after editing files under src/.'
const TEST_RULE = { kind: 'rule', after: { tools: ['Edit'], paths: ['src/**'] }, evidence: { tool: 'Bash', command: 'npm test' } }
const answerWith = (...items: unknown[]) => () => JSON.stringify(items)
/** Lets the background read finish: the mod does not hand it back to the hook. */
const settle = () => fakeClock.settle()
const loadSkill = ($: any, skill: string, text = OBLIGATION, extra: Record<string, unknown> = {}) => $.skill.prompt({ skill, text, len: text.length, head: text, tail: text, ...extra })
const mainLoad = async ($: any, skill: string, text = OBLIGATION, extra: Record<string, unknown> = {}) => {
  await $.tool.call({ tool: 'Skill', skill } as never)
  const r = await loadSkill($, skill, text, extra)
  await settle()
  return r
}

test('a skill text is read in the background and its proposals land in the queue with source skill:<name>', async ($, on) => {
  const calls: string[] = []
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillCalls: calls, skillAnswer: answerWith(TEST_RULE, { kind: 'note', text: 'Reply in German.' }) })
  await start($)
  await mainLoad($, 'writing-guide')
  expect(calls.length).toBe(1)
  expect(calls[0]).toMatch(/npm test/)
  const text = await run($, 'review')
  expect(text).toMatch(/skill:writing-guide/)
  expect(text).toMatch(/npm test/)
  expect(text).toMatch(/Reply in German/)
  expect(w.writes.length).toBe(0)
})

test('a skill text is read once per session while its proposals wait; a new session offers an unanswered one again', async ($, on) => {
  const calls: string[] = []
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillCalls: calls, skillAnswer: answerWith(TEST_RULE) })
  await start($)
  await mainLoad($, 'writing-guide')
  await mainLoad($, 'writing-guide')
  expect(calls.length).toBe(1)
  w.setId('s2')
  await start($)
  await mainLoad($, 'writing-guide')
  expect(calls.length, 'its proposals were never answered, so the new session offers it again').toBe(2)
  await mainLoad($, 'writing-guide', `${OBLIGATION} Also lint.`)
  expect(calls.length).toBe(3)
})

test('at most five skills are read per session', async ($, on) => {
  const calls: string[] = []
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillCalls: calls })
  await start($)
  for (let i = 0; i < 7; i++) await mainLoad($, `skill-${i}`, `Always do thing ${i}.`)
  expect(calls.length).toBe(5)
})

test('a subagent load is not read', async ($, on) => {
  const calls: string[] = []
  let release = () => {}
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillCalls: calls, holdAgent: new Promise<void>((r) => { release = r }) })
  await start($)
  const agent = $.tool.call({ tool: 'Agent', prompt: 'x' } as never)
  await settle()
  await agentRuns($, 'a1')
  await loadSkill($, 'writing-guide')
  await settle()
  expect(calls.length).toBe(0)
  release()
  await agent
})

test('a typed /name load is read', async ($, on) => {
  const calls: string[] = []
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillCalls: calls })
  await start($)
  await loadSkill($, 'writing-guide')
  await settle()
  expect(calls.length).toBe(1)
})

test('garbage or oversized model output yields no proposals', async ($, on) => {
  const answers = ['I cannot help with that.', '{"kind":"rule"', `[${'{"kind":"note","text":"x"},'.repeat(5000)}]`, '[{"kind":"note","text":"a\\nb"}]']
  const calls: string[] = []
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillCalls: calls, skillAnswer: () => answers.shift() ?? '' })
  await start($)
  for (let i = 0; i < 4; i++) await mainLoad($, `skill-${i}`, `Always do thing ${i}.`)
  expect(calls.length).toBe(4)
  expect(await run($, 'review')).toMatch(/no proposals/)
  expect(await table($)).not.toMatch(/degraded/)
})

test('more than three proposals from one skill are cut to three', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillAnswer: answerWith(...[1, 2, 3, 4, 5].map((i) => ({ ...TEST_RULE, evidence: { tool: 'Bash', command: `npm test ${i}` } }))) })
  await start($)
  await mainLoad($, 'writing-guide', `${OBLIGATION} ${[1, 2, 3, 4, 5].map((i) => `npm test ${i}`).join(' ')}`)
  expect((await run($, 'review')).match(/skill:writing-guide/g)?.length).toBe(3)
})

test('learn.skills false reads nothing', async ($, on) => {
  const calls: string[] = []
  world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', learn: { skills: false } }) }, { answers: 'reject', skillCalls: calls })
  await start($)
  await mainLoad($, 'writing-guide')
  expect(calls.length).toBe(0)
})

test('a slow or failing model call never delays or breaks skill.prompt', async ($, on) => {
  let mode: 'hang' | 'fail' = 'hang'
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillAnswer: () => (mode === 'hang' ? new Promise<string>(() => {}) : Promise.reject(new Error('model down'))) })
  await start($)
  // The model call never answers: the hook must still return (a hang fails the test by its own timeout).
  await loadSkill($, 'writing-guide')
  mode = 'fail'
  const second = await loadSkill($, 'other-skill', 'Always do the other thing.')
  expect(second).toBeDefined()
  await settle()
  expect(await table($)).not.toMatch(/degraded/)
  expect(await run($, 'review')).toMatch(/no proposals/)
})

test('proposals respect declined hashes, existing rules and the queue', async ($, on) => {
  const declinedHash = makeProposal(TEST_RULE, 'skill:x', { userNeeds: [] }).proposal!.hash
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', stored: { 'souffleur:declined': [declinedHash] }, skillAnswer: answerWith(TEST_RULE, { kind: 'note', text: 'Reply in German.' }) })
  await start($)
  await mainLoad($, 'writing-guide')
  const text = await run($, 'review')
  expect(text).not.toMatch(/npm test/)
  expect(text).toMatch(/Reply in German/)
})

// ---- review fixes ----

const hashOf = (name: string, text = OBLIGATION) => skillHash(name, text)

test('nothing is read in a session without a person at the prompt', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const calls: string[] = []
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', stored, skillCalls: calls })
  await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: false })
  await mainLoad($, 'writing-guide')
  expect(calls.length).toBe(0)
  expect(stored[hashKey(hashOf('writing-guide'))]).toBe(undefined)
})

test('nothing is read when Souffleur is not set up or paused', async ($, on) => {
  const calls: string[] = []
  world(on, {}, { answers: 'reject', skillCalls: calls })
  await start($)
  await mainLoad($, 'writing-guide')
  expect(calls.length).toBe(0)
})

test('nothing is read while paused', async ($, on) => {
  const calls: string[] = []
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillCalls: calls })
  await start($)
  await run($, 'pause')
  await mainLoad($, 'writing-guide')
  expect(calls.length).toBe(0)
})

test('the version is marked offered after the proposals were queued, and not at all when the queue is full', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const calls: string[] = []
  const texts = [0, 1, 2].map((i) => `Always run cmd-${i}-a, cmd-${i}-b and cmd-${i}-c.`)
  let n = 0
  world(on, { [USER_FILE]: ENFORCE }, {
    answers: 'reject',
    stored,
    skillCalls: calls,
    skillAnswer: () => {
      const i = n++
      return JSON.stringify(['a', 'b', 'c'].map((x) => ({ kind: 'rule', after: { tools: ['Edit'] }, evidence: { tool: 'Bash', command: `cmd-${i}-${x}` } })))
    },
  })
  await start($)
  await mainLoad($, 'skill-0', texts[0]!)
  expect(stored[hashKey(hashOf('skill-0', texts[0]!))]).toMatchObject({ offers: 1 })
  await mainLoad($, 'skill-1', texts[1]!)
  await mainLoad($, 'skill-2', texts[2]!)
  expect(calls.length).toBe(3)
  expect(stored[hashKey(hashOf('skill-2', texts[2]!))]).toBe(undefined)
  expect(stored['souffleur:skill-hashes']).toBe(undefined)
})

test('a project skill is not read for an untrusted root', async ($, on) => {
  const calls: string[] = []
  world(on, { [USER_FILE]: ENFORCE }, { answers: ['No'], skillCalls: calls, skillAnswer: answerWith(TEST_RULE) })
  await start($)
  await mainLoad($, 'writing-guide', OBLIGATION, { source: 'projectSettings' })
  await mainLoad($, 'tool-server', OBLIGATION, { source: 'mcp' })
  expect(calls.length).toBe(0)
})

test('a project skill of a trusted root is read, named, and asks for this project first', async ($, on) => {
  const calls: string[] = []
  const w = world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', trustProjects: ['/work/proj'] }) }, { answers: ['No'], skillCalls: calls, skillAnswer: answerWith(TEST_RULE) })
  await start($)
  await mainLoad($, 'writing-guide', OBLIGATION, { source: 'projectSettings' })
  expect(calls.length).toBe(1)
  await turnEnd($)
  expect(w.asked[0]).toMatch(/^Read from a skill's text, not verified: add rule from project skill writing-guide/)
  expect(w.options[0]![0]).toBe('Yes, this project only')
})

test('a plugin skill is named in the question', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['No'], skillAnswer: answerWith(TEST_RULE) })
  await start($)
  await mainLoad($, 'terse-mode', OBLIGATION, { source: 'plugin', pluginName: 'terse' })
  await turnEnd($)
  expect(w.asked[0]).toMatch(/from plugin terse \(terse-mode\)/)
})

test('the model call has a 30 second limit; an unanswered call is released and given up after three tries', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const calls: string[] = []
  const requests: Record<string, unknown>[] = []
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', stored, skillCalls: calls, skillRequests: requests, skillAnswer: () => null })
  await start($)
  for (let i = 0; i < 5; i++) await mainLoad($, 'writing-guide')
  expect(calls.length).toBe(3)
  expect(requests[0]!.timeoutMs).toBe(30000)
  expect(stored[hashKey(hashOf('writing-guide'))]).toMatchObject({ fails: 3 })
  await mainLoad($, 'other', 'Always run `npm test`.')
  expect(calls.length).toBe(4)
})

test('an answer that does not parse counts as a failure; a failed read gives its session slot back', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const calls: string[] = []
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', stored, skillCalls: calls, skillAnswer: () => 'I cannot do that.' })
  await start($)
  await mainLoad($, 'writing-guide')
  expect(stored[hashKey(hashOf('writing-guide'))]).toMatchObject({ fails: 1 })
  for (let i = 0; i < 4; i++) await mainLoad($, `skill-${i}`, `Always do ${i}.`)
  expect(calls.length).toBe(5)
  await mainLoad($, 'skill-last', 'Always do the last thing.')
  expect(calls.length).toBe(6)
})

test('the skill file at path decides the version and is what the model reads', async ($, on) => {
  const calls: string[] = []
  const file = '/work/proj/.claude/skills/writing-guide/SKILL.md'
  world(on, { [USER_FILE]: ENFORCE, [file]: 'FILE TEXT: always run `npm test`.' }, { answers: 'reject', skillCalls: calls })
  await start($)
  await mainLoad($, 'writing-guide', 'Arguments: first run', { path: file })
  await mainLoad($, 'writing-guide', 'Arguments: second run', { path: file })
  expect(calls.length).toBe(1)
  expect(calls[0]).toMatch(/FILE TEXT/)
  expect(calls[0]).not.toMatch(/Arguments/)
  await mainLoad($, 'no-file', 'Always do this.', { path: '/missing/SKILL.md' })
  expect(calls[1]).toMatch(/Always do this/)
})

test('two loads of the same new text at once read it once', async ($, on) => {
  const calls: string[] = []
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillCalls: calls, skillAnswer: answerWith(TEST_RULE) })
  await start($)
  await $.tool.call({ tool: 'Skill', skill: 'writing-guide' } as never)
  await $.tool.call({ tool: 'Skill', skill: 'writing-guide' } as never)
  await Promise.all([loadSkill($, 'writing-guide'), loadSkill($, 'writing-guide')])
  await settle()
  expect(calls.length).toBe(1)
})

test('a single object answer is accepted', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillAnswer: () => JSON.stringify(TEST_RULE) })
  await start($)
  await mainLoad($, 'writing-guide')
  expect(await run($, 'review')).toMatch(/npm test/)
})

test('a skill name with bidi or control characters never reaches the source, the origin or the prompt', async ($, on) => {
  const calls: string[] = []
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillCalls: calls, skillAnswer: answerWith(TEST_RULE) })
  await start($)
  await mainLoad($, 'evil\u202e\nname')
  const text = await run($, 'review')
  expect(text).not.toMatch(/[\u202e]/)
  expect(text).toMatch(/skill:evil-/)
  expect(calls[0]).not.toMatch(/[\u202e]/)
})

test('a main Skill call for an unlisted skill is read even while a subagent runs', async ($, on) => {
  const calls: string[] = []
  let release = () => {}
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillCalls: calls, holdAgent: new Promise<void>((r) => { release = r }) })
  await start($)
  const agent = $.tool.call({ tool: 'Agent', prompt: 'x' } as never)
  await settle()
  await $.tool.call({ tool: 'Skill', skill: 'writing-guide' } as never)
  await loadSkill($, 'writing-guide')
  await settle()
  expect(calls.length).toBe(1)
  release()
  await agent
})

// ---- review before 0.1.0 ----

const PROJECT_ALWAYS = JSON.stringify({ skills: { 'proj-skill': { always: true } } })
const systemSection = async ($: any) => (await $.prompt.compose(COMPOSE)).sections.find((x: { id: string }) => x.id === 'souffleur')?.text as string

test('untrusted project file: no restore text and no system prompt mention for its skills', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE, [PROJECT_FILE]: PROJECT_ALWAYS })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const r = await $.prompt.submit({ text: 'hello' })
  expect(r.context).toBe(undefined)
  expect(await systemSection($)).not.toMatch(/proj-skill/)
  expect(await table($)).toMatch(/not trusted/)
})

test('trusted project file (with a trailing slash in trustProjects): restore text and system prompt name its skills', async ($, on) => {
  world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', trustProjects: ['/work/proj/'] }), [PROJECT_FILE]: JSON.stringify({ skills: { 'proj-skill': { always: true, for: 'chat' } } }) }, { repoRoot: '/work/proj' })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const r = await $.prompt.submit({ text: 'hello' })
  expect(r.context?.join('\n')).toMatch(/proj-skill/)
  expect(await systemSection($)).toMatch(/follow proj-skill;/)
})

test('untrusted project file: a project need is not classified and its brief check does not deny', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE, [PROJECT_FILE]: JSON.stringify({ skills: { 'proj-skill': { need: 'pn' } }, needs: { pn: 'A project need.' } }) }, { classify: 'match' })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  expect(w.classifyCalls()).toBe(0)
  await run($, 'need pn')
  const r = await $.tool.call({ tool: 'Agent', prompt: 'do it' } as never)
  expect(r.deny).toBe(undefined)
})

test('three classifier failures in a row make the status degraded, a good run clears it', async ($, on) => {
  let answer = 'unsure'
  const w = world(on, { [USER_FILE]: JSON.stringify({ skills: { g: { need: 'n' } }, needs: { n: 'Something.' } }) }, { classify: () => answer })
  await start($)
  await $.prompt.submit({ text: 'one' })
  await $.prompt.submit({ text: 'two' })
  expect(w.statuses.at(-1)).not.toMatch(/degraded/)
  await $.prompt.submit({ text: 'three' })
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · degraded, see \/souffleur$/)
  expect(await table($)).toMatch(/classifier: /)
  // the breaker skips the next 10 prompts; the probe after them succeeds and clears it
  for (let i = 0; i < 10; i++) await $.prompt.submit({ text: `wait ${i}` })
  expect(w.statuses.at(-1)).toMatch(/degraded/)
  answer = 'no-match'
  await $.prompt.submit({ text: 'four' })
  expect(w.statuses.at(-1)).not.toMatch(/degraded/)
})

test('three failed learn calls in a row make the status degraded', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', skillAnswer: () => null })
  await start($)
  for (let i = 0; i < 3; i++) await mainLoad($, `skill-${i}`, `Always do ${i}.`)
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · degraded, see \/souffleur$/)
  expect(await table($)).toMatch(/learn: /)
})

test('pause stops classifier calls and turn-end questions; resume brings them back', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ skills: { g: { need: 'n' } }, needs: { n: 'Something.' } }) }, { answers: ['No'] })
  await start($)
  await propose($, { kind: 'note', text: 'Always say hi.' })
  const before = w.classifyCalls()
  const asked = w.asked.length
  await run($, 'pause')
  await $.prompt.submit({ text: 'while paused' })
  expect(w.classifyCalls()).toBe(before)
  await turnEnd($)
  expect(w.asked.length).toBe(asked)
  expect(await run($, 'resume')).toMatch(/on again/)
  await $.prompt.submit({ text: 'after resume' })
  expect(w.classifyCalls()).toBe(before + 2)
  await turnEnd($)
  expect(w.asked.length).toBe(asked + 1)
})

test('pause is not carried over when the session is resumed', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await run($, 'pause')
  expect(await table($)).toMatch(/\(paused\)/)
  await start($)
  expect(await table($)).not.toMatch(/\(paused\)/)
  expect(w.statuses.length).toBeGreaterThan(0)
})

test('a hand edit of the user file shows in /souffleur at once and at the next session start', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  expect(await table($)).not.toMatch(/ui-checklist/)
  w.files[USER_FILE] = JSON.stringify({ skills: { 'writing-guide': { always: true }, 'ui-checklist': { always: true } } })
  expect(await table($)).toMatch(/ui-checklist/)
  w.files[USER_FILE] = JSON.stringify({ skills: { 'writing-guide': { always: true }, extra: { always: true } } })
  await start($)
  expect(await table($)).toMatch(/extra/)
  w.files[USER_FILE] = '{ broken'
  expect(await table($)).toMatch(/invalid JSON/)
})

test('a session stores its timestamp, and session entries older than 14 days are removed at session start', async ($, on) => {
  const day = 86_400_000
  const old = { id: 'old', ledger: {}, touched: T0 - 15 * day }
  const recent = { id: 'recent', ledger: {}, touched: T0 - 13 * day }
  const unstamped = { id: 'unstamped', ledger: {} }
  const w = world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:old': old, 'session:recent': recent, 'session:unstamped': unstamped, 'souffleur:declined': ['h'], 'souffleur:skill-hash:abc': { done: true } } })
  await start($)
  await settle()
  expect(w.stored['session:old']).toBe(undefined)
  expect(w.stored['session:recent']).toBeDefined()
  expect(w.stored['souffleur:declined']).toEqual(['h'])
  expect(w.stored['souffleur:skill-hash:abc']).toMatchObject({ done: true })
  expect(typeof (w.stored['session:s1'] as { touched: number }).touched).toBe('number')
  expect(typeof (w.stored['session:unstamped'] as { touched?: number }).touched, 'a legacy copy gets a stamp and goes after 14 days').toBe('number')
})

test('a skill version is done only when its proposals were answered; a dropped queue offers it again, three times at most', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const calls: string[] = []
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['No'], stored, skillCalls: calls, skillAnswer: answerWith(TEST_RULE) })
  const key = hashKey(hashOf('writing-guide'))
  await start($)
  await mainLoad($, 'writing-guide')
  expect(stored[key]).toMatchObject({ offers: 1 })
  await mainLoad($, 'writing-guide')
  expect(calls.length, 'its proposals still wait in this session').toBe(1)
  for (const id of ['s2', 's3']) {
    w.setId(id)
    await start($)
    await mainLoad($, 'writing-guide')
  }
  expect(calls.length).toBe(3)
  expect(stored[key]).toMatchObject({ offers: 3 })
  w.setId('s4')
  await start($)
  await mainLoad($, 'writing-guide')
  expect(calls.length, 'three offers are the end').toBe(3)
})

test('answering the proposals of a skill version marks it done', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const calls: string[] = []
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['No'], stored, skillCalls: calls, skillAnswer: answerWith(TEST_RULE, { kind: 'note', text: 'Reply in German.' }) })
  const key = hashKey(hashOf('writing-guide'))
  await start($)
  await mainLoad($, 'writing-guide')
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(stored[key], 'one of two answered').toMatchObject({ offers: 1 })
  w.answers.push('Yes, everywhere')
  await turnEnd($)
  expect(stored[key]).toMatchObject({ done: true })
  w.setId('s2')
  await start($)
  await mainLoad($, 'writing-guide')
  expect(calls.length, 'an answered version is not read again').toBe(1)
})

test('a dismissed dialog leaves the version offered, a declined proposal counts as answered', async ($, on) => {
  const stored: Record<string, unknown> = {}
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['__undefined__'], stored, skillAnswer: answerWith(TEST_RULE) })
  const key = hashKey(hashOf('writing-guide'))
  await start($)
  await mainLoad($, 'writing-guide')
  await turnEnd($)
  expect(stored[key]).toMatchObject({ offers: 1 })
  const id = (await table($)).match(/- (rule-[0-9a-f]{8})/)![1]
  expect(await run($, `decline ${id}`)).toMatch(/not added/)
  expect(stored[key]).toMatchObject({ done: true })
  expect(w.asked.length).toBe(1)
})

test('proposals that are all known already mark the version done at once', async ($, on) => {
  const stored: Record<string, unknown> = {}
  world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', rules: [{ id: 'have', after: TEST_RULE.after, evidence: TEST_RULE.evidence, source: 'user' }] }) }, { answers: 'reject', stored, skillAnswer: answerWith(TEST_RULE) })
  await start($)
  await mainLoad($, 'writing-guide')
  expect(stored[hashKey(hashOf('writing-guide'))]).toMatchObject({ done: true })
})

test('start writes one summary line with the plugin version', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  expect(w.logs).toEqual([`Souffleur: ${PLUGIN_VERSION} · observe · 1 always-on, 0 on demand.`])
})

test('start without a user file says it is not set up', async ($, on) => {
  const w = world(on, {})
  await start($)
  expect(w.logs).toEqual([`Souffleur: ${PLUGIN_VERSION} · not set up, run /souffleur init.`])
})

test('compaction then prompt writes the cut line once', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  w.logs.length = 0
  await $.session.compact({ trigger: 'manual' })
  await $.prompt.submit({ text: 'after compact' })
  await $.prompt.submit({ text: 'and again' })
  expect(w.logs.filter((l) => /cut by compaction: writing-guide/.test(l))).toHaveLength(1)
})

test('a subagent compaction writes no line', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  w.logs.length = 0
  await $.session.compact({ trigger: 'manual', agentId: 'a1' } as never)
  expect(w.logs).toEqual([])
})

test('a new session id logs its start line and no diff against the old session', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  w.logs.length = 0
  w.setId('s2')
  await start($)
  expect(w.logs).toHaveLength(1)
  expect(w.logs[0]).toMatch(/^Souffleur: .* · observe/)
})

test('a missing propose tool is registered again and announced once', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await $.prompt.submit({ text: 'first' })
  w.logs.length = 0
  w.dropTool()
  await $.prompt.submit({ text: 'hello' })
  expect(w.tools.map((t) => t.name)).toEqual(['souffleur_propose', 'souffleur_propose'])
  expect(w.logs).toEqual(['Souffleur: tool reconnected.'])
})

test('a present propose tool is left alone', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  w.logs.length = 0
  await $.prompt.submit({ text: 'hello' })
  expect(w.tools).toHaveLength(1)
  expect(w.logs).toEqual([])
})

test('notices false writes no line and still reconnects the tool', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ notices: false, skills: { 'writing-guide': { always: true } } }) })
  await start($)
  await skillLoaded($, 'writing-guide')
  await $.session.compact({ trigger: 'manual' })
  await $.prompt.submit({ text: 'first' })
  w.dropTool()
  await $.prompt.submit({ text: 'hello' })
  expect(w.logs).toEqual([])
  expect(w.tools).toHaveLength(2)
})

test('a throwing ui.log does not break session start or the prompt', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { failLog: true })
  await start($)
  await $.prompt.submit({ text: 'first' })
  w.dropTool()
  const r = await $.prompt.submit({ text: 'hello' })
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
  expect(w.tools).toHaveLength(2)
  expect(w.statuses.at(-1)).not.toMatch(/degraded/)
})

test('start with a broken user file logs the degraded line once', async ($, on) => {
  const w = world(on, { [USER_FILE]: '{bad' })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  expect(w.logs.filter((l) => /degraded/.test(l))).toHaveLength(1)
})

test('resume repeats neither the degraded line nor a cut line', async ($, on) => {
  const w = world(on, { [USER_FILE]: '{bad', 'x': '' })
  await start($)
  await start($)
  expect(w.logs.filter((l) => /degraded/.test(l))).toHaveLength(1)
})

test('resume after a cut repeats no cut line', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  await $.session.compact({ trigger: 'manual' })
  expect(w.logs.filter((l) => /cut by compaction/.test(l))).toHaveLength(1)
  await start($)
  expect(w.logs.filter((l) => /cut by compaction/.test(l))).toHaveLength(1)
})

test('loading a cut skill again writes the reloaded line', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  await $.session.compact({ trigger: 'manual' })
  w.logs.length = 0
  await skillLoaded($, 'writing-guide')
  expect(w.logs).toEqual(['Souffleur: reloaded: writing-guide.'])
})

test('a skill that did not load after two requests writes one problem line', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  for (let i = 0; i < 6; i++) await $.prompt.submit({ text: `p${i}` })
  expect(w.logs.filter((l) => /did not load after two requests/.test(l))).toHaveLength(1)
})

test('a tool the list never shows is registered once, silently', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { listMode: 'hidden' })
  await start($)
  w.logs.length = 0
  await $.prompt.submit({ text: 'one' })
  await $.prompt.submit({ text: 'two' })
  expect(w.tools).toHaveLength(2)
  expect(w.logs).toEqual([])
})

test('a tool seen once and then missing is announced each time it comes back', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await $.prompt.submit({ text: 'one' })
  w.logs.length = 0
  w.dropTool()
  await $.prompt.submit({ text: 'two' })
  await $.prompt.submit({ text: 'three' })
  expect(w.logs.filter((l) => /reconnected/.test(l))).toEqual(['Souffleur: tool reconnected.'])
  expect(w.tools).toHaveLength(2)
})

test('a throwing tool list does not break the prompt or record an error', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { listMode: 'throws' })
  await start($)
  const r = await $.prompt.submit({ text: 'hello' })
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
  expect(w.statuses.at(-1)).not.toMatch(/degraded/)
  expect(w.tools).toHaveLength(1)
})

test('a non-array tool list is skipped without an error', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { listMode: 'junk' })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  expect(w.statuses.at(-1)).not.toMatch(/degraded/)
  expect(w.tools).toHaveLength(1)
})

test('a tool list that never answers does not hold the prompt back', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { listMode: 'hangs' })
  await start($)
  const p = $.prompt.submit({ text: 'hello' })
  await w.clock.advance(300)
  const r = await p
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
  expect(w.tools).toHaveLength(1)
})

// ---- reply words (#44) ----
const reply = ($: any, text: string, origin?: Record<string, unknown>) => $.prompt.submit({ text, ...(origin ? { origin } : {}) } as never)
const COMPOSER = { kind: 'composer' }
const hasLine = (w: World, text: string) => w.seen.prompts.some((p) => (p.context ?? []).some((c) => c.includes(text)))

test('ask rejected: one notice with the reply hint, no second ask', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  await turnEnd($)
  await turnEnd($)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  const lines = w.logs.filter((l) => l.includes(`proposal ${id}`))
  expect(lines.length).toBe(1)
  expect(lines[0]).toMatch(/^Souffleur: proposal note-[0-9a-f]{8}: .*Reply in German.*\. Reply "accept" \(everywhere\) or "decline"\.$/)
})

test('a typed review that cannot ask makes the next turn end ask', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('Reply in German.'))
  await run($, 'review')
  expect(w.asked.length).toBe(1)
  await turnEnd($)
  expect(w.asked.length).toBe(2)
  await turnEnd($)
  expect(w.asked.length).toBe(2)
})

test('reply accept applies the shown proposal', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  await turnEnd($)
  await reply($, ' Accept ', COMPOSER)
  expect(userFile(w).notes.map((n: { text: string }) => n.text)).toEqual(['Reply in German.'])
  expect(hasLine(w, `Souffleur: the user accepted proposal ${id}; nothing else to do for it.`)).toBe(true)
  // the shown id is cleared: a second "yes" is an ordinary prompt
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.length).toBe(1)
})


test('a reply accepts the shown proposal even when another waiting proposal has the same id', async ($, on) => {
  const { config } = parseConfig(ENFORCE, undefined)
  const shown = makeProposal(note('Reply in German.'), 'user', config).proposal!
  const other = makeProposal(note('Reply in French.'), 'user', config).proposal!
  // the short id is 8 hex digits of the hash; a collision is seeded directly, ahead of the shown proposal
  const ahead = { ...other, entry: { ...other.entry, id: shown.entry.id } }
  const stored = { ...initSession(config, 's1', 0, 'startup'), proposals: [ahead, shown] }
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', stored: { 'session:s1': stored } })
  await start($)
  await turnEnd($) // notice for the first proposal
  await reply($, 'carry on', COMPOSER)
  await turnEnd($) // notice for the second, the one the reply answers
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.map((n: { text: string }) => n.text)).toEqual(['Reply in German.'])
  expect(await run($, 'review')).toMatch(/Reply in French/)
})
test('reply decline declines the shown proposal for good', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  await turnEnd($)
  await reply($, 'decline', { kind: 'bridge' })
  expect(w.writes.length).toBe(0)
  expect(hasLine(w, `Souffleur: the user declined proposal ${id}; nothing else to do for it.`)).toBe(true)
  w.setId('s2')
  await start($)
  expect(String((await propose($, note('Reply in German.'))).result)).toMatch(/declined this before/)
})

test('reply from a peer does not accept', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('Reply in German.'))
  await turnEnd($)
  for (const origin of [{ kind: 'peer' }, { kind: 'plugin', name: 'x' }, { kind: 'task-notification' }]) await reply($, 'accept', origin)
  await $.prompt.submit({ text: 'accept', isMeta: true } as never)
  expect(w.writes.length).toBe(0)
  expect(await run($, 'review')).toMatch(/Reply in German/)
})

test('reply word without a shown proposal passes untouched', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('Reply in German.'))
  // no turn end yet: nothing was shown
  await reply($, 'accept', COMPOSER)
  expect(w.writes.length).toBe(0)
  expect(w.seen.prompts.at(-1)).toEqual({ text: 'accept' })
  expect(await run($, 'review')).toMatch(/Reply in German/)
})

test('ja and yes are ordinary prompts after a notice', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('Reply in German.'))
  await turnEnd($)
  await reply($, 'ja', COMPOSER)
  await reply($, 'yes', COMPOSER)
  expect(w.writes.length).toBe(0)
})

test('with notices off nothing was shown, so a reply does not act', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', notices: false, skills: {}, needs: {} }) }, { answers: 'reject' })
  await start($)
  await propose($, note('Reply in German.'))
  await turnEnd($)
  expect(w.logs.length).toBe(0)
  await reply($, 'accept', COMPOSER)
  expect(w.writes.length).toBe(0)
})

test('only the very next person prompt can answer', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('Reply in German.'))
  await turnEnd($)
  await reply($, 'hello', COMPOSER)
  await reply($, 'accept', COMPOSER)
  expect(w.writes.length).toBe(0)
})

test('peer messages and hand-backs do not disarm the offer', async ($, on) => {
  const w2 = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('Reply in German.'))
  await turnEnd($)
  await reply($, 'hello', { kind: 'peer' })
  await reply($, 'hello', { kind: 'task-notification' })
  await reply($, 'accept', COMPOSER)
  expect(userFile(w2).notes.length).toBe(1)
})

const armed = async ($: any, on: any) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('Reply in German.'))
  await turnEnd($)
  return w
}

test('an sdk origin never accepts', async ($, on) => {
  const w = await armed($, on)
  await $.prompt.submit({ text: 'accept', origin: { kind: 'sdk' } } as never)
  expect(w.writes.length).toBe(0)
})

test('a prompt without an origin never accepts', async ($, on) => {
  const w = await armed($, on)
  await $.prompt.submit({ text: 'accept' } as never)
  expect(w.writes.length).toBe(0)
})

test('a typed command with a reply word never accepts', async ($, on) => {
  const w = await armed($, on)
  await $.prompt.submit({ text: 'accept', command: { name: 'accept', args: '' }, origin: COMPOSER } as never)
  expect(w.writes.length).toBe(0)
})

test('a typed command ends the offer', async ($, on) => {
  const w2 = await armed($, on)
  await $.prompt.submit({ text: '/something', command: { name: 'something', args: '' }, origin: COMPOSER } as never)
  await reply($, 'accept', COMPOSER)
  expect(w2.writes.length).toBe(0)
})

test('a proposal queued after the first notice gets its own notice, and a reply accepts it', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('First note here.'))
  await turnEnd($)
  const b = idOf(await propose($, note('Second note here.')))
  await reply($, 'hello', COMPOSER)
  await turnEnd($)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(w.logs.filter((l) => l.includes(`proposal ${b}`)).length).toBe(1)
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.map((n: { text: string }) => n.text)).toEqual(['Second note here.'])
})

test('the notice has a single period before the reply hint', async ($, on) => {
  const w = await armed($, on)
  expect(w.logs.at(-1)).toMatch(/Reply in German\. Reply "accept"/)
})

test('a paused session ignores replies', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('Reply in German.'))
  await turnEnd($)
  await run($, 'pause')
  await reply($, 'accept', COMPOSER)
  expect(w.writes.length).toBe(0)
})

test('a failed write is shown and told to the model as not done; the proposal stays queued', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', failWrite: /souffleur\.json\.tmp-/ })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  await turnEnd($)
  await reply($, 'accept', COMPOSER)
  expect(hasLine(w, `proposal ${id}`)).toBe(true)
  expect(hasLine(w, 'the user accepted')).toBe(false)
  expect(hasLine(w, 'could not be written')).toBe(true)
  expect(w.toasts.join('\n')).toMatch(/stays queued/)
  expect(await run($, 'review')).toMatch(/Reply in German/)
})

test('a handled reply shows the result and the next waiting proposal gets its notice', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const a = idOf(await propose($, note('First note here.')))
  const b = idOf(await propose($, note('Second note here.')))
  await turnEnd($)
  await reply($, 'accept', COMPOSER)
  expect(w.toasts.join('\n')).toMatch(/added note/)
  await turnEnd($)
  expect(w.logs.filter((l) => l.includes(`proposal ${b}`)).length).toBe(1)
  await reply($, 'decline', COMPOSER)
  expect(hasLine(w, `declined proposal ${b}`)).toBe(true)
  expect(a).not.toBe(b)
})

test('a turn end without a person prompt does not replace the shown proposal', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('First note here.'))
  await turnEnd($)
  await propose($, note('Second note here.'))
  await reply($, 'hello', { kind: 'peer' })
  await turnEnd($)
  expect(w.logs.filter((l) => l.includes('Second note here')).length).toBe(0)
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.map((n: { text: string }) => n.text)).toEqual(['First note here.'])
})

test('a reply whose entry the reader drops tells the model it is not active', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', onWrite: (path) => { if (path === USER_FILE) w.files[USER_FILE] = '{"mode":"enforce"}' } })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  await turnEnd($)
  await reply($, 'accept', COMPOSER)
  expect(hasLine(w, `proposal ${id}, but the reader did not keep the entry; it is not active`)).toBe(true)
  expect(hasLine(w, 'nothing else to do')).toBe(false)
})

test('a prompt that starts a need writes the reason to the debug log only', async ($, on) => {
  const w = world(on, { [USER_FILE]: UI }, { classify: 'match' })
  await start($)
  w.logs.length = 0
  await $.prompt.submit({ text: 'build me a login screen' })
  expect(w.debugLogs.filter((l) => /need started: need:ui/.test(l))).toHaveLength(1)
  expect(w.logs.filter((l) => /need:ui/.test(l))).toEqual([])
})

// ---- hardening of the reply path (final review) ----
test('a dialog nobody answers gives up after two minutes and shows the notice', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { holdAsk: true })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  const t = turnEnd($)
  await settle() // let the turn end reach its dialog
  await w.clock.advance(120_000)
  await t
  expect(w.logs.filter((l) => l.includes(`proposal ${id}`)).length).toBe(1)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.length).toBe(1)
})

test('a throwing ui.log on a need-start prompt still delivers the restore context', async ($, on) => {
  const w = world(on, { [USER_FILE]: UI }, { classify: 'match', failLog: true, skills: ['ui-checklist'] })
  await start($)
  const r = await $.prompt.submit({ text: 'build me a login screen' })
  expect(r.context?.join('\n')).toMatch(/ui-checklist/)
  expect(w.statuses.at(-1)).not.toMatch(/degraded/)
})

test('a reload while an offer is armed disarms it: accept does not act and the notice comes again', async ($, on) => {
  const w = await armed($, on)
  await start($)
  await reply($, 'accept', COMPOSER)
  expect(w.writes.length).toBe(0)
  // A rejected dialog is not kept (#59): the reload asks again, the notice comes again, and the reply accepts it.
  await turnEnd($)
  expect(w.logs.filter((l) => l.includes('Reply "accept"')).length).toBe(2)
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.length).toBe(1)
})

test('a prompt handled as a reply is not classified', async ($, on) => {
  const file = JSON.stringify({ mode: 'enforce', skills: {}, needs: { ui: 'Designing something a user sees.' } })
  const w = world(on, { [USER_FILE]: file }, { answers: 'reject', classify: 'no-match' })
  await start($)
  await propose($, note('Reply in German.'))
  await turnEnd($)
  const before = w.classifyCalls()
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.length).toBe(1)
  expect(w.classifyCalls()).toBe(before)
})

test('the notice names the command where the session takes no reply (sdk prompt, not interactive)', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: false })
  const id = idOf(await propose($, note('Reply in German.')))
  await $.prompt.submit({ text: 'hello', origin: { kind: 'sdk' } } as never)
  await turnEnd($)
  const line = w.logs.filter((l) => l.includes(`proposal ${id}`)).at(-1)!
  expect(line).toContain(`/souffleur accept ${id}`)
  expect(line).not.toContain('Reply "accept"')
})

test('the notice keeps the reply words over Remote Control (bridge prompt, not interactive)', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: false })
  const id = idOf(await propose($, note('Reply in German.')))
  await $.prompt.submit({ text: 'hello', origin: { kind: 'bridge' } } as never)
  await turnEnd($)
  expect(w.logs.filter((l) => l.includes(`proposal ${id}`)).at(-1)).toContain('Reply "accept"')
})

test('a failure after the answer was written still tells the model', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', onWrite: (path) => { if (path === USER_FILE) on('session.id', () => { throw new Error('gone') }) } })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  await turnEnd($)
  await reply($, 'accept', COMPOSER)
  expect(userWrites(w).length).toBe(1)
  expect(hasLine(w, `proposal ${id}`)).toBe(true)
})

const lateWorld = (on: any) => {
  let tap!: (label: string) => void
  const held = new Promise<string>((r) => { tap = r })
  const w = world(on, { [USER_FILE]: ENFORCE }, { holdAsk: held })
  return { w, tap }
}
const timedOut = async ($: any, w: World) => {
  const t = turnEnd($)
  await settle()
  await w.clock.advance(120_000)
  await t
}
const idle = settle

test('a dialog tapped after the timeout still writes once and disarms the reply', async ($, on) => {
  const { w, tap } = lateWorld(on)
  await start($)
  await propose($, note('Reply in German.'))
  await timedOut($, w)
  tap('Yes, everywhere')
  await idle()
  expect(userFile(w).notes.length).toBe(1)
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.length).toBe(1)
  expect(hasLine(w, 'the user accepted')).toBe(false)
})

test('a reply first, then a late tap: one write', async ($, on) => {
  const { w, tap } = lateWorld(on)
  await start($)
  await propose($, note('Reply in German.'))
  await timedOut($, w)
  await reply($, 'accept', COMPOSER)
  tap('Yes, everywhere')
  await idle()
  expect(userFile(w).notes.length).toBe(1)
  expect(userWrites(w).length).toBe(1)
})

test('after a timeout the next proposal still gets a dialog attempt', async ($, on) => {
  const { w } = lateWorld(on)
  await start($)
  await propose($, note('First note here.'))
  await timedOut($, w)
  await propose($, note('Second note here.'))
  await reply($, 'hello', COMPOSER) // a prompt of the person ends the armed offer
  const t = turnEnd($)
  await idle()
  expect(w.asked.length).toBe(2)
  expect(w.asked[1]).toMatch(/Second note here/)
  await w.clock.advance(120_000)
  await t
})

test('a failure inside the commit after the write still tells the model', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  await turnEnd($)
  w.stored['declined'] = 'junk'
  await reply($, 'accept', COMPOSER)
  expect(hasLine(w, `proposal ${id}`)).toBe(true)
})

test('while a reply offer is armed no new dialog and no new notice open', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { holdAsk: true })
  await start($)
  await propose($, note('First note here.'))
  await propose($, note('Second note here.'))
  await timedOut($, w)
  expect(w.asked.length).toBe(1)
  await reply($, 'hello', { kind: 'peer' })
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(w.logs.filter((l) => l.includes('Second note here')).length).toBe(0)
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.map((n: { text: string }) => n.text)).toEqual(['First note here.'])
})

test('the Agent brief check leaves out a skill excluded in this project', async ($, on) => {
  const cfg = JSON.stringify({ mode: 'enforce', skills: { 'ui-design': { need: 'ui', notIn: ['/work/proj'] }, 'writing-guide': { need: 'ui' } }, needs: { ui: 'Designing something a user sees.' } })
  world(on, { [USER_FILE]: cfg })
  await start($)
  await $.command.run({ command: 'souffleur', args: 'need ui', origin: COMPOSER })
  const r = await $.tool.call({ tool: 'Agent', prompt: 'do it', description: 'd', subagent_type: 'general-purpose' } as never)
  expect(JSON.stringify(r)).toMatch(/Configured skills: writing-guide\./)
})

test('an always-on chat skill excluded in this project is not named in the system section', async ($, on) => {
  const chat = JSON.stringify({ mode: 'enforce', skills: { 'terse:terse-mode': { always: true, for: 'chat', notIn: ['/work/proj'] } } })
  world(on, { [USER_FILE]: chat })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const r = await $.prompt.compose(COMPOSE)
  const text = r.sections.find((s: { id: string }) => s.id === 'souffleur')?.text as string
  expect(text).not.toMatch(/terse:terse-mode|Replies in this chat/)
})

test('the status line does not count a skill excluded in this project', async ($, on) => {
  const cfg = JSON.stringify({ mode: 'enforce', skills: { 'ui-design': { always: true, notIn: ['/work/proj'] }, 'writing-guide': { always: true } } })
  const w = world(on, { [USER_FILE]: cfg })
  await start($)
  await skillLoaded($, 'ui-design')
  await skillLoaded($, 'writing-guide')
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · 1 loaded/)
})

test('a failed call A writes its kind to the debug log', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ skills: { g: { need: 'n' } }, needs: { n: 'Something.' } }) }, { classify: () => 'banana' })
  await start($)
  await $.prompt.submit({ text: 'one two three four' })
  expect(w.debugLogs.join('\n')).toMatch(/classifier: unknown-label/)
})

test('a failed call B writes classifier B to the debug log', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ skills: { g: { need: 'n' } }, needs: { n: { for: 'work', what: 'Something.' } } }) }, { classify: (labels) => (labels?.includes('chat-reply') ? 'code-or-repo-work' : 'banana') })
  await start($)
  await $.prompt.submit({ text: 'one two three four' })
  expect(w.debugLogs.join('\n')).toMatch(/classifier B: unknown-label/)
  expect(w.debugLogs.join('\n')).not.toMatch(/classifier: /)
})

test('three failed call B runs in a row show degraded in the status', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ skills: { g: { need: 'n' } }, needs: { n: { for: 'work', what: 'Something.' } } }) }, { classify: (labels) => (labels?.includes('chat-reply') ? 'code-or-repo-work' : 'banana') })
  await start($)
  for (let i = 0; i < 3; i++) await $.prompt.submit({ text: 'one two three four' })
  expect(w.statuses.at(-1)).toMatch(/degraded/)
})

test('three failing call B runs then a good one (A says code work): status clears, /souffleur keeps the count', async ($, on) => {
  let bGood = false
  const w = world(on, { [USER_FILE]: JSON.stringify({ skills: { g: { need: 'n' } }, needs: { n: { for: 'work', what: 'Something.' } } }) }, { classify: (labels) => (labels?.includes('chat-reply') ? 'code-or-repo-work' : bGood ? 'n' : 'banana') })
  await start($)
  for (let i = 0; i < 3; i++) await $.prompt.submit({ text: 'one two three four' })
  expect(w.statuses.at(-1)).toMatch(/degraded/)
  bGood = true
  await $.prompt.submit({ text: 'one two three four' })
  expect(w.statuses.at(-1)).not.toMatch(/degraded/)
  expect(await table($)).toMatch(/^Failures this session: classifier B 1$/m)
})

// --- Reply check ---

const REPLY_CFG = JSON.stringify({ mode: 'enforce', skills: { 'terse:terse-mode': { always: true, for: 'chat', reply: { maxChars: 200, headings: 0 } } } })
const LONG_REPLY = `# Head\n${'word '.repeat(80)}`

test('a long chat reply is counted and the next prompt carries the reminder line', async ($, on) => {
  const w = world(on, { [USER_FILE]: REPLY_CFG })
  await start($)
  await skillLoaded($, 'terse:terse-mode')
  await $.prompt.submit({ text: 'first question' })
  await turnEnd($, { answer: LONG_REPLY })
  const r = await $.prompt.submit({ text: 'second question' })
  expect(r.context?.join('\n')).toMatch(/Souffleur: your last reply had \d+ characters and 1 heading \(limit 200 characters, 0 headings\)\. Replies in this chat follow terse:terse-mode\./)
  expect(await table($)).toMatch(/- terse:terse-mode: 1 of 1 replies over the limit/)
  expect(w.toasts).toEqual([])
  expect((await $.prompt.submit({ text: 'third question' })).context?.join('\n') ?? '').not.toMatch(/last reply/)
})

test('replies of subagents, other turn reasons, aborted turns and paused sessions are not checked', async ($, on) => {
  world(on, { [USER_FILE]: REPLY_CFG })
  await start($)
  await skillLoaded($, 'terse:terse-mode')
  await turnEnd($, { answer: LONG_REPLY, agentId: 'a1' })
  await turnEnd($, { answer: LONG_REPLY, reason: 'error' })
  await turnEnd($, { answer: LONG_REPLY, isAborted: true })
  expect(await table($)).not.toMatch(/replies over the limit/)
  await run($, 'pause')
  await turnEnd($, { answer: LONG_REPLY })
  await run($, 'resume')
  expect(await table($)).not.toMatch(/replies over the limit/)
  expect((await $.prompt.submit({ text: 'q' })).context?.join('\n') ?? '').not.toMatch(/last reply/)
})

test('the reply to a typed command is not checked', async ($, on) => {
  world(on, { [USER_FILE]: REPLY_CFG })
  await start($)
  await skillLoaded($, 'terse:terse-mode')
  await $.prompt.submit({ text: '/review the diff', command: { name: 'review', args: 'the diff' } } as never)
  await turnEnd($, { answer: LONG_REPLY })
  expect(await table($)).not.toMatch(/replies over the limit/)
  await $.prompt.submit({ text: 'plain question' })
  await turnEnd($, { answer: LONG_REPLY })
  expect(await table($)).toMatch(/1 of 1 replies over the limit/)
})

test('a config without reply counts nothing', async ($, on) => {
  world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', skills: { 'terse:terse-mode': { always: true, for: 'chat' } } }) })
  await start($)
  await skillLoaded($, 'terse:terse-mode')
  await turnEnd($, { answer: LONG_REPLY })
  expect(await table($)).not.toMatch(/replies over the limit/)
  expect((await $.prompt.submit({ text: 'q' })).context?.join('\n') ?? '').not.toMatch(/last reply/)
})

test('the counts survive a resume of the session', async ($, on) => {
  const w = world(on, { [USER_FILE]: REPLY_CFG })
  await start($)
  await skillLoaded($, 'terse:terse-mode')
  await $.prompt.submit({ text: 'question' })
  await turnEnd($, { answer: LONG_REPLY })
  await $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true, source: 'resume' } as never)
  expect(w.stored).toBeTruthy()
  expect(await table($)).toMatch(/1 of 1 replies over the limit/)
})

test('a turn that is not the answer to a person prompt is not counted and keeps a waiting reminder', async ($, on) => {
  world(on, { [USER_FILE]: REPLY_CFG })
  await start($)
  await skillLoaded($, 'terse:terse-mode')
  await $.prompt.submit({ text: 'question' })
  await turnEnd($, { answer: LONG_REPLY })
  // a background notification turn: a prompt that is not from the person, then a short answer
  await $.prompt.submit({ text: '<task-notification>done</task-notification>', isMeta: true } as never)
  await turnEnd($, { answer: 'ok' })
  expect(await table($)).toMatch(/1 of 1 replies over the limit/)
  expect((await $.prompt.submit({ text: 'next' })).context?.join('\n')).toMatch(/last reply had/)
  await $.prompt.submit({ text: '<task-notification>again</task-notification>', isMeta: true } as never)
  await turnEnd($, { answer: LONG_REPLY })
  expect(await table($)).toMatch(/1 of 1 replies over the limit/)
})

// ---- proposal scope and stop (#59) ----
const PROPOSE_SENTENCE =
  ' Call the souffleur_propose tool only (a) when the user gives a standing instruction meant to hold beyond the current task, as a note, or (b) when something went wrong that a checkable rule would have caught (a skill loaded before a call, a field a call carries, evidence after a call), as a rule. Never for facts about one task, issue or file. Souffleur then asks the user; do not write the entry anywhere yourself.'
const STOPPED = 'Souffleur: the user declined or skipped a proposal in this session; do not propose more. Nothing queued.'
const SLIP_NOTE = 'Souffleur: a note comes only from a standing instruction of the user; nothing queued.'

test('the system prompt carries the exact propose sentence and the tool description the same scope', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const section = (await $.prompt.compose(COMPOSE)).sections.find((s: { id: string }) => s.id === 'souffleur')
  expect(section?.text).toContain(PROPOSE_SENTENCE)
  expect(JSON.stringify(w.tools)).toMatch(/standing instruction/)
  expect(JSON.stringify(w.tools)).toMatch(/never for facts about one task/i)
})

test('a note from a slip is refused, a checkable rule from a slip is queued', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  expect(String((await propose($, { kind: 'note', text: 'Issue 5 needs a retry.', source: 'slip' })).result)).toBe(SLIP_NOTE)
  expect(await run($, 'review')).toMatch(/no proposals/)
  expect(String((await propose($, { ...AGENT_RULE, source: 'slip' })).result)).toMatch(/Queued as rule-/)
  expect(String((await propose($, { kind: 'note', text: 'Answer in German.', source: 'user' })).result)).toMatch(/Queued as note-/)
})

test('skipping the dialog stops further model proposals, which are not queued', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['__undefined__'] })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(String((await propose($, note('Answer in German.'))).result)).toBe(STOPPED)
  expect(await table($)).toMatch(/Open proposals \(1\)/)
})

test('declining by dialog stops proposals', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: ['No'] })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(String((await propose($, note('Answer in German.'))).result)).toBe(STOPPED)
})

test('declining by reply word stops proposals', async ($, on) => {
  // Armed through the timeout path: nothing but the decline can set the stop here.
  const w = world(on, { [USER_FILE]: ENFORCE }, { holdAsk: true })
  await start($)
  await propose($, note('Reply in German.'))
  const t = turnEnd($)
  await settle()
  await w.clock.advance(120_000)
  await t
  expect(String((await propose($, note('Answer in French, always.'))).result)).toMatch(/Queued as note-/)
  await reply($, 'decline', COMPOSER)
  expect(String((await propose($, note('Answer in German, always.'))).result)).toBe(STOPPED)
})

test('declining by command stops proposals', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  await run($, `decline ${id}`)
  expect(String((await propose($, note('Answer in French, always.'))).result)).toBe(STOPPED)
})

test('a reload keeps the stop and the dismissed dialog', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['__undefined__', 'No'] })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  await start($)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(String((await propose($, note('Answer in German.'))).result)).toBe(STOPPED)
})

test('a new session starts without the stop', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['__undefined__'] })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  w.setId('s2')
  await start($)
  expect(String((await propose($, note('Answer in German.'))).result)).toMatch(/Queued as note-/)
})

test('a rule the person types still queues after a stop', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: ['__undefined__'], shaped: '{"kind":"note","text":"Always answer in German."}' })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(String((await propose($, note('Answer in German.'))).result)).toBe(STOPPED)
  expect(await run($, 'rule Always answer in German.')).toMatch(/^Souffleur: queued note note-/)
  expect(await table($)).toMatch(/Open proposals \(2\)/)
})

test('already queued proposals stay visible in review after a stop', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: ['__undefined__'] })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(await run($, 'review')).toMatch(/no dialog/)
})

test('a reply offer that a person prompt ends without an answer does not stop proposals', async ($, on) => {
  await armed($, on)
  await reply($, 'what is the weather', COMPOSER)
  expect(String((await propose($, note('Answer in German, always.'))).result)).toMatch(/Queued as note-/)
})

test('a typed command ends the offer without stopping proposals', async ($, on) => {
  await armed($, on)
  await $.prompt.submit({ text: '/something', command: { name: 'something', args: '' }, origin: COMPOSER } as never)
  expect(String((await propose($, note('Answer in German, always.'))).result)).toMatch(/Queued as note-/)
})

test('a no-dialog client where the person accepts by reply keeps proposals open', async ($, on) => {
  const w = await armed($, on)
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.length).toBe(1)
  expect(String((await propose($, note('Answer in French, always.'))).result)).toMatch(/Queued as note-/)
})

test('a /souffleur rule whose dialog cannot open inside the command does not stop proposals', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject', shaped: '{"kind":"note","text":"Always answer in German."}' })
  await start($)
  await run($, 'rule Always answer in German.')
  expect(String((await propose($, note('Answer in French, always.'))).result)).toMatch(/Queued as note-/)
})

test('a timed-out dialog that the person accepts by command does not stop proposals', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { holdAsk: true })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  const t = turnEnd($)
  await settle()
  await w.clock.advance(120_000)
  await t
  await $.prompt.submit({ text: `/souffleur accept ${id}`, command: { name: 'souffleur', args: `accept ${id}` }, origin: COMPOSER } as never)
  expect(String((await propose($, note('Answer in French, always.'))).result)).toMatch(/Queued as note-/)
})

test('a timed-out dialog and a person who just continues work do not stop proposals', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { holdAsk: true })
  await start($)
  await propose($, note('Reply in German.'))
  const t = turnEnd($)
  await settle()
  await w.clock.advance(120_000)
  await t
  await reply($, 'ok, now fix the second test', COMPOSER)
  expect(String((await propose($, note('Answer in French, always.'))).result)).toMatch(/Queued as note-/)
})

test('a rejected dialog is not kept: a reload in a client that can ask asks again', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  await propose($, note('Reply in German.'))
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  w.answers.push('No')
  await start($)
  await turnEnd($)
  expect(w.asked.length).toBe(2)
})

test('/clear forgets a dismissed dialog like it forgets the stop', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: ['__undefined__', 'No'] })
  await start($)
  await propose($, note('Reply in German.'))
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  w.setId('cleared')
  expect(String((await propose($, note('Answer in French, always.'))).result)).toMatch(/Queued as note-/)
  await turnEnd($)
  expect(w.asked.length).toBe(2)
})

test('an accepted reply does not stop proposals', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { holdAsk: true })
  await start($)
  await propose($, note('Reply in German.'))
  const t = turnEnd($)
  await settle()
  await w.clock.advance(120_000)
  await t
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.length).toBe(1)
  expect(String((await propose($, note('Answer in French, always.'))).result)).toMatch(/Queued as note-/)
})

test('a late Yes on a timed-out dialog does not stop later proposals', async ($, on) => {
  const { w, tap } = lateWorld(on)
  await start($)
  await propose($, note('Reply in German.'))
  await timedOut($, w)
  tap('Yes, everywhere')
  await idle()
  expect(userFile(w).notes.length).toBe(1)
  expect(String((await propose($, note('Keep commits small.'))).result)).not.toBe(STOPPED)
})

const NO_ANSWER = /no answer within two minutes; the proposal stays queued\. A late tap in the dialog still counts\./

test('a typed review whose dialog never answers returns after the limit and still lists the proposal', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { holdAsk: true })
  await start($)
  await propose($, note('Reply in German.'))
  const t = run($, 'review')
  await idle()
  await w.clock.advance(120_000)
  const text = await t
  expect(text).toMatch(NO_ANSWER)
  expect(text).toMatch(/Reply in German/)
  expect(w.asked.length).toBe(1)
  expect(w.writes.length).toBe(0)
  expect(w.logs.some((l) => /proposal note-/.test(l))).toBe(false)
  expect(String((await propose($, note('Keep commits small.'))).result)).not.toBe(STOPPED)
})

test('a tap after a typed review timed out writes once, and a later reply word does not write again', async ($, on) => {
  const { w, tap } = lateWorld(on)
  await start($)
  await propose($, note('Reply in German.'))
  const t = run($, 'review')
  await idle()
  await w.clock.advance(120_000)
  expect(await t).toMatch(NO_ANSWER)
  tap('Yes, everywhere')
  await idle()
  expect(userFile(w).notes.length).toBe(1)
  await reply($, 'accept', COMPOSER)
  expect(userFile(w).notes.length).toBe(1)
  expect(userWrites(w).length).toBe(1)
})

test('a typed rule whose dialog never answers returns after the limit and sets no stop', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { holdAsk: true, shaped: '{"kind":"note","text":"Always say hi"}' })
  await start($)
  const t = run($, 'rule Always say hi')
  await idle()
  await w.clock.advance(120_000)
  const text = await t
  expect(text).toMatch(NO_ANSWER)
  expect(text).toMatch(/Or run \/souffleur accept note-[0-9a-f]+\.$/)
  expect(await table($)).toMatch(/Open proposals \(1\)/)
  expect(String((await propose($, note('Keep commits small.'))).result)).not.toBe(STOPPED)
})

test('a typed rule whose dialog is dismissed still stops proposals', async ($, on) => {
  const d = world(on, { [USER_FILE]: ENFORCE }, { answers: ['__undefined__'], shaped: '{"kind":"note","text":"Always say hi"}' })
  await start($)
  await run($, 'rule Always say hi')
  expect(d.asked.length).toBe(1)
  expect(String((await propose($, note('Keep commits small.'))).result)).toBe(STOPPED)
})

test('a skill blocked in this root is left out of the system section and shown as blocked here', async ($, on) => {
  const cfg = JSON.stringify({
    mode: 'enforce',
    skills: { 'terse:terse-mode': { always: true, for: 'chat' }, 'writing-guide': { always: true } },
    projects: { '/work/proj': { block: ['terse:terse-mode'] }, '/work/other': { block: ['writing-guide'] } },
  })
  world(on, { [USER_FILE]: cfg })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const r = await $.prompt.compose(COMPOSE)
  const text = r.sections.find((s: { id: string }) => s.id === 'souffleur')?.text as string
  expect(text).not.toMatch(/terse:terse-mode|Replies in this chat/)
  expect(text).toMatch(/writing-guide/)
  const t = await table($)
  expect(t).toMatch(/^Project: \/work\/proj \(block: 1 blocked, 0 own\)$/m)
  expect(t).toMatch(/\| terse:terse-mode \| blocked here \|/)
})

test('init works on the standard: names in this root block or own are neither asked nor rewritten', async ($, on) => {
  const user = JSON.stringify({
    skills: { x: { always: true }, 'writing-guide': { always: true } },
    projects: { '/work/proj': { block: ['x'], skills: { o: { always: true } } } },
  })
  const w = world(on, { [USER_FILE]: user }, { skills: ['x', 'o', 'writing-guide'], answers: ['When the task needs it', 'When the task needs it', 'When the task needs it'] })
  await start($)
  await run($, 'init')
  expect(w.asked.length).toBe(1)
  expect(w.asked[0]).toMatch(/writing-guide/)
  const written = JSON.parse(w.writes.filter((x) => x.path === USER_FILE).at(-1)!.text)
  expect(written.skills.x).toEqual({ always: true })
  expect(written.skills.o).toBeUndefined()
  expect(written.projects['/work/proj'].skills.o).toEqual({ always: true })
  expect(written.projects['/work/proj'].block).toEqual(['x'])
})

// --- /souffleur block, unblock, project ---

const BLOCKABLE = JSON.stringify({
  mode: 'enforce',
  skills: { 'terse:terse-mode': { always: true, for: 'chat' }, 'writing-guide': { always: true } },
  rules: [{ id: 'r-wg', before: { tools: ['Write'] }, skill: 'writing-guide', source: 'user' }],
  notes: [{ id: 'n-one', text: 'Keep it short.' }],
})
const userWrites = (w: World) => w.writes.filter((x) => x.path === USER_FILE)
const sectionText = async ($: any) => {
  const r = await $.prompt.compose(COMPOSE)
  return r.sections.find((s: { id: string }) => s.id === 'souffleur')?.text as string
}

test('block writes the block, backs the file up once and applies at once', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  expect(await sectionText($)).toMatch(/terse:terse-mode/)
  expect(await run($, 'block terse:terse-mode')).toBe('Souffleur: terse:terse-mode blocked in /work/proj; other projects keep it.')
  const backups = w.writes.filter((x) => /souffleur\.json\.bak-\d{13}$/.test(x.path))
  expect(backups.length).toBe(1)
  expect(backups[0]!.text).toBe(BLOCKABLE)
  const written = JSON.parse(userWrites(w).at(-1)!.text)
  expect(written.projects['/work/proj'].block).toEqual(['terse:terse-mode'])
  expect(written.skills['terse:terse-mode']).toEqual({ always: true, for: 'chat' })
  expect(await sectionText($)).not.toMatch(/terse:terse-mode/)
  expect(await table($)).toMatch(/\| terse:terse-mode \| blocked here \|/)
  await run($, 'block writing-guide')
  expect(w.writes.filter((x) => /\.bak-/.test(x.path)).length).toBe(1)
})

test('unblock restores the standard entry and its always-on line without a restart', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ ...JSON.parse(BLOCKABLE), projects: { '/work/proj': { block: ['terse:terse-mode'], skills: { own: { always: true } } } } }) })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  expect(await sectionText($)).not.toMatch(/terse:terse-mode/)
  expect(await run($, 'unblock terse:terse-mode')).toBe('Souffleur: terse:terse-mode unblocked in /work/proj; the standard applies here again.')
  expect(await sectionText($)).toMatch(/terse:terse-mode/)
  const written = JSON.parse(userWrites(w).at(-1)!.text)
  expect(written.projects['/work/proj']).toEqual({ skills: { own: { always: true } } })
  expect(await table($)).not.toMatch(/blocked here/)
})

test('unblock of the last name removes the whole empty block', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ ...JSON.parse(BLOCKABLE), projects: { '/work/proj': { block: ['writing-guide'] }, '/work/other': { block: ['n-one'] } } }) })
  await start($)
  await run($, 'unblock writing-guide')
  expect(JSON.parse(userWrites(w).at(-1)!.text).projects).toEqual({ '/work/other': { block: ['n-one'] } })
})

test('block and unblock answer for unknown names, and write nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE })
  await start($)
  expect(await run($, 'unblock nothing-here')).toBe("Souffleur: nothing-here is not in your standard or this project's block.")
  expect(await run($, 'block nothing-here')).toBe("Souffleur: nothing-here is not in your standard or this project's block.")
  expect(await run($, 'block bad name!')).toMatch(/not a valid name/)
  expect(await run($, 'block')).toMatch(/usage/i)
  expect(w.writes.length).toBe(0)
})

test('/souffleur pause without an origin is refused', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE })
  await start($)
  const r = await $.command.run({ command: 'souffleur', args: 'pause' } as never)
  expect(String(r.text)).toMatch(/only the user can run \/souffleur pause/)
  expect(w.writes.length).toBe(0)
})

test('block and unblock only act when the user typed them', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE })
  await start($)
  for (const args of ['block writing-guide', 'unblock writing-guide', 'project']) {
    const r = await $.command.run({ command: 'souffleur', args, origin: { kind: 'plugin', name: 'other' } } as never)
    expect(String(r.text)).toMatch(/only the user can run/i)
  }
  expect(w.writes.length).toBe(0)
})

test('block stops when the file cannot be edited', async ($, on) => {
  const w = world(on, { [USER_FILE]: '{ nope' })
  await start($)
  expect(await run($, 'block writing-guide')).toMatch(/nothing was written/)
  expect(w.writes.length).toBe(0)
})

test('project shows the short form', async ($, on) => {
  const user = JSON.stringify({
    ...JSON.parse(BLOCKABLE),
    skills: { ...JSON.parse(BLOCKABLE).skills, 'off-skill': { always: true, notIn: ['/work/proj'] } },
    notes: [...JSON.parse(BLOCKABLE).notes, { id: 'n-far', text: 'Elsewhere.', where: '/elsewhere' }],
    projects: { '/work/proj': { block: ['writing-guide', 'later-skill'], skills: { own: { always: true } }, notes: [{ id: 'n-own', text: 'Only here.' }] } },
  })
  world(on, { [USER_FILE]: user, [PROJECT_FILE]: JSON.stringify({ skills: { 'repo-a': { always: true } } }) })
  await start($)
  expect(await run($, 'project')).toBe(
    [
      'Souffleur: project /work/proj',
      'Blocked here: writing-guide, later-skill (not in standard), rule r-wg (its skill writing-guide is blocked)',
      'This project only: skill own, note n-own',
      'Off here by notIn/where: off-skill, n-far',
      'Standard: 1 skills, 1 notes, 0 rules apply here',
      'Repository file: repo-a',
    ].join('\n'),
  )
})

test('project without a block says only what applies', async ($, on) => {
  world(on, { [USER_FILE]: BLOCKABLE })
  await start($)
  expect(await run($, 'project')).toBe(['Souffleur: project /work/proj', 'Standard: 2 skills, 1 notes, 1 rules apply here'].join('\n'))
})

test('block accepts a skill only the repository file defines', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE, [PROJECT_FILE]: JSON.stringify({ skills: { 'repo-a': { always: true } } }) })
  await start($)
  expect(await run($, 'block repo-a')).toMatch(/repo-a blocked in/)
  expect(JSON.parse(userWrites(w).at(-1)!.text).projects['/work/proj'].block).toEqual(['repo-a'])
})

test('a new session start saves a new backup, in any test order', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE })
  await start($)
  await run($, 'block writing-guide')
  await start($)
  await run($, 'unblock writing-guide')
  expect(w.writes.filter((x) => /\.bak-\d+$/.test(x.path)).length).toBe(2)
})

test('init skips block names found under a root key with a trailing slash', async ($, on) => {
  const user = JSON.stringify({ skills: { 'writing-guide': { always: true } }, projects: { '/work/proj/': { block: ['blocked-one'], skills: { 'own-ok': { always: true } } } } })
  const w = world(on, { [USER_FILE]: user }, { skills: ['writing-guide', 'blocked-one', 'own-ok'], answers: ['From the start'] })
  await start($)
  const text = await run($, 'init')
  expect(w.asked.length).toBe(1)
  expect(text).not.toMatch(/blocked-one|own-ok/)
})

test('init leaves names of this root block out of its not-watched summary and skips raw block keys', async ($, on) => {
  const user = JSON.stringify({
    skills: { 'writing-guide': { always: true } },
    projects: { '/work/proj': { block: ['blocked-one'], skills: { 'bad skill name': { always: true }, 'own-ok': { always: true } } } },
  })
  const w = world(on, { [USER_FILE]: user }, { skills: ['writing-guide', 'blocked-one', 'own-ok', 'bad skill name', 'other-skill'], answers: ['From the start'] })
  await start($)
  const text = await run($, 'init')
  expect(w.asked.length).toBe(1)
  expect(text).toMatch(/other-skill/)
  expect(text).not.toMatch(/blocked-one|own-ok/)
})

// --- ask once about a project's own skills ---

const MAIN = '/work/main'
const STD = JSON.stringify({ mode: 'enforce', skills: { 'writing-guide': { always: true } } })
const rootBlock = (w: World) => JSON.parse(userWrites(w).at(-1)!.text).projects?.[MAIN]
const NOTICE2 = 'Souffleur: this project has 2 skills not in your config. /souffleur init asks about them.'

test('one dialog names the skills; Set up now runs the init round and writes only into the block', async ($, on) => {
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, skills: ['writing-guide'], projectSkills: ['proj-skill', 'second-skill'], answers: ['Set up now', 'When the task needs it', 'This project only', "Don't watch"] })
  await start($)
  await turnEnd($)
  expect(w.asked[0]).toMatch(/This project has 2 skills not in your config: proj-skill, second-skill\. Set them up now\?/)
  expect(w.options[0]).toEqual(['Set up now', 'Ignore all here', 'Later'])
  expect(w.asked.some((q) => /where/i.test(q) && /proj-skill/.test(q))).toBe(true)
  expect(w.asked.some((q) => /writing-guide/.test(q))).toBe(false)
  const written = JSON.parse(userWrites(w).at(-1)!.text)
  expect(written.skills).toEqual({ 'writing-guide': { always: true } })
  expect(written.projects[MAIN].skills['proj-skill'].need).toBeTruthy()
  expect(written.projects[MAIN].ignored).toEqual(['second-skill'])
  await turnEnd($)
  expect(w.asked.filter((q) => /not in your config/.test(q)).length).toBe(1)
})

test('Ignore all here writes every name to ignored and nothing else', async ($, on) => {
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: ['a-skill', 'b-skill'], answers: ['Ignore all here'] })
  await start($)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(rootBlock(w)).toEqual({ ignored: ['a-skill', 'b-skill'] })
})

test('more than 20 names: the first 20 are ignored, the rest stay unasked, one error line', async ($, on) => {
  const names = Array.from({ length: 22 }, (_, i) => `s${String(i).padStart(2, '0')}`)
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: names, answers: ['Ignore all here'] })
  await start($)
  await turnEnd($)
  expect(rootBlock(w).ignored.length).toBe(20)
  expect(w.logs.filter((l) => /ignored list/.test(l)).length).toBe(1)
})

test('Later writes nothing, sets no stop, and asks again at the next session only', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', skills: { 'dev-workflow': { always: true } } }) }, { repoRoot: MAIN, projectSkills: ['proj-skill'], answers: ['Later', 'Yes, everywhere', 'Later'] })
  await start($)
  await turnEnd($)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(w.writes.length).toBe(0)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(w.asked.length).toBe(2)
  expect(w.asked[1]).toMatch(/Add rule/)
  await start($)
  await turnEnd($)
  expect(w.asked.length).toBe(3)
  expect(w.asked[2]).toMatch(/not in your config/)
})

test('a dismissed own-skill dialog writes nothing and proposals are still asked', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', skills: { 'dev-workflow': { always: true } } }) }, { repoRoot: MAIN, projectSkills: ['proj-skill'], answers: ['__undefined__', 'Yes, everywhere'] })
  await start($)
  await turnEnd($)
  expect(w.writes.length).toBe(0)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(w.asked.length).toBe(2)
  expect(userWrites(w).length).toBe(1)
})

const ownLate = (opts: Opts = {}) => {
  let tap!: (label: string) => void
  const held = new Promise<string>((r) => { tap = r })
  return { tap, held, opts: { repoRoot: MAIN, projectSkills: ['a-skill', 'b-skill'], holdFirstAsk: held, ...opts } as Opts }
}
const PAUSED_LINE = 'Souffleur: Souffleur is paused; /souffleur init sets them up later.'
const ownTimedOut = async ($: any, w: World) => {
  const t = turnEnd($)
  await settle()
  await w.clock.advance(120_000)
  await t
}

test('a late Set up now opens no dialog; the round runs at the next turn end', async ($, on) => {
  const { tap, opts } = ownLate({ answers: ['When the task needs it', 'This project only', "Don't watch"] })
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  tap('Set up now')
  await idle()
  expect(w.asked.length).toBe(1)
  expect(w.writes.length).toBe(0)
  expect(w.logs.filter((l) => l === 'Souffleur: set-up starts at the next turn end.').length).toBe(1)
  await turnEnd($)
  expect(w.asked.some((q) => /where/i.test(q) && /a-skill/.test(q))).toBe(true)
  expect(rootBlock(w).skills['a-skill'].need).toBeTruthy()
  const n = w.asked.length
  await turnEnd($)
  expect(w.asked.length).toBe(n)
})

test('a late Set up now when the key exists by the next turn end does nothing', async ($, on) => {
  const { tap, opts } = ownLate({ answers: ['When the task needs it', 'This project only', "Don't watch"] })
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  tap('Set up now')
  await idle()
  w.files[USER_FILE] = JSON.stringify({ mode: 'enforce', skills: { 'writing-guide': { always: true } }, projects: { [MAIN]: { ignored: ['a-skill'] } } })
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(w.writes.length).toBe(0)
})

test('a late Set up now while paused starts nothing', async ($, on) => {
  const { tap, opts } = ownLate({ answers: ['When the task needs it', 'This project only', "Don't watch"] })
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  await run($, 'pause')
  tap('Set up now')
  await idle()
  await turnEnd($)
  expect(w.logs.some((l) => /set-up starts/.test(l))).toBe(false)
  expect(w.logs.filter((l) => l === PAUSED_LINE).length).toBe(1)
  expect(w.asked.length).toBe(1)
})

test('a late Ignore all here while paused writes nothing', async ($, on) => {
  const { tap, opts } = ownLate()
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  await run($, 'pause')
  tap('Ignore all here')
  await idle()
  expect(w.writes.filter((x) => x.path === USER_FILE).length).toBe(0)
  expect(w.logs.filter((l) => l === PAUSED_LINE).length).toBe(1)
})

test('/souffleur init typed meanwhile clears the pending set-up', async ($, on) => {
  // init names one skill in the standard, then stops: no key is written and b-skill stays unnamed
  const { tap, opts } = ownLate({ answers: ['From the start', 'Everywhere', ''] })
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  tap('Set up now')
  await idle()
  await run($, 'init')
  expect(JSON.parse(w.files[USER_FILE]!).projects).toBeUndefined()
  expect(JSON.parse(w.files[USER_FILE]!).skills['b-skill']).toBeUndefined()
  const n = w.asked.length
  await turnEnd($)
  expect(w.asked.length).toBe(n)
})

test('a pending set-up is cleared at the next session start', async ($, on) => {
  const { tap, opts } = ownLate({ answers: ['__undefined__'] })
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  tap('Set up now')
  await idle()
  await start($)
  await propose($, note('Reply in German.')) // a waiting proposal keeps the project question from asking again
  await turnEnd($)
  expect(w.asked.some((q) => /a-skill/.test(q) && !/not in your config/.test(q))).toBe(false)
})

test('a late Set up now where no dialog can open says what to type', async ($, on) => {
  const { tap, opts } = ownLate({ answers: ['__undefined__'] })
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  await propose($, note('Reply in German.'))
  await turnEnd($) // the proposal dialog is dismissed: nothing more is asked at turn end
  tap('Set up now')
  await idle()
  expect(w.logs.filter((l) => l === 'Souffleur: run /souffleur init in this project to set them up.').length).toBe(1)
  expect(w.logs.some((l) => /set-up starts/.test(l))).toBe(false)
  const n = w.asked.length
  await turnEnd($)
  expect(w.asked.length).toBe(n)
})

test('a late answer that cannot be applied says so in one line', async ($, on) => {
  const { tap, opts } = ownLate()
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  w.files[USER_FILE] = '{ not json' // the file was damaged meanwhile
  tap('Ignore all here')
  await idle()
  expect(w.logs.filter((l) => /^Souffleur: could not act on your answer \(.+\)\. \/souffleur init asks again\.$/.test(l)).length).toBe(1)
})

test('a late answer counts names against the repository file too', async ($, on) => {
  const user = JSON.stringify({ mode: 'enforce', trustProjects: ['/work/proj/'], skills: { 'writing-guide': { always: true } } })
  const { tap, opts } = ownLate({ repoRoot: '/work/proj' })
  const w = world(on, { [USER_FILE]: user }, opts)
  await start($)
  await ownTimedOut($, w)
  w.files[PROJECT_FILE] = JSON.stringify({ skills: { 'a-skill': { always: true } } })
  tap('Ignore all here')
  await idle()
  expect(JSON.parse(userWrites(w).at(-1)!.text).projects['/work/proj']).toEqual({ ignored: ['b-skill'] })
})

test('each question acts once: an earlier in-time set-up does not block a later late answer', async ($, on) => {
  let t2!: (l: string) => void
  const p2 = new Promise<string>((r) => { t2 = r })
  const R = (l: string) => Promise.resolve(l)
  // question 1 in time: Set up now, a-skill goes to the standard, then Stop; no key, b-skill stays unnamed
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: ['a-skill', 'b-skill'], holdQueue: [R('Set up now'), R('From the start'), R('Everywhere'), R(''), p2] })
  await start($)
  await turnEnd($)
  expect(JSON.parse(w.files[USER_FILE]!).projects).toBeUndefined()
  await start($)
  await ownTimedOut($, w)
  expect(w.asked.filter((q) => /not in your config/.test(q)).length).toBe(2)
  t2('Ignore all here')
  await idle()
  expect(rootBlock(w)).toEqual({ ignored: ['b-skill'] })
})

test('a late answer to a question of an earlier session start is stale; the current one acts', async ($, on) => {
  let t1!: (l: string) => void
  let t2!: (l: string) => void
  const p1 = new Promise<string>((r) => { t1 = r })
  const p2 = new Promise<string>((r) => { t2 = r })
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: ['a-skill', 'b-skill'], holdQueue: [p1, p2] })
  await start($)
  await ownTimedOut($, w)
  await start($)
  await ownTimedOut($, w)
  expect(w.asked.filter((q) => /not in your config/.test(q)).length).toBe(2)
  t1('Ignore all here')
  await idle()
  expect(w.writes.length).toBe(0)
  t2('Ignore all here')
  await idle()
  expect(rootBlock(w)).toEqual({ ignored: ['a-skill', 'b-skill'] })
})

test('a late Ignore all here drops names the standard names by now', async ($, on) => {
  const { tap, opts } = ownLate()
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  w.files[USER_FILE] = JSON.stringify({ mode: 'enforce', skills: { 'writing-guide': { always: true }, 'a-skill': { always: true } } })
  tap('Ignore all here')
  await idle()
  expect(rootBlock(w)).toEqual({ ignored: ['b-skill'] })
})

test('a late Ignore all here writes ignored and one feedback line', async ($, on) => {
  const { tap, opts } = ownLate()
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  tap('Ignore all here')
  await idle()
  expect(rootBlock(w)).toEqual({ ignored: ['a-skill', 'b-skill'] })
  expect(w.logs.filter((l) => l === 'Souffleur: 2 skills ignored in this project.').length).toBe(1)
})

test('an in-time Ignore all here also says how many were ignored', async ($, on) => {
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: ['a-skill', 'b-skill'], answers: ['Ignore all here'] })
  await start($)
  await turnEnd($)
  expect(w.logs.filter((l) => l === 'Souffleur: 2 skills ignored in this project.').length).toBe(1)
})

test('a late Later does nothing', async ($, on) => {
  const { tap, opts } = ownLate()
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  tap('Later')
  await idle()
  expect(w.writes.length).toBe(0)
  expect(w.logs.some((l) => /ignored in this project/.test(l))).toBe(false)
})

test('a late answer after the key was written meanwhile does nothing', async ($, on) => {
  const { tap, opts } = ownLate()
  const w = world(on, { [USER_FILE]: STD }, opts)
  await start($)
  await ownTimedOut($, w)
  w.files[USER_FILE] = JSON.stringify({ mode: 'enforce', skills: { 'writing-guide': { always: true } }, projects: { [MAIN]: { ignored: ['a-skill'] } } })
  const before = w.writes.length
  tap('Ignore all here')
  await idle()
  expect(w.writes.length).toBe(before)
  expect(w.logs.some((l) => /ignored in this project/.test(l))).toBe(false)
})

test('a line names every skill before the dialog opens', async ($, on) => {
  const names = Array.from({ length: 7 }, (_, i) => `skill-${i}`)
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: names, answers: ['Later'] })
  await start($)
  await turnEnd($)
  const line = `Souffleur: skills in this project not in your config: ${names.join(', ')}`
  expect(w.logs.some((l) => l.startsWith(line))).toBe(true)
})

test('more than 40 names: the line shows 40 and counts the rest', async ($, on) => {
  const names = Array.from({ length: 45 }, (_, i) => `s${String(i).padStart(2, '0')}`)
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: names, answers: ['Later'] })
  await start($)
  await turnEnd($)
  expect(w.logs.some((l) => /not in your config: s00, .*s39 and 5 more/.test(l))).toBe(true)
})

test('where no dialog opens one notice names the count and nothing is written', async ($, on) => {
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: ['a-skill', 'b-skill'], answers: 'reject' })
  await start($)
  await turnEnd($)
  await turnEnd($)
  expect(w.logs.filter((l) => l === NOTICE2).length).toBe(1)
  expect(w.writes.length).toBe(0)
})

test('a waiting proposal is asked first and the own skills wait for the next turn end', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', skills: { 'dev-workflow': { always: true } } }) }, { repoRoot: MAIN, projectSkills: ['proj-skill'], answers: ['Yes, everywhere', 'Later'] })
  await start($)
  await propose($, AGENT_RULE)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(w.asked[0]).not.toMatch(/proj-skill/)
  await turnEnd($)
  expect(w.asked.length).toBe(2)
  expect(w.asked[1]).toMatch(/proj-skill/)
})

test('own-skill questions never come outside a repository, with a key present, or for names already known', async ($, on) => {
  const outside = world(on, { [USER_FILE]: STD }, { projectSkills: ['proj-skill'], answers: ['Ignore all here'] })
  await start($)
  await turnEnd($)
  expect(outside.asked.length).toBe(0)
  expect(outside.writes.length).toBe(0)
})

test('a root with a key, and names in the standard or ignored, are not asked about', async ($, on) => {
  const keyed = world(on, { [USER_FILE]: JSON.stringify({ skills: {}, projects: { [`${MAIN}/`]: {} } }) }, { repoRoot: MAIN, projectSkills: ['proj-skill'], answers: ['Ignore all here'] })
  await start($)
  await turnEnd($)
  expect(keyed.asked.length).toBe(0)
  expect(keyed.writes.length).toBe(0)
})

test('names the standard or the repository file already has are not asked about', async ($, on) => {
  const w = world(on, { [USER_FILE]: STD, [`${MAIN}/.claude/souffleur.json`]: JSON.stringify({ skills: { 'repo-skill': { always: true } } }) }, { repoRoot: MAIN, projectSkills: ['writing-guide', 'repo-skill'], answers: ['Ignore all here'] })
  await start($)
  await turnEnd($)
  expect(w.asked.length).toBe(0)
  expect(w.writes.length).toBe(0)
})

test('init asks again about a project skill, offers this project or everywhere, and skips ignored names', async ($, on) => {
  const here = world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', skills: {} }) }, { repoRoot: MAIN, projectSkills: ['proj-skill', 'old-skill'], answers: ['When the task needs it', 'This project only', "Don't watch"] })
  await start($)
  await run($, 'init')
  expect(here.asked.some((q) => /where/i.test(q) && /proj-skill/.test(q))).toBe(true)
  const w1 = JSON.parse(userWrites(here).at(-1)!.text)
  expect(w1.skills['proj-skill']).toBeUndefined()
  expect(w1.projects[MAIN].skills['proj-skill'].need).toBeTruthy()
  expect(w1.projects[MAIN].ignored).toEqual(['old-skill'])
})

test('init does not ask again about a name ignored here', async ($, on) => {
  const user = JSON.stringify({ mode: 'enforce', skills: {}, projects: { [MAIN]: { ignored: ['old-skill'] } } })
  const w = world(on, { [USER_FILE]: user }, { repoRoot: MAIN, projectSkills: ['old-skill'], answers: [] })
  await start($)
  await run($, 'init')
  expect(w.asked.join('\n')).not.toMatch(/old-skill/)
})

test('init Everywhere puts the project skill into the standard', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ mode: 'enforce', skills: {} }) }, { repoRoot: MAIN, projectSkills: ['proj-skill'], answers: ['From the start', 'Everywhere'] })
  await start($)
  await run($, 'init')
  const written = JSON.parse(userWrites(w).at(-1)!.text)
  expect(written.skills['proj-skill']).toEqual({ always: true })
  expect(written.projects?.[MAIN]?.skills).toBeUndefined()
})

// --- last fix round ---

test('a session that reports no interactive prompt (Remote Control) still gets the project question', async ($, on) => {
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: ['proj-skill'], answers: ['Ignore all here'] })
  await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: false })
  await $.prompt.submit({ text: 'hello', origin: { kind: 'bridge' } } as never)
  await turnEnd($)
  expect(w.asked.length).toBe(1)
  expect(rootBlock(w)).toEqual({ ignored: ['proj-skill'] })
})

test('a headless sdk session gets the notice instead of the dialog', async ($, on) => {
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: ['proj-skill'], answers: ['Ignore all here'] })
  await $.session.start({ cwd: '/work/proj', surface: null, isInteractive: false })
  await $.prompt.submit({ text: 'hello', origin: { kind: 'sdk' } } as never)
  await turnEnd($)
  expect(w.asked.length).toBe(0)
  expect(w.logs.some((l) => /this project has 1 skills? not in your config/.test(l))).toBe(true)
  expect(w.writes.length).toBe(0)
})

test('Set up now reports only what it wrote, with its scope', async ($, on) => {
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: ['proj-skill', 'second-skill'], answers: ['Set up now', 'When the task needs it', 'This project only', "Don't watch"] })
  await start($)
  await turnEnd($)
  const report = w.logs.find((l) => /proj-skill: watched for/.test(l)) ?? ''
  expect(report).toMatch(/proj-skill: watched for .* in this project/)
  expect(report).toMatch(/second-skill: ignored here/)
  expect(report).not.toMatch(/Souffleur init|Installed and not watched|migrate|New entries apply/)
})

test('Set up now with nothing written says so in one line', async ($, on) => {
  const w = world(on, { [USER_FILE]: STD }, { repoRoot: MAIN, projectSkills: ['proj-skill'], answers: ['Set up now', 'Stop'] })
  await start($)
  await turnEnd($)
  expect(w.logs).toContain('Souffleur: nothing set up; /souffleur init asks again.')
})

test('init saves one backup per session like the other writers', async ($, on) => {
  const user = JSON.stringify({ mode: 'enforce', skills: {} })
  const w = world(on, { [USER_FILE]: user }, { repoRoot: MAIN, projectSkills: ['a-skill', 'b-skill'], answers: ['From the start', 'Everywhere', 'From the start', 'Everywhere'] })
  await start($)
  await run($, 'init')
  const backups = w.writes.filter((x) => /souffleur\.json\.bak-\d{13}$/.test(x.path))
  expect(backups.length).toBe(1)
  expect(backups[0]!.text).toBe(user)
})

test('block works on a user file that starts with a byte order mark', async ($, on) => {
  const w = world(on, { [USER_FILE]: `\ufeff${BLOCKABLE}` })
  await start($)
  expect(await run($, 'block writing-guide')).toMatch(/blocked in/)
  expect(JSON.parse(userWrites(w).at(-1)!.text).projects['/work/proj'].block).toEqual(['writing-guide'])
})

// --- Small-model cost (#64) ---

const COST_CFG = JSON.stringify({ mode: 'enforce', skills: { g: { need: 'n' } }, needs: { n: { for: 'work', what: 'Something.' } } })
const USAGE = { input_tokens: 100, output_tokens: 2, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 }

test('the classifier asks through complete with a fixed instruction, the labels and the text', async ($, on) => {
  const requests: Record<string, unknown>[] = []
  const w = world(on, { [USER_FILE]: COST_CFG }, { classify: 'match', usage: USAGE, classifyRequests: requests })
  await start($)
  await $.prompt.submit({ text: 'fix the build' })
  expect(w.classifyCalls()).toBe(2)
  const a = requests.find((r) => String(r.prompt).includes('chat-reply'))!
  expect(a.model).toBe('haiku')
  expect(a.maxTokens).toBe(10)
  expect(String(a.system)).toMatch(/classifier/i)
  expect(String(a.prompt)).toMatch(/^Labels: chat-reply, text-for-others, screen, code-or-repo-work\n\nText:\nWhat will the agent produce[\s\S]*Prompt:\nfix the build$/)
  const b = requests.find((r) => !String(r.prompt).includes('chat-reply'))!
  expect(String(b.prompt)).toMatch(/^Labels: n, none\n\nText:\n/)
  expect(a.system).toBe(b.system)
})

test('clip keeps the head and the tail of a long text and leaves a short one alone', () => {
  expect(clip('short')).toBe('short')
  expect(clip('a'.repeat(2000))).toBe('a'.repeat(2000))
  const out = clip('h'.repeat(1500) + 'm'.repeat(5000) + 't'.repeat(500))
  expect(out).toBe(`${'h'.repeat(1500)}\n…\n${'t'.repeat(500)}`)
})

test('a 200 KB prompt sends at most about 2,005 characters of prompt text in each call', async ($, on) => {
  const requests: Record<string, unknown>[] = []
  const w = world(on, { [USER_FILE]: COST_CFG }, { classify: 'match', classifyRequests: requests })
  await start($)
  await $.prompt.submit({ text: `fix ${'x'.repeat(200_000)} done` })
  expect(w.classifyCalls()).toBe(2)
  for (const r of requests) {
    const text = String(r.prompt).split('Prompt:\n').at(-1)!.split('\n\n').at(-1)!
    expect(text.length).toBeLessThanOrEqual(2010)
    expect(String(r.prompt).length).toBeLessThan(3000)
  }
})

test('both classifier calls pass their own timeout to the model', async ($, on) => {
  const requests: Record<string, unknown>[] = []
  world(on, { [USER_FILE]: COST_CFG }, { classify: 'match', classifyRequests: requests })
  await start($)
  await $.prompt.submit({ text: 'fix the build' })
  expect(requests.find((r) => String(r.prompt).includes('chat-reply'))!.timeoutMs).toBe(2500)
  expect(requests.find((r) => !String(r.prompt).includes('chat-reply'))!.timeoutMs).toBe(4000)
})

// Each classified prompt makes two calls (A and B).
test('after three failed runs the classifier pauses for 10 prompts, then probes once', async ($, on) => {
  let answer = 'unsure'
  const w = world(on, { [USER_FILE]: COST_CFG }, { classify: () => answer })
  await start($)
  for (const t of ['one', 'two', 'three']) await $.prompt.submit({ text: t })
  expect(w.classifyCalls()).toBe(6)
  for (let i = 0; i < 10; i++) await $.prompt.submit({ text: `skipped ${i}` })
  expect(w.classifyCalls()).toBe(6)
  expect(w.statuses.at(-1)).toMatch(/degraded/)
  // the probe fails: another 10 prompts without a call
  await $.prompt.submit({ text: 'probe one' })
  expect(w.classifyCalls()).toBe(8)
  for (let i = 0; i < 10; i++) await $.prompt.submit({ text: `skipped again ${i}` })
  expect(w.classifyCalls()).toBe(8)
  // the next probe succeeds and resets the breaker
  answer = 'no-match'
  await $.prompt.submit({ text: 'probe two' })
  expect(w.classifyCalls()).toBe(10)
  expect(w.statuses.at(-1)).not.toMatch(/degraded/)
  await $.prompt.submit({ text: 'normal' })
  expect(w.classifyCalls()).toBe(12)
})

test('a classifier answer with whitespace and a period still starts the need', async ($, on) => {
  const w = world(on, { [USER_FILE]: COST_CFG }, { classify: (labels) => (labels?.includes('chat-reply') ? ' code-or-repo-work.\n' : 'n.') })
  await start($)
  await $.prompt.submit({ text: 'fix the build' })
  expect(w.debugLogs.join('\n')).not.toMatch(/classifier/)
})

test('every classifier call is counted with its tokens in /souffleur, the status and the store total', async ($, on) => {
  const w = world(on, { [USER_FILE]: COST_CFG }, { classify: 'match', usage: { input_tokens: 1_000_000, output_tokens: 0 } })
  await start($)
  await $.prompt.submit({ text: 'fix the build' })
  await settle()
  expect(await table($)).toMatch(/^Small model: 2 calls, 2\.0M in \/ 0 out, about \$0\.20 this session \(total 2 calls, about \$0\.20\)\. Estimate at list price\.$/m)
  await settle()
  expect(w.statuses.at(-1)).toMatch(/ · ~\$0\.20$/)
  await settle()
  expect(w.stored['modelUseTotal']).toMatchObject({ calls: 2, input: 2_000_000, usd: 0.2 })
})

test('a rejected classifier call counts as a call without tokens', async ($, on) => {
  const w = world(on, { [USER_FILE]: COST_CFG }, { classifyRejected: true, usage: USAGE })
  await start($)
  await $.prompt.submit({ text: 'fix the build' })
  expect(w.classifyCalls()).toBeGreaterThan(0)
  await settle()
  expect(await table($)).toMatch(/^Small model: \d calls, 0 in \/ 0 out,/m)
  expect(w.debugLogs.join('\n')).toMatch(/classifier: rejected/)
})

test('a late classifier result after the timeout is counted once', async ($, on) => {
  let release!: () => void
  const hold = new Promise<void>((r) => { release = r })
  const w = world(on, { [USER_FILE]: COST_CFG }, { classify: 'match', usage: USAGE, holdClassify: hold })
  await start($)
  const p = $.prompt.submit({ text: 'fix the build' })
  await w.clock.advance(5000)
  await p
  expect(w.debugLogs.join('\n')).toMatch(/classifier: timeout/)
  expect(await table($)).not.toMatch(/Small model/)
  release()
  await settle()
  await settle()
  expect(await table($)).toMatch(/^Small model: 2 calls, 300 in \/ 4 out,/m)
  await settle()
  await settle()
  expect(await table($)).toMatch(/^Small model: 2 calls,/m)
  await settle()
  expect(w.stored['modelUseTotal']).toMatchObject({ calls: 2 })
})

test('the learn call and the rule shaping call are counted', async ($, on) => {
  world(on, { [USER_FILE]: ENFORCE }, { shaped: '{"kind":"note","text":"Always say hi."}', usage: USAGE })
  await start($)
  await mainLoad($, 'skill-a', 'Always do a.')
  await settle()
  expect(await table($)).toMatch(/^Small model: 1 call, 150 in \/ 2 out,/m)
  await run($, 'rule Always say hi')
  await settle()
  expect(await table($)).toMatch(/^Small model: 2 calls, 300 in \/ 4 out,/m)
})

test('the status line shows the cost with notices off', async ($, on) => {
  const cfg = JSON.stringify({ mode: 'enforce', notices: false, skills: { g: { need: 'n' } }, needs: { n: { for: 'work', what: 'Something.' } } })
  const w = world(on, { [USER_FILE]: cfg }, { classify: 'match', usage: { input_tokens: 1_000_000 } })
  await start($)
  await $.prompt.submit({ text: 'fix the build' })
  await settle()
  expect(w.statuses.at(-1)).toMatch(/ · ~\$0\.20$/)
  expect(w.toasts).toEqual([])
})

test('no calls: no cost in the status and no line in /souffleur', async ($, on) => {
  const w = world(on, { [USER_FILE]: COST_CFG })
  await start($)
  expect(w.statuses.at(-1) ?? '').not.toMatch(/\$/)
  expect(await table($)).not.toMatch(/Small model/)
})

test('a new session starts at zero while the total keeps counting', async ($, on) => {
  const w = world(on, { [USER_FILE]: COST_CFG }, { classify: 'match', usage: USAGE })
  await start($)
  await $.prompt.submit({ text: 'one' })
  w.setId('s2')
  await settle()
  expect(await table($)).toMatch(/^Small model: no calls this session \(total 2 calls,/m)
  await $.prompt.submit({ text: 'two' })
  await settle()
  expect(await table($)).toMatch(/^Small model: 2 calls, 300 in \/ 4 out, .* this session \(total 4 calls,/m)
})

test('the count survives a reload of the session', async ($, on) => {
  const w = world(on, { [USER_FILE]: COST_CFG }, { classify: 'match', usage: USAGE })
  await start($)
  await $.prompt.submit({ text: 'one' })
  await start($)
  await settle()
  expect(await table($)).toMatch(/^Small model: 2 calls,/m)
  await settle()
  expect(w.stored['modelUseTotal']).toMatchObject({ calls: 2 })
})

test('a store failure for the total fails no hook and keeps the session count', async ($, on) => {
  const w = world(on, { [USER_FILE]: COST_CFG }, { classify: 'match', usage: USAGE, failStoreKey: 'modelUseTotal' })
  await start($)
  const r = await $.prompt.submit({ text: 'fix the build' })
  expect(r.text).toBe('fix the build')
  await settle()
  const t = await table($)
  expect(t).toMatch(/^Small model: 2 calls,/m)
  expect(t).not.toMatch(/Errors:/)
  await settle()
  expect(w.stored['modelUseTotal']).toBeUndefined()
})

test('counting never delays the answer: a held total write does not hold the prompt', async ($, on) => {
  let release!: () => void
  const hold = new Promise<void>((r) => { release = r })
  const w = world(on, { [USER_FILE]: COST_CFG }, { classify: 'match', usage: USAGE, holdTotal: hold })
  await start($)
  // The total write is held: the prompt must still return (a hang fails the test by its own timeout).
  await $.prompt.submit({ text: 'fix the build' })
  release()
  await settle()
  expect(w.stored['modelUseTotal']).toMatchObject({ calls: 2 })
})

// --- Liveness time in the status line (#41) ---

const HHMM = (ms: number) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` }

test('the status line shows the time of the last activity', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · observe · /)
  await $.prompt.submit({ text: 'hello' })
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · observe · 0 loaded, 1 restoring$/)
})

test('a main-loop turn end stamps lastSeen; a subagent turn end does not', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  const first = (w.stored['session:s1'] as any).lastSeen as number
  await w.clock.advance(120_000)
  await turnEnd($, { agentId: 'a1' })
  expect((w.stored['session:s1'] as any).lastSeen).toBe(first)
  await turnEnd($)
  const later = (w.stored['session:s1'] as any).lastSeen as number
  expect(later).toBeGreaterThan(first)
  expect(w.statuses.at(-1)).toMatch(new RegExp(`^${HHMM(later)} · `))
})

test('a resume shows a time in the status line at once', async ($, on) => {
  const { config } = parseConfig(ALWAYS, undefined)
  const old = { ...initSession(config, 's1', 1, 'startup', '2.1.331'), lastSeen: new Date(2026, 10, 27, 14, 2).getTime() }
  const w = world(on, { [USER_FILE]: ALWAYS }, { stored: { 'session:s1': old } })
  await start($)
  expect(w.statuses.at(-1)).toMatch(/^\d\d:\d\d · /)
})

// ---- update notice ----

const LS = (...tags: string[]) => tags.map((t, i) => `${String(i + 1).padStart(40, 'a')}\trefs/tags/${t}`).join('\n')
const NEWER = 'v0.2.99'
const NEWER_V = NEWER.slice(1)
const lsRemoteCalls = (w: World) => w.runs.filter((r) => r.argv.includes('ls-remote'))
const FOLDER_ROOT = (argv: readonly string[]) => (argv.includes('rev-parse') ? { exitCode: 0, stdout: '\n', stderr: '' } : undefined)
const MARKET_ROOT = (argv: readonly string[]) => (argv.includes('rev-parse') ? { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' } : undefined)
const runWith = (ls: { exitCode: number; stdout: string }, root = FOLDER_ROOT): NonNullable<Opts['run']> => (argv) => {
  const r = root(argv)
  if (r) return r
  return { ...ls, stderr: '' }
}
const SETUP = { [USER_FILE]: ALWAYS }

test('update: a due check runs ls-remote once and stores updateCheck', async ($, on) => {
  const w = world(on, SETUP, { run: runWith({ exitCode: 0, stdout: LS('v0.1.0', NEWER, 'v0.3.0-rc.1') }) })
  await start($)
  await settleUpdate(w)
  const calls = lsRemoteCalls(w)
  expect(calls.length).toBe(1)
  expect(calls[0]!.argv).toEqual(['git', 'ls-remote', '--tags', '--refs', 'https://github.com/r4KK4n/skill-souffleur'])
  expect(calls[0]!.timeoutMs).toBe(15000)
  expect(w.stored.updateCheck).toEqual({ at: expect.any(Number), latest: NEWER })
})

test('update: nothing newer stores the running version as latest', async ($, on) => {
  const w = world(on, SETUP, { run: runWith({ exitCode: 0, stdout: LS('v0.1.0', `v${PLUGIN_VERSION}`) }) })
  await start($)
  await settleUpdate(w)
  expect(w.stored.updateCheck).toEqual({ at: expect.any(Number), latest: `v${PLUGIN_VERSION}` })
  expect(w.logs.some((l) => l.includes('is out'))).toBe(false)
})

test('update: unparsable ls-remote output logs a debug line and stores at only', async ($, on) => {
  const w = world(on, SETUP, { run: runWith({ exitCode: 0, stdout: '<html>nope</html>' }) })
  await start($)
  await settleUpdate(w)
  expect(w.debugLogs).toContain('update check: unparsable ls-remote output')
  expect(w.stored.updateCheck).toEqual({ at: expect.any(Number) })
})

test('update: a fresh check does not run', async ($, on) => {
  const w = world(on, SETUP, { stored: { updateCheck: { at: T0 - 3_600_000 } }, run: runWith({ exitCode: 0, stdout: LS(NEWER) }) })
  await start($)
  await settleUpdate(w)
  expect(lsRemoteCalls(w).length).toBe(0)
})

test('update: an old check runs again', async ($, on) => {
  const w = world(on, SETUP, { stored: { updateCheck: { at: T0 - 90_000_000 } }, run: runWith({ exitCode: 0, stdout: LS(NEWER) }) })
  await start($)
  await settleUpdate(w)
  expect(lsRemoteCalls(w).length).toBe(1)
})

test('update: off runs nothing and says nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: JSON.stringify({ update: 'off' }) }, { stored: { updateCheck: { at: 1, latest: NEWER } }, run: runWith({ exitCode: 0, stdout: LS(NEWER) }) })
  await start($)
  await settleUpdate(w)
  expect(w.runs.length).toBe(0)
  expect(w.logs.some((l) => l.includes('is out'))).toBe(false)
})

test('update: a failed run stores at, logs to debug and shows no notice', async ($, on) => {
  const w = world(on, SETUP, { run: runWith({ exitCode: 128, stdout: '' }) })
  await start($)
  await settleUpdate(w)
  expect(w.stored.updateCheck).toEqual({ at: expect.any(Number) })
  expect(w.debugLogs.some((l) => l.startsWith('update check failed: '))).toBe(true)
  expect(w.logs.some((l) => l.includes('is out'))).toBe(false)
})

test('update: a rejected run (timeout) is stored too and keeps the earlier latest', async ($, on) => {
  const w = world(on, SETUP, { stored: { updateCheck: { at: 1, latest: 'v0.0.1' } }, run: (argv) => (argv.includes('rev-parse') ? FOLDER_ROOT(argv)! : new Error('timed out')) })
  await start($)
  await settleUpdate(w)
  expect(w.stored.updateCheck).toEqual({ at: expect.any(Number), latest: 'v0.0.1' })
  expect(w.debugLogs.some((l) => l.startsWith('update check failed: ') && l.includes('timed out'))).toBe(true)
})

test('update: a stored newer latest says the notify line once; a reload does not repeat it', async ($, on) => {
  const w = world(on, SETUP, { stored: { updateCheck: { at: T0, latest: NEWER } }, run: runWith({ exitCode: 0, stdout: '' }) })
  await start($)
  await settleUpdate(w)
  const line = `Souffleur ${NEWER_V} is out (you run ${PLUGIN_VERSION}). /souffleur update installs it.`
  expect(w.logs.filter((l) => l === line).length).toBe(1)
  await start($)
  await settleUpdate(w, 2)
  expect(w.logs.filter((l) => l === line).length).toBe(1)
})

test('update: the marketplace install is pointed to /plugin update', async ($, on) => {
  const w = world(on, SETUP, { stored: { updateCheck: { at: T0, latest: NEWER } }, run: runWith({ exitCode: 0, stdout: '' }, MARKET_ROOT) })
  await start($)
  await settleUpdate(w)
  expect(w.logs).toContain(`Souffleur ${NEWER_V} is out (you run ${PLUGIN_VERSION}). /plugin update installs it.`)
})

test('update: a stored latest that is not newer says nothing', async ($, on) => {
  const w = world(on, SETUP, { stored: { updateCheck: { at: T0, latest: `v${PLUGIN_VERSION}` } }, run: runWith({ exitCode: 0, stdout: '' }) })
  await start($)
  await settleUpdate(w)
  expect(w.logs.some((l) => l.includes('is out'))).toBe(false)
})

test('update: a never-resolving process.run does not hold session.start', async ($, on) => {
  world(on, SETUP, { run: () => new Promise(() => {}) })
  await start($)
})

test('update: /souffleur shows the version line from the stored check', async ($, on) => {
  const w = world(on, SETUP, { stored: { updateCheck: { at: T0, latest: NEWER } }, run: runWith({ exitCode: 0, stdout: '' }) })
  await start($)
  await settleUpdate(w)
  expect(await table($)).toContain(`Version ${PLUGIN_VERSION} · latest ${NEWER_V} ·`)
})

test('update: a cached install kind shows the line at start although rev-parse never answers', async ($, on) => {
  const w = world(on, SETUP, { stored: { installKind: 'folder', updateCheck: { at: T0, latest: NEWER } }, run: (argv) => (argv.includes('rev-parse') ? new Promise(() => {}) : { exitCode: 0, stdout: '', stderr: '' }) })
  await start($)
  expect(w.logs).toContain(`Souffleur ${NEWER_V} is out (you run ${PLUGIN_VERSION}). /souffleur update installs it.`)
})

test('update: the first run learns the install kind, stores it and says the line once', async ($, on) => {
  const w = world(on, SETUP, { stored: { updateCheck: { at: T0, latest: NEWER } }, run: runWith({ exitCode: 0, stdout: '' }, MARKET_ROOT) })
  await start($)
  await settleUpdate(w)
  expect(w.stored.installKind).toBe('market')
  expect(w.logs.filter((l) => l.includes('/plugin update installs it.')).length).toBe(1)
  await start($)
  await settleUpdate(w, 2)
  expect(w.logs.filter((l) => l.includes('is out')).length).toBe(1)
})

test('update: a plugin folder inside a work tree (non-empty prefix) is a marketplace install', async ($, on) => {
  const w = world(on, SETUP, { stored: { updateCheck: { at: T0, latest: NEWER } }, run: (argv) => (argv.includes('rev-parse') ? { exitCode: 0, stdout: 'plugins/x/\n', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' }) })
  await start($)
  await settleUpdate(w)
  expect(w.stored.installKind).toBe('market')
  expect(w.runs.find((r) => r.argv.includes('rev-parse'))!.argv).toContain('--show-prefix')
})

test('update: a second start before the first detached work finishes does not say the line twice', async ($, on) => {
  let release: (v: { exitCode: number; stdout: string; stderr: string }) => void = () => {}
  const held = new Promise<{ exitCode: number; stdout: string; stderr: string }>((r) => { release = r })
  const w = world(on, SETUP, { stored: { updateCheck: { at: T0, latest: NEWER } }, run: (argv) => (argv.includes('rev-parse') ? held : { exitCode: 0, stdout: '', stderr: '' }) })
  await start($)
  await start($)
  release({ exitCode: 0, stdout: '\n', stderr: '' })
  await settleUpdate(w, 2)
  await settle()
  expect(w.logs.filter((l) => l.includes('is out')).length).toBe(1)
})

// ---- update install ----

/**
 * Waits until the detached update work of `starts` session starts has said it is done (debug line `update work done`).
 * The engine runs its own copy of the mod, so the test cannot read a promise from it; the debug line is the signal.
 */
const settleUpdate = async (w: World, starts = 1) => {
  for (let i = 0; i < 200 && w.debugLogs.filter((l) => l === 'update work done').length < starts; i++) await settle()
  expect(w.debugLogs.filter((l) => l === 'update work done').length).toBeGreaterThanOrEqual(starts)
}

let nextId = 0
/** A session id of its own, so the module-level once-per-session guards of an earlier test do not apply. */
const own = (w: World) => w.setId(`upd-${++nextId}`)

const SIGNER = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA test@example'
const AUTO_FILE = { [USER_FILE]: JSON.stringify({ update: 'auto', updateSigner: SIGNER }) }
const AUTO_NO_SIGNER = { [USER_FILE]: JSON.stringify({ update: 'auto' }) }
const OK = { exitCode: 0, stdout: '', stderr: '' }
const STORED_NEWER = { installKind: 'folder', updateCheck: { at: T0, latest: NEWER } }
/** Nothing newer is known, so the session start does no install of its own. */
const QUIET = { installKind: 'folder', updateCheck: { at: T0, latest: 'v0.0.1' } }
const OID = 'f'.repeat(40)
const SSH_TAG = (name: string) => `object ${'a'.repeat(40)}\ntype commit\ntag ${name}\ntagger t <t@t> 1 +0000\n\nrelease\n-----BEGIN SSH SIGNATURE-----\nU1NIU0lH\n-----END SSH SIGNATURE-----\n`
const GOOD = 'Good "git" signature for souffleur with ED25519 key SHA256:abc'
type Out = { exitCode: number; stdout?: string; stderr?: string } | Error
/** A folder install on a clean tag; `over` answers a git subcommand first (`resolve` is `rev-parse --verify`). */
const gitRun = (over: Record<string, Out> = {}): NonNullable<Opts['run']> => (argv) => {
  const sub = argv.includes('--verify') ? 'resolve' : ['rev-parse', 'status', 'describe', 'fetch', 'verify-tag', 'cat-file', 'checkout', 'ls-remote'].find((c) => argv.includes(c))
  const out = (o: Out) => (o instanceof Error ? o : { exitCode: o.exitCode, stdout: o.stdout ?? '', stderr: o.stderr ?? '' })
  if (sub !== undefined && over[sub] !== undefined) return out(over[sub]!)
  switch (sub) {
    case 'rev-parse': return { exitCode: 0, stdout: '\n', stderr: '' }
    case 'resolve': return { exitCode: 0, stdout: `${OID}\n`, stderr: '' }
    case 'describe': return { exitCode: 0, stdout: `v${PLUGIN_VERSION}\n`, stderr: '' }
    case 'ls-remote': return { exitCode: 0, stdout: LS(NEWER), stderr: '' }
    case 'cat-file': return { exitCode: 0, stdout: SSH_TAG(NEWER), stderr: '' }
    case 'verify-tag': return { exitCode: 0, stdout: '', stderr: GOOD }
    default: return OK
  }
}
const ran = (w: World, sub: string) => w.runs.filter((r) => r.argv.includes(sub))
/** The plugin root the mod asked git about. */
const rootOf = (w: World) => String(w.runs[0]!.argv[2])
const AUTO_LINE = `Souffleur updated to ${NEWER_V} (tag signed by your key).`

test('update auto: a verified tag is fetched, verified, checked out and said once', async ($, on) => {
  const w = world(on, AUTO_FILE, { stored: STORED_NEWER, run: gitRun() })
  own(w)
  await start($)
  await settleUpdate(w)
  expect(w.logs.filter((l) => l === AUTO_LINE).length).toBe(1)
  expect(ran(w, 'checkout').length).toBe(1)
  expect(ran(w, 'checkout')[0]!.argv.at(-1)).toBe(`${OID}^{commit}`)
  expect(ran(w, 'fetch')[0]!.timeoutMs).toBe(30000)
  for (const r of ran(w, 'status').concat(ran(w, 'describe'), ran(w, 'verify-tag'), ran(w, 'checkout'))) expect(r.timeoutMs).toBe(10000)
  expect((w.stored.updateCheck as { latest: string }).latest).toBe(NEWER)
  await start($)
  await settleUpdate(w)
  expect(ran(w, 'checkout').length).toBe(1)
  expect(w.logs.filter((l) => l === AUTO_LINE).length).toBe(1)
})

test('update auto: the allowed_signers file is written with the current key before verifying', async ($, on) => {
  const w = world(on, AUTO_FILE, { stored: STORED_NEWER, run: gitRun() })
  own(w)
  await start($)
  await settleUpdate(w)
  const w2 = w.writes.filter((x) => x.path === '/data/souffleur/allowed_signers')
  expect(w2.map((x) => x.text)).toEqual([`souffleur namespaces="git" ${SIGNER}\n`])
  const v = ran(w, 'verify-tag')[0]!.argv
  expect(v).toContain('gpg.format=ssh')
  expect(v).toContain('gpg.ssh.allowedSignersFile=/data/souffleur/allowed_signers')
  expect(v[v.length - 1]).toBe(OID)
})

test('update auto: a tag that does not verify says so and runs no checkout', async ($, on) => {
  const w = world(on, AUTO_FILE, { stored: STORED_NEWER, run: gitRun({ 'verify-tag': { exitCode: 1 } }) })
  own(w)
  await start($)
  await settleUpdate(w)
  expect(w.logs).toContain(`Souffleur ${NEWER_V} is out but its tag is not signed by your updateSigner key; not installed. Update by hand with git in ${rootOf(w)}.`)
  expect(ran(w, 'checkout').length).toBe(0)
})

test('update auto: without updateSigner it says the no-signer line and runs no checkout', async ($, on) => {
  const w = world(on, AUTO_NO_SIGNER, { stored: STORED_NEWER, run: gitRun() })
  own(w)
  await start($)
  await settleUpdate(w)
  expect(w.logs).toContain(`Souffleur ${NEWER_V} is out (you run ${PLUGIN_VERSION}). /souffleur update installs it. Set updateSigner to let auto install it.`)
  expect(w.logs.filter((l) => l.includes('is out')).length).toBe(1)
  expect(w.stored.installKind).toBe('folder')
  expect(ran(w, 'checkout').length).toBe(0)
  expect(ran(w, 'fetch').length).toBe(0)
})

test('update auto: a marketplace install gets the notify line and no install', async ($, on) => {
  const w = world(on, AUTO_FILE, { stored: { ...STORED_NEWER, installKind: 'market' }, run: gitRun({ 'rev-parse': { exitCode: 128 } }) })
  own(w)
  await start($)
  await settleUpdate(w)
  expect(w.logs).toContain(`Souffleur ${NEWER_V} is out (you run ${PLUGIN_VERSION}). /plugin update installs it.`)
  expect(ran(w, 'checkout').length).toBe(0)
})

for (const [name, over, reason] of [
  ['a dirty tree', { status: { exitCode: 0, stdout: ' M src/x.ts\n' } }, 'uncommitted changes in the install'],
  ['HEAD not on a tag', { describe: { exitCode: 128 } }, 'the install is not on a release tag'],
  ['HEAD on a pre-release tag', { describe: { exitCode: 0, stdout: 'v0.3.0-rc.1\n' } }, 'the install is not on a release tag'],
] as const) {
  test(`update auto: ${name} is refused with its reason and nothing is changed`, async ($, on) => {
    const w = world(on, AUTO_FILE, { stored: STORED_NEWER, run: gitRun(over) })
  own(w)
    await start($)
    await settleUpdate(w)
    expect(w.logs).toContain(`Souffleur: not updated, ${reason}. Update by hand with git in ${rootOf(w)}.`)
    expect(ran(w, 'status').length).toBe(1)
    expect(ran(w, 'checkout').length).toBe(0)
    expect(ran(w, 'fetch').length).toBe(0)
  })
}

test('update auto: verification and checkout use the resolved object id, never the bare tag name', async ($, on) => {
  const w = world(on, AUTO_FILE, { stored: STORED_NEWER, run: gitRun() })
  own(w)
  await start($)
  await settleUpdate(w)
  const resolve = w.runs.find((r) => r.argv.includes('--verify'))!.argv
  expect(resolve).toContain(`refs/tags/${NEWER}`)
  expect(ran(w, 'cat-file')[0]!.argv).toContain(OID)
  expect(ran(w, 'verify-tag')[0]!.argv.at(-1)).toBe(OID)
  expect(ran(w, 'checkout')[0]!.argv.at(-1)).toBe(`${OID}^{commit}`)
  expect(ran(w, 'checkout')[0]!.argv).not.toContain(NEWER)
})

test('update: fetch uses the repository URL of the look-up, not origin', async ($, on) => {
  const w = world(on, AUTO_FILE, { stored: STORED_NEWER, run: gitRun() })
  own(w)
  await start($)
  await settleUpdate(w)
  const f = ran(w, 'fetch')[0]!.argv
  expect(f).toContain('https://github.com/r4KK4n/skill-souffleur')
  expect(f).not.toContain('origin')
})

for (const [name, over] of [
  ['a PGP signature (no SSH armor)', { 'cat-file': { exitCode: 0, stdout: `object a\ntype commit\ntag ${NEWER}\n\nx\n-----BEGIN PGP SIGNATURE-----\nzz\n-----END PGP SIGNATURE-----\n` } }],
  ['a tag object named for another release', { 'cat-file': { exitCode: 0, stdout: SSH_TAG('v9.9.9') } }],
  ['a lightweight tag (no tag object)', { 'cat-file': { exitCode: 128 } }],
  ['SSH armor in the message with a PGP block last', { 'cat-file': { exitCode: 0, stdout: `object a\ntype commit\ntag ${NEWER}\n\n-----BEGIN SSH SIGNATURE-----\nx\n-----END SSH SIGNATURE-----\n-----BEGIN PGP SIGNATURE-----\nzz\n-----END PGP SIGNATURE-----\n` } }],
  ['an SSH block that does not end the object', { 'cat-file': { exitCode: 0, stdout: `${SSH_TAG(NEWER)}trailing text\n` } }],
  ['the good text in the middle of a gpg line', { 'verify-tag': { exitCode: 0, stderr: 'gpg: Good signature from "x Good "git" signature for souffleur with y"' } }],
  ['the good text after a U+2028 inside a gpg line', { 'verify-tag': { exitCode: 0, stderr: 'gpg: Good signature from "x\u2028Good "git" signature for souffleur with y"' } }],
  ['the good text after a carriage return inside a gpg line', { 'verify-tag': { exitCode: 0, stderr: 'gpg: Good signature from "x\rGood "git" signature for souffleur with y"' } }],
  ['a verify that exits 0 without the Good line', { 'verify-tag': { exitCode: 0, stderr: 'something else' } }],
] as const) {
  test(`update auto: ${name} is not installed`, async ($, on) => {
    const w = world(on, AUTO_FILE, { stored: STORED_NEWER, run: gitRun(over) })
    own(w)
    await start($)
    await settleUpdate(w)
    expect(ran(w, 'cat-file').length).toBe(1)
    expect(ran(w, 'checkout').length).toBe(0)
    expect(w.logs.some((l) => l.includes('updated to'))).toBe(false)
    expect(w.logs.some((l) => l.includes('is not signed by your updateSigner key'))).toBe(true)
  })
  test(`/souffleur update: ${name} is not installed`, async ($, on) => {
    const w = world(on, AUTO_FILE, { stored: QUIET, run: gitRun(over) })
    own(w)
    await start($)
    expect(await runUser($, 'update')).toMatch(/not signed by your updateSigner key; not installed/)
    expect(ran(w, 'checkout').length).toBe(0)
  })
}

test('/souffleur update: checks out the resolved object id also when unsigned', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun() })
  own(w)
  await start($)
  await runUser($, 'update')
  expect(ran(w, 'checkout')[0]!.argv.at(-1)).toBe(`${OID}^{commit}`)
})

test('/souffleur update: a git failure answers with the reason, not the usage line', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun({ fetch: { exitCode: 1 } }) })
  own(w)
  await start($)
  const text = await runUser($, 'update')
  expect(text).toBe(`Souffleur: could not install ${NEWER_V}: git fetch exited with 1.`)
})

test('/souffleur update: a rejected git call answers with the reason too', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun({ fetch: new Error('timed out') }) })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toMatch(/^Souffleur: could not install 0\.2\.99: /)
})

test('/souffleur update: a failing ls-remote answers with the git message', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun({ 'ls-remote': { exitCode: 128, stderr: 'fatal: unable to access repo\nmore' } }) })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe('Souffleur: could not look up releases: fatal: unable to access repo.')
})

test('/souffleur update: a failing ls-remote without a message answers with the exit code', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun({ 'ls-remote': { exitCode: 128 } }) })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe('Souffleur: could not look up releases: git exited with 128.')
})

test('/souffleur update: a rejected ls-remote answers instead of throwing', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun({ 'ls-remote': new Error('timed out') }) })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toMatch(/^Souffleur: could not look up releases: .*timed out\.$/)
})

test('update auto: a git failure logs to debug, says nothing and does not mark the tag shown', async ($, on) => {
  const w = world(on, AUTO_FILE, { stored: STORED_NEWER, run: gitRun({ fetch: { exitCode: 1 } }) })
  own(w)
  await start($)
  await settleUpdate(w)
  expect(ran(w, 'fetch').length).toBe(1)
  expect(w.debugLogs.some((l) => l.startsWith('update install failed: '))).toBe(true)
  expect(w.logs.some((l) => l.includes('updated to') || l.includes('is out'))).toBe(false)
  expect((w.stored[`session:upd-${nextId}`] as { updateShown?: string } | undefined)?.updateShown).toBeUndefined()
})

test('update auto: a failed fetch installs nothing and says no done line', async ($, on) => {
  const w = world(on, AUTO_FILE, { stored: STORED_NEWER, run: gitRun({ fetch: { exitCode: 1 } }) })
  own(w)
  await start($)
  await settleUpdate(w)
  expect(ran(w, 'checkout').length).toBe(0)
  expect(w.logs.some((l) => l.includes('updated to'))).toBe(false)
})

test('update auto: never delays session.start', async ($, on) => {
  world(on, AUTO_FILE, { stored: STORED_NEWER, run: (argv) => (argv.includes('rev-parse') ? { exitCode: 0, stdout: '\n', stderr: '' } : new Promise(() => {})) })
  await start($)
})

const runUser = async ($: any, args: string, origin: unknown = COMPOSER) => (await $.command.run({ command: 'souffleur', args, ...(origin ? { origin } : {}) })).text as string

test('/souffleur update: installs an unsigned tag when no signer is set, with the unsigned wording', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun() })
  own(w)
  await start($)
  const text = await runUser($, 'update')
  expect(text).toBe(`Souffleur: updated to ${NEWER_V} (unsigned; you asked for it)\nRunning sessions pick it up at their next turn.`)
  expect(ran(w, 'checkout').length).toBe(1)
  expect(ran(w, 'verify-tag').length).toBe(0)
})

test('/souffleur update: with a signer the tag is verified and the answer says signed', async ($, on) => {
  const w = world(on, AUTO_FILE, { stored: QUIET, run: gitRun() })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe(`Souffleur: updated to ${NEWER_V} (signed)\nRunning sessions pick it up at their next turn.`)
  expect(ran(w, 'verify-tag').length).toBe(1)
})

test('/souffleur update: with a signer a tag that does not verify is not installed', async ($, on) => {
  const w = world(on, AUTO_FILE, { stored: QUIET, run: gitRun({ 'verify-tag': { exitCode: 1 } }) })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toMatch(/not signed by your updateSigner key; not installed/)
  expect(ran(w, 'checkout').length).toBe(0)
})

test('/souffleur update: nothing newer says the current version is the newest', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun({ 'ls-remote': { exitCode: 0, stdout: LS(`v${PLUGIN_VERSION}`) } }) })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe(`Souffleur: ${PLUGIN_VERSION} is the newest release.`)
  expect(ran(w, 'checkout').length).toBe(0)
})

test('/souffleur update: a marketplace install is pointed to /plugin update', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun({ 'rev-parse': { exitCode: 128 } }) })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe('Souffleur: installed through the marketplace; run /plugin update.')
  expect(ran(w, 'checkout').length).toBe(0)
})

test('/souffleur update: a dirty tree is refused', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun({ status: { exitCode: 0, stdout: '?? x\n' } }) })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe(`Souffleur: not updated, uncommitted changes in the install. Update by hand with git in ${rootOf(w)}.`)
  expect(ran(w, 'checkout').length).toBe(0)
})

test('/souffleur update: HEAD off a release tag is refused', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun({ describe: { exitCode: 128 } }) })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe(`Souffleur: not updated, the install is not on a release tag. Update by hand with git in ${rootOf(w)}.`)
  expect(ran(w, 'checkout').length).toBe(0)
})

test('/souffleur update: only the user can run it', async ($, on) => {
  const w = world(on, SETUP, { stored: QUIET, run: gitRun() })
  own(w)
  await start($)
  for (const origin of [{ kind: 'plugin', name: 'other' }, { kind: 'model' }]) {
    expect(await runUser($, 'update', origin)).toMatch(/only the user can run/i)
  }
  expect(ran(w, 'checkout').length).toBe(0)
  expect(ran(w, 'fetch').length).toBe(0)
})

test('every verb that changes state refuses a non-user origin, and nothing changes (#34)', async ($, on) => {
  const w = world(on, { [USER_FILE]: UI, [SETTINGS_PATH]: SETTINGS }, { skills: SKILLS, proposals: PICKS, answers: ['When the task needs it'] })
  await start($)
  const before = await run($, 'status')
  for (const origin of [{ kind: 'plugin', name: 'other' }, { kind: 'model' }]) {
    for (const args of ['pause', 'need ui', 'drop ui', 'init', 'migrate']) {
      const r = await $.command.run({ command: 'souffleur', args, origin } as never)
      expect(String(r.text)).toBe(`Souffleur: only the user can run /souffleur ${args.split(' ')[0]}; a plugin or the model cannot.`)
    }
  }
  expect(w.writes.length).toBe(0)
  expect(w.asked.length).toBe(0)
  expect(await run($, 'status')).toBe(before)
  expect(await run($, 'resume')).toBe('Souffleur: not paused.')
})

test('status and a bare /souffleur still answer a non-user origin (#34)', async ($, on) => {
  world(on, { [USER_FILE]: UI }, {})
  await start($)
  const origin = { kind: 'plugin', name: 'other' }
  for (const args of ['', 'status']) {
    const r = await $.command.run({ command: 'souffleur', args, origin } as never)
    expect(String(r.text)).not.toMatch(/only the user can run/i)
    expect(String(r.text)).toMatch(/Mode: enforce/)
  }
})

test('a plugin cannot resume a user pause, and odd spellings of a verb are refused (#34)', async ($, on) => {
  const w = world(on, { [USER_FILE]: UI }, {})
  await start($)
  const origin = { kind: 'plugin', name: 'other' }
  const as = async (args: string) => String((await $.command.run({ command: 'souffleur', args, origin } as never)).text)
  expect(await run($, 'pause')).toMatch(/paused for this session/)
  expect(await as('resume')).toBe('Souffleur: only the user can run /souffleur resume; a plugin or the model cannot.')
  expect(await run($, 'resume')).toBe('Souffleur: checks are on again.') // it was still paused
  expect(await as(' pause')).toMatch(/only the user can run \/souffleur pause;/)
  expect(await as('PAUSE')).toMatch(/only the user can run \/souffleur PAUSE;/)
  expect(await as('frobnicate')).toMatch(/only the user can run \/souffleur frobnicate;/)
  expect(await run($, 'resume')).toBe('Souffleur: not paused.') // none of them paused
  expect(w.writes.length).toBe(0)
})

test('status with a trailing verb from a plugin answers status and does not pause (#34)', async ($, on) => {
  world(on, { [USER_FILE]: UI }, {})
  await start($)
  const r = await $.command.run({ command: 'souffleur', args: 'status pause', origin: { kind: 'plugin', name: 'other' } } as never)
  expect(String(r.text)).toMatch(/Mode: enforce/)
  expect(await run($, 'resume')).toBe('Souffleur: not paused.')
})

// --- The band above the prompt in the apps (#21) ---

const BAND = (surface: 'terminal' | 'desktop') => ({ plugin: 'skill-souffleur', component: 'AbovePrompt', surface, props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 5, columns: 80 } }) as never
const bandText = async ($: any, surface: 'terminal' | 'desktop'): Promise<string | undefined> => {
  const ui = await $.ui.mount(BAND(surface))
  const text = (await ui.find({ type: 'Text' }))?.text as string | undefined
  await ui.unmount()
  return text
}

test('the band is never drawn on the terminal, where the status line shows', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  expect(w.statuses.at(-1)).toMatch(/1 restoring/)
  expect(await bandText($, 'terminal')).toBeUndefined()
})

test('on the desktop nothing is drawn while every skill is loaded', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  expect(await bandText($, 'desktop')).toBeUndefined()
})

test('on the desktop a restoring skill shows the status text', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  expect(await bandText($, 'desktop')).toBe(w.statuses.at(-1))
})

test('on the desktop a skill that is not installed here draws no band', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['pdf'] })
  await start($)
  expect(w.statuses.at(-1)).toMatch(/1 not installed here/)
  expect(await bandText($, 'desktop')).toBeUndefined()
})

test('a band draw is logged to debug only when the surface or the shown value changes', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['pdf'] })
  await start($)
  await bandText($, 'desktop')
  await bandText($, 'desktop')
  await bandText($, 'terminal')
  const lines = w.debugLogs.filter((l) => l.startsWith('band:'))
  expect(lines.length).toBe(2)
  expect(lines[0]).toBe('band: surface=desktop shown=false')
  expect(lines[1]).toBe('band: surface=terminal shown=false')
})

test('on the desktop a session that is not set up shows the not-set-up text', async ($, on) => {
  world(on, {})
  await start($)
  expect(await bandText($, 'desktop')).toBe('not set up, run /souffleur init')
})

test('on the desktop a newer release shows the status line', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS }, { stored: { updateCheck: { at: T0, latest: 'v99.0.0' } } })
  await start($)
  await skillLoaded($, 'writing-guide')
  expect(await bandText($, 'desktop')).toMatch(/1 loaded · 99\.0\.0 is out, see \/souffleur$/)
})

test('on the desktop a newer release shows even with no skills configured', async ($, on) => {
  world(on, { [USER_FILE]: '{}' }, { stored: { updateCheck: { at: T0, latest: 'v99.0.0' } } })
  await start($)
  expect(await bandText($, 'desktop')).toBe('99.0.0 is out, see /souffleur')
})

test('update off hides the band for a newer release left in the store', async ($, on) => {
  world(on, { [USER_FILE]: JSON.stringify({ update: 'off', skills: { 'writing-guide': { always: true } } }) }, { stored: { updateCheck: { at: T0, latest: 'v99.0.0' } } })
  await start($)
  await skillLoaded($, 'writing-guide')
  expect(await bandText($, 'desktop')).toBeUndefined()
})

test('a mounted band goes away when the restoring skill loads, with no new prompt', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await $.prompt.submit({ text: 'hello' })
  const ui = await $.ui.mount(BAND('desktop'))
  expect((await ui.find({ type: 'Text' }))?.text).toMatch(/1 restoring/)
  await skillLoaded($, 'writing-guide')
  expect(await ui.find({ type: 'Text' })).toBeUndefined()
  await ui.unmount()
})

test('a failing store copy does not drop a deny', async ($, on) => {
  const w = world(on, { [USER_FILE]: UI }, { classify: 'match', failStoreKey: 'session:s1' })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  const r = await $.tool.call({ tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never)
  expect(r.deny).toMatch(/ui-checklist/)
  expect(w.debugLogs.join('\n')).toMatch(/store copy failed/)
  expect(await table($)).toMatch(/Errors:\n- store: /)
})

const sessionSets = (w: World) => w.storeSets.filter((k) => k === 'session:s1').length

test('tool calls leave the stored copy alone until the turn ends', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  const before = sessionSets(w)
  for (let i = 0; i < 20; i++) await $.tool.call({ tool: 'Read', path: `a${i}.txt` } as never)
  expect(sessionSets(w)).toBe(before)
  await turnEnd($)
  expect(sessionSets(w)).toBe(before + 1)
})

test('a classified prompt with small-model calls writes no copy before the turn ends', async ($, on) => {
  const w = world(on, { [USER_FILE]: UI }, { classify: 'match' })
  await start($)
  const before = sessionSets(w)
  await $.prompt.submit({ text: 'build me a login screen' })
  expect(w.classifyCalls()).toBeGreaterThan(0)
  expect(sessionSets(w)).toBe(before)
})

test('with a failing store, tool calls do not try the write again before the turn ends', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { failStoreKey: 'session:s1' })
  await start($)
  const before = sessionSets(w)
  for (let i = 0; i < 5; i++) await $.tool.call({ tool: 'Read', path: `a${i}.txt` } as never)
  expect(sessionSets(w)).toBe(before)
  await turnEnd($)
  expect(sessionSets(w)).toBe(before + 1)
})

test('the store error clears after a later flush works', async ($, on) => {
  const opts: Opts = { failStoreKey: 'session:s1' }
  const w = world(on, { [USER_FILE]: ALWAYS }, opts)
  await start($)
  expect(await table($)).toMatch(/- store: /)
  opts.failStoreKey = undefined
  await turnEnd($)
  expect(await table($)).not.toMatch(/store: /)
  expect(w.stored['session:s1']).toBeDefined()
})

test('a proposal change writes the stored copy', async ($, on) => {
  const w = world(on, { [USER_FILE]: ENFORCE }, { answers: 'reject' })
  await start($)
  const before = sessionSets(w)
  await propose($, { kind: 'note', text: 'Answer in German.', source: 'user' })
  expect(sessionSets(w)).toBeGreaterThan(before)
  expect(JSON.stringify(w.stored['session:s1'])).toMatch(/Answer in German/)
})

test('a resume after a turn end restores the state', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  await $.tool.call({ tool: 'Read', path: 'a.txt' } as never)
  await turnEnd($)
  const copy = w.stored['session:s1']
  expect(JSON.stringify(copy)).toMatch(/loaded/)
})

test('compaction writes the stored copy', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  const n = w.storeSets.filter((k) => k === 'session:s1').length
  await $.session.compact({ trigger: 'manual' })
  expect(w.storeSets.filter((k) => k === 'session:s1').length).toBeGreaterThan(n)
  expect(JSON.stringify(w.stored['session:s1'])).toMatch(/stale/)
})

test('session start keeps at most 50 stored sessions and drops copies older than 14 days', async ($, on) => {
  const { config } = parseConfig(ALWAYS, undefined)
  const stored: Record<string, unknown> = {}
  for (let i = 0; i < 60; i++) stored[`session:old${i}`] = { ...initSession(config, `old${i}`, 1, 'startup', '2.1.331'), touched: T0 - i * 1000 }
  stored['session:ancient'] = { ...initSession(config, 'ancient', 1, 'startup', '2.1.331'), touched: T0 - 15 * 86_400_000 }
  world(on, { [USER_FILE]: ALWAYS }, { stored })
  await start($)
  await settle()
  const keys = Object.keys(stored).filter((k) => k.startsWith('session:'))
  expect(keys.length).toBeLessThanOrEqual(50)
  expect(keys).not.toContain('session:ancient')
  expect(keys).toContain('session:old0')
  expect(keys).not.toContain('session:old59')
})

test('session start does not wait for the store pruning', async ($, on) => {
  let release!: () => void
  const holdKeys = new Promise<void>((r) => { release = r })
  const day = 86_400_000
  const w = world(on, { [USER_FILE]: ALWAYS }, { holdKeys, stored: { 'session:old': { id: 'old', ledger: {}, touched: T0 - 15 * day } } })
  await start($)
  expect(w.stored['session:old'], 'start came back while the key list was still pending').toBeDefined()
  release()
  await settle()
  expect(w.stored['session:old']).toBe(undefined)
})

test('a failing store at pruning is logged to debug and does not fail the session', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { failKeys: true })
  await start($)
  await settle()
  expect(w.debugLogs.some((l) => /pruning/.test(l))).toBe(true)
  expect(await table($)).toMatch(/writing-guide/)
})

test('skill-hash keys older than 14 days are pruned, newer ones kept, unstamped ones stamped', async ($, on) => {
  const day = 86_400_000
  const w = world(on, { [USER_FILE]: ALWAYS }, {
    stored: {
      'souffleur:skill-hash:old': { done: true, touched: T0 - 15 * day },
      'souffleur:skill-hash:recent': { offers: 1, touched: T0 - 2 * day },
      'souffleur:skill-hash:legacy': { done: true },
      'souffleur:declined': ['h'],
    },
  })
  await start($)
  await settle()
  expect(w.stored['souffleur:skill-hash:old']).toBe(undefined)
  expect(w.stored['souffleur:skill-hash:recent']).toMatchObject({ offers: 1 })
  expect(typeof (w.stored['souffleur:skill-hash:legacy'] as { touched?: number }).touched).toBe('number')
  expect(w.stored['souffleur:declined']).toEqual(['h'])
})

test('reading a skill-hash record refreshes its stamp once it is a day old, so a record in use is not pruned', async ($, on) => {
  const day = 86_400_000
  const key = hashKey(hashOf('writing-guide'))
  const stored: Record<string, unknown> = { [key]: { done: true, touched: T0 - 13 * day } }
  world(on, { [USER_FILE]: ENFORCE }, { stored, skillAnswer: answerWith(TEST_RULE) })
  await start($)
  await mainLoad($, 'writing-guide')
  const refreshed = (stored[key] as { touched: number; done: boolean })
  expect(refreshed.done).toBe(true)
  expect(T0 - refreshed.touched, 'stamp is fresh, so day 20 is 7 days after it, not 20').toBeLessThan(day)
})

test('a skill-hash record read within a day is not written again', async ($, on) => {
  const key = hashKey(hashOf('writing-guide'))
  const stamp = T0 - 3_600_000
  const stored: Record<string, unknown> = { [key]: { done: true, touched: stamp } }
  const w = world(on, { [USER_FILE]: ENFORCE }, { stored, skillAnswer: answerWith(TEST_RULE) })
  await start($)
  await mainLoad($, 'writing-guide')
  expect((stored[key] as { touched: number }).touched).toBe(stamp)
  expect(w.storeSets.includes(key)).toBe(false)
})

test('a stored skill-hash record carries a timestamp', async ($, on) => {
  const stored: Record<string, unknown> = {}
  world(on, { [USER_FILE]: ENFORCE }, { answers: ['No'], stored, skillAnswer: answerWith(TEST_RULE) })
  await start($)
  await mainLoad($, 'writing-guide')
  expect(typeof (stored[hashKey(hashOf('writing-guide'))] as { touched?: number }).touched).toBe('number')
})

// One careful path for every write of the user file (issue #91).
const BAK = `${USER_FILE}.bak-`

test('a failing write of the temp file leaves the user file as it was', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE }, { failWrite: /souffleur\.json\.tmp-/ })
  await start($)
  expect(await run($, 'block writing-guide')).toMatch(/could not write/)
  expect(w.files[USER_FILE]).toBe(BLOCKABLE)
  expect(w.runs.some((r) => r.argv[0] === 'mv')).toBe(false)
})

test('a failing move leaves the user file as it was and no temp file behind', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE }, { failMv: true })
  await start($)
  expect(await run($, 'block writing-guide')).toMatch(/could not write/)
  expect(w.files[USER_FILE]).toBe(BLOCKABLE)
  expect(Object.keys(w.files).filter((f) => f.includes('.tmp-'))).toEqual([])
})

test('the file is replaced by moving a parsed temp copy over it', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE })
  await start($)
  await run($, 'block writing-guide')
  expect(w.tmpWrites.length).toBe(1)
  const tmp = w.tmpWrites[0]!.path
  expect(tmp).toMatch(/souffleur\.json\.tmp-\d+-[a-z0-9]+$/)
  expect(w.runs.filter((r) => r.argv[0] === 'mv').map((r) => r.argv)).toEqual([['mv', '-f', tmp, USER_FILE]])
  expect(w.files[tmp]).toBe(undefined)
  expect(JSON.parse(w.files[USER_FILE]!).projects['/work/proj'].block).toEqual(['writing-guide'])
})

test('a second writer between read and write: both entries survive', async ($, on) => {
  let other = false
  const w = world(on, { [USER_FILE]: ENFORCE }, {
    answers: 'reject',
    onWrite: (path) => {
      if (other || !path.includes('.tmp-')) return
      other = true
      w.edit(USER_FILE, JSON.stringify({ mode: 'enforce', skills: {}, needs: {}, notes: [{ id: 'other-writer', text: 'Written by another session.' }] }))
    },
  })
  await start($)
  const id = idOf(await propose($, note('Reply in German.')))
  expect(await run($, `accept ${id}`)).toMatch(/added note/)
  const notes = JSON.parse(w.files[USER_FILE]!).notes as { id: string; text: string }[]
  expect(notes.map((n) => n.text).sort()).toEqual(['Reply in German.', 'Written by another session.'])
})

test('backups: one per process, newest three kept, other suffixes untouched', async ($, on) => {
  const old = Object.fromEntries([1, 2, 3, 4, 5].map((n) => [`${BAK}${1_700_000_000_000 + n}`, `old ${n}`]))
  const keep = Object.fromEntries(['projects-20260101', '20261128', 'notin-1', 'update-1', 'chisle-1', 'souffleur-1'].map((s) => [`${BAK}${s}`, s]))
  const w = world(on, { [USER_FILE]: BLOCKABLE, ...old, ...keep })
  await start($)
  await run($, 'block writing-guide')
  await run($, 'unblock writing-guide')
  const digits = Object.keys(w.files).filter((f) => /souffleur\.json\.bak-\d{13}$/.test(f))
  expect(digits.length).toBe(3)
  expect(digits).toContain(`${BAK}${1_700_000_000_005}`)
  expect(digits).toContain(`${BAK}${1_700_000_000_004}`)
  expect(digits).not.toContain(`${BAK}${1_700_000_000_003}`)
  for (const k of Object.keys(keep)) expect(w.files[k]).toBeDefined()
  const fresh = digits.find((f) => Number(f.slice(BAK.length)) > 1_700_000_000_005)!
  expect(w.files[fresh]).toBe(BLOCKABLE)
})

test('a hand edit of the user file takes effect at the next prompt', async ($, on) => {
  const w = world(on, { [USER_FILE]: UI }, { classify: 'match' })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  const write = { tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never
  expect((await $.tool.call(write)).deny).toMatch(/ui-checklist/)
  w.edit(USER_FILE, UI.replace('enforce', 'observe'))
  await $.prompt.submit({ text: 'build me a login screen' })
  expect((await $.tool.call(write)).deny).toBe(undefined)
})

test('two writes use different temp files, and a failed one removes only its own', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE })
  await start($)
  await run($, 'block writing-guide')
  await run($, 'unblock writing-guide')
  expect(w.tmpWrites.length).toBe(2)
  expect(w.tmpWrites[0]!.path).not.toBe(w.tmpWrites[1]!.path)
})

test('a failed move removes its own temp file and leaves a foreign one', async ($, on) => {
  const other = `${USER_FILE}.tmp-1-foreign`
  const v = world(on, { [USER_FILE]: BLOCKABLE, [other]: '{}' }, { failMv: true })
  await start($)
  await run($, 'block writing-guide')
  expect(v.files[other]).toBe('{}')
  expect(Object.keys(v.files).filter((f) => f.includes('.tmp-'))).toEqual([other])
})

test('a symlinked user file is written through, the link stays', async ($, on) => {
  const real = '/dotfiles/souffleur.json'
  const w = world(on, { [USER_FILE]: BLOCKABLE, [real]: BLOCKABLE }, { linkTo: { [USER_FILE]: real } })
  await start($)
  await run($, 'block writing-guide')
  expect(w.runs.filter((r) => r.argv[0] === 'mv').map((r) => r.argv[3])).toEqual([real])
  expect(JSON.parse(w.files[real]!).projects['/work/proj'].block).toEqual(['writing-guide'])
  expect(w.files[USER_FILE]).toBe(BLOCKABLE)
})

// ---- update lock and ownership ----

const LOCK_DIR = '/data/souffleur/update.lock'
const OWNER = `${LOCK_DIR}/owner`
const heldBy = (at: number, token = 'other') => ({ [OWNER]: JSON.stringify({ at, token }) })

test('/souffleur update: a lock held by another session skips the install and runs no git', async ($, on) => {
  const w = world(on, { ...SETUP, ...heldBy(T0 - 30_000) }, { stored: QUIET, run: gitRun() })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe('Souffleur: another session is installing an update; try again in a minute.')
  expect(ran(w, 'fetch').length).toBe(0)
  expect(ran(w, 'checkout').length).toBe(0)
  expect(ran(w, 'status').length).toBe(0)
  expect(JSON.parse(w.files[OWNER]!).token).toBe('other')
})

test('/souffleur update: a lost race (mkdir fails, a fresh owner is there) runs no git', async ($, on) => {
  const w = world(on, { ...SETUP, ...heldBy(T0) }, { stored: QUIET, run: gitRun(), holdLock: true })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toMatch(/another session is installing/)
  expect(ran(w, 'fetch').length).toBe(0)
})

test('/souffleur update: a lock that cannot be made and is not there is reported, not called busy, and runs no git', async ($, on) => {
  const w = world(on, { ...SETUP }, { stored: QUIET, run: gitRun(), holdLock: true })
  own(w)
  await start($)
  const text = await runUser($, 'update')
  expect(text).toMatch(/^Souffleur: could not install /)
  expect(text).toContain('could not create the update lock')
  expect(ran(w, 'fetch').length).toBe(0)
})

test('update auto: a lock that cannot be made logs the reason to debug and runs no git', async ($, on) => {
  const w = world(on, { ...AUTO_FILE }, { stored: STORED_NEWER, run: gitRun(), holdLock: true })
  own(w)
  await start($)
  await settleUpdate(w)
  expect(w.debugLogs.some((l) => l.includes('could not create the update lock'))).toBe(true)
  expect(ran(w, 'fetch').length).toBe(0)
})

test('/souffleur update: a stale lock whose takeover another session holds runs no git and stays', async ($, on) => {
  const w = world(on, { ...SETUP, ...heldBy(T0 - 180_000), [`${LOCK_DIR}.takeover/x`]: '' }, { stored: QUIET, run: gitRun(), dirMtime: { [`${LOCK_DIR}.takeover`]: T0 } })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toMatch(/another session is installing/)
  expect(ran(w, 'fetch').length).toBe(0)
  expect(JSON.parse(w.files[OWNER]!).token).toBe('other')
  expect(w.files[`${LOCK_DIR}.takeover/x`]).toBe('')
})

test('/souffleur update: an old takeover folder is removed, without a retry this time', async ($, on) => {
  const w = world(on, { ...SETUP, ...heldBy(T0 - 180_000), [`${LOCK_DIR}.takeover/x`]: '' }, { stored: QUIET, run: gitRun(), dirMtime: { [`${LOCK_DIR}.takeover`]: T0 - 180_000 } })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toMatch(/another session is installing/)
  expect(ran(w, 'fetch').length).toBe(0)
  expect(w.files[`${LOCK_DIR}.takeover/x`]).toBeUndefined()
})

test('update auto: a stale takeover removes its takeover folder after the install', async ($, on) => {
  const w = world(on, { ...AUTO_FILE, ...heldBy(T0 - 180_000) }, { stored: STORED_NEWER, run: gitRun() })
  own(w)
  await start($)
  await settleUpdate(w)
  expect(ran(w, 'checkout').length).toBe(1)
  expect(w.runs.some((r) => r.argv[0] === 'mkdir' && r.argv[1] === `${LOCK_DIR}.takeover`)).toBe(true)
  expect(w.runs.some((r) => r.argv[0] === 'rm' && r.argv[2] === `${LOCK_DIR}.takeover`)).toBe(true)
})

test('/souffleur update: a lock with no owner and no known age is fresh: busy, no git', async ($, on) => {
  const w = world(on, { ...SETUP, [`${LOCK_DIR}/junk`]: 'x' }, { stored: QUIET, run: gitRun() })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toMatch(/another session is installing/)
  expect(ran(w, 'fetch').length).toBe(0)
  expect(w.files[`${LOCK_DIR}/junk`]).toBe('x')
})

test('/souffleur update: a lock with no owner and an old folder time is stale and taken over', async ($, on) => {
  const w = world(on, { ...SETUP, [`${LOCK_DIR}/junk`]: 'x' }, { stored: QUIET, run: gitRun(), dirMtime: { [LOCK_DIR]: T0 - 180_000 } })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toMatch(/updated to/)
  expect(w.files[OWNER]).toBeUndefined()
})

test('update auto: a lock held by another session skips the install, says nothing and logs to debug', async ($, on) => {
  const w = world(on, { ...AUTO_FILE, ...heldBy(T0 - 30_000) }, { stored: STORED_NEWER, run: gitRun() })
  own(w)
  await start($)
  await settleUpdate(w)
  expect(ran(w, 'checkout').length).toBe(0)
  expect(ran(w, 'fetch').length).toBe(0)
  expect(w.logs.some((l) => l.includes('updated to'))).toBe(false)
  expect(w.debugLogs.some((l) => l.includes('install lock'))).toBe(true)
})

for (const [name, at] of [['an old', T0 - 180_000], ['a future-dated', T0 + 3_600_000]] as const) {
  test(`update auto: ${name} lock is stale, taken over and released after the install`, async ($, on) => {
    const w = world(on, { ...AUTO_FILE, ...heldBy(at, 'old') }, { stored: STORED_NEWER, run: gitRun() })
    own(w)
    await start($)
    await settleUpdate(w)
    expect(ran(w, 'checkout').length).toBe(1)
    expect(w.files[OWNER]).toBeUndefined()
  })
}

test('/souffleur update: the lock is released after a failed verify', async ($, on) => {
  const w = world(on, { ...AUTO_FILE }, { stored: QUIET, run: gitRun({ 'verify-tag': { exitCode: 1 } }) })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toMatch(/not signed by your updateSigner key; not installed/)
  expect(w.writes.some((x) => x.path === OWNER)).toBe(true)
  expect(w.files[OWNER]).toBeUndefined()
})

test('/souffleur update: the lock is released after a git failure', async ($, on) => {
  const w = world(on, { ...SETUP }, { stored: QUIET, run: gitRun({ fetch: { exitCode: 1 } }) })
  own(w)
  await start($)
  await runUser($, 'update')
  expect(w.writes.some((x) => x.path === OWNER)).toBe(true)
  expect(w.files[OWNER]).toBeUndefined()
})

test('/souffleur update: a lock another session took over during the install is not removed', async ($, on) => {
  let w!: World
  const base = gitRun()
  w = world(on, { ...SETUP }, { stored: QUIET, run: (argv, init) => { if (argv.includes('checkout')) w.edit(OWNER, JSON.stringify({ at: T0, token: 'taken-over' })); return base(argv, init) } })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toMatch(/updated to/)
  expect(JSON.parse(w.files[OWNER]!).token).toBe('taken-over')
})

const OWNED = `${HOME}/.claude/plugins/installed_plugins.json`
const MARKET_ANSWER = 'Souffleur: installed through the marketplace; run /plugin update.'

/** The engine picks the plugin root, so a test learns it from the first git call, then arranges the files. */
const learnRoot = async ($: any, w: World) => {
  await start($)
  await runUser($, 'update')
  return rootOf(w)
}

test('update: a root listed as an installPath is market and gets the marketplace line', async ($, on) => {
  const w = world(on, { ...SETUP }, { stored: QUIET, run: gitRun() })
  own(w)
  const root = await learnRoot($, w)
  expect(ran(w, 'checkout').length).toBe(1)
  w.edit(OWNED, JSON.stringify({ version: 2, plugins: { 'skill-souffleur@market': [{ scope: 'user', installPath: root }] } }))
  expect(await runUser($, 'update')).toBe(MARKET_ANSWER)
  expect(ran(w, 'checkout').length).toBe(1)
})

test('update: a root under the plugins folder is market even when git calls it a top level', async ($, on) => {
  const links: Record<string, string> = {}
  const w = world(on, { ...SETUP }, { stored: QUIET, run: gitRun(), linkTo: links })
  own(w)
  const root = await learnRoot($, w)
  const checkouts = ran(w, 'checkout').length
  w.edit(root, '')
  links[root] = `${HOME}/.claude/plugins/marketplaces/m/plugin`
  expect(await runUser($, 'update')).toBe(MARKET_ANSWER)
  expect(ran(w, 'checkout').length).toBe(checkouts)
})

test('update auto: with update auto and a root listed in installed_plugins.json nothing is fetched or checked out', async ($, on) => {
  const w = world(on, { ...AUTO_FILE }, { stored: { updateCheck: { at: T0, latest: NEWER } }, run: gitRun() })
  own(w)
  const root = await learnRoot($, w)
  const before = { fetch: ran(w, 'fetch').length, checkout: ran(w, 'checkout').length }
  w.edit(OWNED, JSON.stringify({ version: 2, plugins: { 'skill-souffleur@market': [{ scope: 'user', installPath: root }] } }))
  w.setId(`upd-${++nextId}`)
  await start($)
  await settleUpdate(w, 2)
  expect(ran(w, 'fetch').length).toBe(before.fetch)
  expect(ran(w, 'checkout').length).toBe(before.checkout)
})

test('update: a symlinked config dir is compared by real path', async ($, on) => {
  const links: Record<string, string> = {}
  const w = world(on, { ...SETUP }, { stored: QUIET, run: gitRun(), linkTo: links })
  own(w)
  const root = await learnRoot($, w)
  const checkouts = ran(w, 'checkout').length
  w.edit(`${HOME}/.claude/plugins`, '')
  links[`${HOME}/.claude/plugins`] = '/real/cfg/plugins'
  w.edit(root, '')
  links[root] = '/real/cfg/plugins/marketplaces/m/plugin'
  expect(await runUser($, 'update')).toBe(MARKET_ANSWER)
  expect(ran(w, 'checkout').length).toBe(checkouts)
})

test('update: an installPath that is a symlink to the root counts as listing the root', async ($, on) => {
  const links: Record<string, string> = {}
  const w = world(on, { ...SETUP }, { stored: QUIET, run: gitRun(), linkTo: links })
  own(w)
  const root = await learnRoot($, w)
  w.edit(root, '')
  links[root] = '/real/checkout'
  w.edit('/alias/checkout', '')
  links['/alias/checkout'] = '/real/checkout'
  w.edit(OWNED, JSON.stringify({ version: 2, plugins: { 'x@m': [{ installPath: '/alias/checkout' }] } }))
  expect(await runUser($, 'update')).toBe(MARKET_ANSWER)
})

test('update: an unknown home folder counts as owned: market, no install', async ($, on) => {
  const w = world(on, { ...SETUP }, { stored: QUIET, run: gitRun(), noHome: true })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe(MARKET_ANSWER)
  expect(ran(w, 'fetch').length).toBe(0)
  expect(ran(w, 'checkout').length).toBe(0)
})

for (const [name, text] of [['missing', undefined], ['broken', '{not json'], ['without plugins', '{}'], ['with other roots', JSON.stringify({ plugins: { 'x@m': [{ installPath: '/elsewhere' }, null] } })]] as const) {
  test(`update: a ${name} installed_plugins.json leaves a real folder install as folder`, async ($, on) => {
    const w = world(on, text === undefined ? SETUP : { ...SETUP, [OWNED]: text }, { stored: { updateCheck: { at: T0, latest: NEWER } }, run: gitRun() })
    own(w)
    await start($)
    await settleUpdate(w)
    expect(w.logs).toContain(`Souffleur ${NEWER_V} is out (you run ${PLUGIN_VERSION}). /souffleur update installs it.`)
    expect(w.stored.installKind).toBe('folder')
  })
}

// CLAUDE_CONFIG_DIR and Windows homes (#97)
const CC = '/cc'
const CC_USER = `${CC}/souffleur.json`
const CC_PLUGINS = `${CC}/plugins/installed_plugins.json`

test('config dir: init writes and scans under CLAUDE_CONFIG_DIR, not ~/.claude', async ($, on) => {
  const hookSettings = JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/writing-guide-reload.sh' }] }] } })
  const w = world(on, { [CC_USER]: ALWAYS, [`${CC}/settings.json`]: hookSettings, [SETTINGS_PATH]: '{not json' }, { skills: SKILLS, proposals: PICKS, answers: ['When the task needs it', 'When the task needs it'], env: { CLAUDE_CONFIG_DIR: `${CC}/` } })
  await start($)
  const text = await run($, 'init')
  expect(w.writes.some((x) => x.path === CC_USER)).toBe(true)
  expect(w.writes.some((x) => x.path === USER_FILE)).toBe(false)
  expect(text).toMatch(/hook/)
  expect(text).not.toMatch(/not valid JSON/)
})

test('config dir: migrate reads CLAUDE_CONFIG_DIR/settings.json', async ($, on) => {
  const settings = JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/rules-preload.sh' }] }] } })
  const w = world(on, { [CC_USER]: ALWAYS, [`${CC}/settings.json`]: settings }, { skills: SKILLS, answers: ['Keep'], env: { CLAUDE_CONFIG_DIR: CC } })
  await start($)
  const text = await run($, 'migrate')
  expect(w.asked[0]).toMatch(/does not watch|cannot tell which skill/)
  expect(text).toMatch(/Kept/)
})

test('config dir: the legacy ~/.claude/souffleur.json is used and named once per session', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: SKILLS, env: { CLAUDE_CONFIG_DIR: CC } })
  await start($)
  const line = `Config: using ~/.claude/souffleur.json; CLAUDE_CONFIG_DIR is ${CC}. Move the file there to follow it.`
  const first = await run($, '')
  expect(first).toContain(line)
  expect(first).not.toMatch(/is not set up/)
  expect(await run($, '')).not.toContain(line)
  w.setId(`legacy-${++nextId}`)
  await start($)
  expect(await run($, '')).toContain(line)
})

test('config dir: the legacy file is written in place, and nothing is copied into CLAUDE_CONFIG_DIR', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: SKILLS, env: { CLAUDE_CONFIG_DIR: CC } })
  await start($)
  await run($, 'block writing-guide')
  expect(w.writes.some((x) => x.path === USER_FILE)).toBe(true)
  expect(w.writes.some((x) => x.path.startsWith(`${CC}/`))).toBe(false)
})

test('config dir: a file under CLAUDE_CONFIG_DIR wins over the legacy one and no line is shown', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS, [CC_USER]: ALWAYS }, { skills: SKILLS, env: { CLAUDE_CONFIG_DIR: CC } })
  await start($)
  expect(await run($, '')).not.toMatch(/Config: using/)
})

test('config dir: without CLAUDE_CONFIG_DIR no legacy line is shown', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS }, { skills: SKILLS })
  await start($)
  expect(await run($, '')).not.toMatch(/Config: using/)
})

test('windows home: USERPROFILE stands in for a missing HOME and paths show with ~', async ($, on) => {
  const home = 'C:\\Users\\me'
  const w = world(on, { [`${home}/.claude/souffleur.json`]: ALWAYS }, { skills: SKILLS, noHome: true, env: { USERPROFILE: home } })
  await start($)
  const text = await run($, 'block writing-guide')
  // The test engine resolves a drive path against the working folder, so the file reads as missing; the line shows the folder was found and written with `~`.
  expect(text).toBe('Souffleur: there is no ~/.claude/souffleur.json yet, so there is no standard to block in. Run /souffleur init.')
  expect(w.writes.length).toBe(0)
})

test('windows home: a trailing backslash on the home folder and mixed separators are scrubbed', async ($, on) => {
  const home = 'C:\\Users\\me'
  const w = world(on, { [`${home}/.claude/souffleur.json`]: '{not json' }, { skills: SKILLS, noHome: true, env: { USERPROFILE: `${home}\\` } })
  await start($)
  const text = await run($, 'block writing-guide')
  expect(text).not.toContain('Users')
  expect(w.writes.length).toBe(0)
})

test('update: ownership uses <userDir>/plugins under CLAUDE_CONFIG_DIR', async ($, on) => {
  const w = world(on, { [CC_USER]: ALWAYS }, { stored: QUIET, run: gitRun(), env: { CLAUDE_CONFIG_DIR: CC } })
  own(w)
  const root = await learnRoot($, w)
  const checkouts = ran(w, 'checkout').length
  w.edit(CC_PLUGINS, JSON.stringify({ version: 2, plugins: { 'skill-souffleur@market': [{ scope: 'user', installPath: root }] } }))
  expect(await runUser($, 'update')).toBe(MARKET_ANSWER)
  expect(ran(w, 'checkout').length).toBe(checkouts)
})

test('update: a copy listed under ~/.claude/plugins stays owned when CLAUDE_CONFIG_DIR points elsewhere', async ($, on) => {
  const w = world(on, { [CC_USER]: ALWAYS }, { stored: QUIET, run: gitRun(), env: { CLAUDE_CONFIG_DIR: CC } })
  own(w)
  const root = await learnRoot($, w)
  const checkouts = ran(w, 'checkout').length
  w.edit(OWNED, JSON.stringify({ version: 2, plugins: { 'skill-souffleur@market': [{ scope: 'user', installPath: root }] } }))
  expect(await runUser($, 'update')).toBe(MARKET_ANSWER)
  expect(ran(w, 'checkout').length).toBe(checkouts)
})

test('update: a root under ~/.claude/plugins stays owned when CLAUDE_CONFIG_DIR points elsewhere', async ($, on) => {
  const links: Record<string, string> = {}
  const w = world(on, { [CC_USER]: ALWAYS }, { stored: QUIET, run: gitRun(), env: { CLAUDE_CONFIG_DIR: CC }, linkTo: links })
  own(w)
  const root = await learnRoot($, w)
  const checkouts = ran(w, 'checkout').length
  w.edit(root, '')
  links[root] = `${HOME}/.claude/plugins/marketplaces/m/plugin`
  expect(await runUser($, 'update')).toBe(MARKET_ANSWER)
  expect(ran(w, 'checkout').length).toBe(checkouts)
})

test('update: a drive-letter CLAUDE_CONFIG_DIR counts as owned (no install)', async ($, on) => {
  const w = world(on, { ...SETUP }, { stored: QUIET, run: gitRun(), env: { CLAUDE_CONFIG_DIR: 'C:/Users/x/.claude' } })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe(MARKET_ANSWER)
  expect(ran(w, 'checkout').length).toBe(0)
})

for (const bad of ['~/cc', 'cc', '.', '', '   ', '/', '/.', '/x/..']) {
  test(`config dir: CLAUDE_CONFIG_DIR=${JSON.stringify(bad)} is not absolute, so ~/.claude is used`, async ($, on) => {
    const w = world(on, { [USER_FILE]: ALWAYS }, { skills: SKILLS, env: { CLAUDE_CONFIG_DIR: bad } })
    await start($)
    const status = await run($, '')
    expect(status).not.toMatch(/Config: using|is not set up/)
    await run($, 'block writing-guide')
    expect(w.writes.some((x) => x.path === USER_FILE)).toBe(true)
    expect(w.writes.every((x) => x.path.startsWith(`${HOME}/.claude/`))).toBe(true)
  })
}

test('config dir: a root or relative CLAUDE_CONFIG_DIR does not widen the CLAUDE.md import root', async ($, on) => {
  const files = {
    [USER_FILE]: ALWAYS, [SETTINGS_PATH]: '{}', [CLAUDE_MD]: 'x',
    '/work/proj/CLAUDE.md': '@/etc/outside.md\n@inside.md',
    '/etc/outside.md': 'Always load writing-guide (absolute).',
    '/work/proj/inside.md': 'Always load writing-guide (inside).',
  }
  world(on, files, { skills: SKILLS, failRead: [CLAUDE_MD], env: { CLAUDE_CONFIG_DIR: '/' } })
  await start($)
  const text = await run($, 'migrate')
  expect(text).toMatch(/inside\.md:1/)
  expect(text).not.toMatch(/outside\.md/)
})

test('config dir: migrate reads CLAUDE.md, imports and the memory index under CLAUDE_CONFIG_DIR', async ($, on) => {
  const files = {
    [CC_USER]: ALWAYS, [`${CC}/settings.json`]: '{}',
    [`${CC}/CLAUDE.md`]: 'Always load writing-guide (user).\n@notes.md\n@/etc/other.md',
    [`${CC}/notes.md`]: 'Always load writing-guide (import).',
    [`${CC}/projects/-work-proj/memory/MEMORY.md`]: 'Always load writing-guide (memory).',
    [`${HOME}/.claude/CLAUDE.md`]: 'Always load writing-guide (old home).',
    '/work/proj/CLAUDE.md': '@' + `${CC}/extra.md\n@${CC}/data.txt`,
    [`${CC}/extra.md`]: 'Always load writing-guide (cc extra).',
    [`${CC}/data.txt`]: 'Always load writing-guide (cc txt).',
  }
  world(on, files, { skills: SKILLS, env: { CLAUDE_CONFIG_DIR: CC } })
  await start($)
  const text = await run($, 'migrate')
  expect(text).toMatch(/CLAUDE\.md:1/)
  expect(text).toMatch(/\/cc\/CLAUDE\.md/)
  expect(text).toMatch(/memory|MEMORY\.md/)
  expect(text).toMatch(/extra\.md:1/)
  expect(text).not.toMatch(/data\.txt/)
  expect(text).not.toMatch(/old home/)
})

test('config dir: a change of the file under CLAUDE_CONFIG_DIR is picked up at the next prompt', async ($, on) => {
  const w = world(on, { [CC_USER]: UI }, { classify: 'match', env: { CLAUDE_CONFIG_DIR: CC } })
  await start($)
  await $.prompt.submit({ text: 'build me a login screen' })
  const write = { tool: 'Write', file_path: '/work/proj/x.html', content: '' } as never
  expect((await $.tool.call(write)).deny).toMatch(/ui-checklist/)
  w.edit(CC_USER, UI.replace('enforce', 'observe'))
  await $.prompt.submit({ text: 'build me a login screen' })
  expect((await $.tool.call(write)).deny).toBe(undefined)
})

test('config dir: an exists check that throws keeps the configured path, not the legacy one', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: SKILLS, env: { CLAUDE_CONFIG_DIR: CC }, failExists: [CC_USER] })
  await start($)
  expect(await run($, '')).not.toContain('Config: using')
  expect(w.writes.some((x) => x.path === USER_FILE)).toBe(false)
})

// ---- gaps named in #95 ----
// Already covered elsewhere: a failing `session:<id>` write (`a failing store copy does not drop a deny`, `the store error clears after a later flush works`),
// a background agent (`a background agent loads a skill after its Agent call returned…`) and an id change inside the process (the `an id change inside the process…` tests).

test('a save by another writer between our read and our move is noticed: the change is retried on the new text and lands', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE })
  await start($)
  w.driftAfter(USER_FILE, 1)
  const text = await run($, 'block writing-guide')
  expect(text).not.toMatch(/kept changing/)
  expect(JSON.parse(w.files[USER_FILE]!).projects['/work/proj'].block).toEqual(['writing-guide'])
  expect(Object.keys(w.files).filter((f) => f.includes('.tmp-'))).toEqual([])
})

// ---- the clock copy: other processes' stamps are compared with a fresh read ----

test('/souffleur update: a lock stamped after this process last read the clock is fresh, not future-dated', async ($, on) => {
  const base = { ...SETUP, ...heldBy(T0 + 5_000) }
  const inner = gitRun()
  // The clock moves while the update looks up the releases, after the handler read it for the last time.
  const w = world(on, base, { stored: QUIET, run: async (argv, init) => {
    if (argv.includes('ls-remote')) await fakeClock.advance(5_000)
    return inner(argv, init) as never
  } })
  own(w)
  await start($)
  expect(await runUser($, 'update')).toBe('Souffleur: another session is installing an update; try again in a minute.')
  expect(ran(w, 'checkout').length).toBe(0)
  expect(JSON.parse(w.files[OWNER]!).token).toBe('other')
})

test('a host clock that throws falls back to the system time and logs once to debug', async ($, on) => {
  let broken = false
  const w = world(on, SETUP, { clockDown: () => broken, stored: { installKind: 'folder', updateCheck: { at: T0, latest: 'v0.0.1' } }, run: runWith({ exitCode: 0, stdout: LS(NEWER) }) })
  own(w)
  await start($)
  await settleUpdate(w)
  broken = true
  // An hour old in system time, weeks off by the last good reading (T0 lies ahead of the system time): only the system time says "not due".
  w.stored['updateCheck'] = { at: Date.now() - 3_600_000, latest: 'v0.0.1' }
  const before = lsRemoteCalls(w).length
  own(w)
  await start($)
  await start($)
  await settleUpdate(w, 3)
  expect(lsRemoteCalls(w).length).toBe(before)
  expect(w.debugLogs.filter((l) => l.startsWith('clock unavailable')).length).toBe(1)
})

// ---- user file: one edit at a time, one lock across sessions ----

const USER_LOCK = '/data/souffleur/user-file.lock'
const USER_LOCK_OWNER = `${USER_LOCK}/owner`
const lockedBy = (at: number, token = 'other') => ({ [USER_LOCK_OWNER]: JSON.stringify({ at, token }) })
const blockedIn = (w: World) => (JSON.parse(w.files[USER_FILE]!).projects['/work/proj']?.block ?? []) as string[]

test('two writers of the user file at once: both changes are in the file and no temp file stays', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE })
  await start($)
  const [a, b] = await Promise.all([run($, 'block writing-guide'), run($, 'block terse:terse-mode')])
  expect(a).not.toMatch(/kept changing|could not/)
  expect(b).not.toMatch(/kept changing|could not/)
  expect([...blockedIn(w)].sort()).toEqual(['terse:terse-mode', 'writing-guide'])
  expect(Object.keys(w.files).filter((f) => f.includes('.tmp-'))).toEqual([])
  expect(Object.keys(w.files).filter((f) => f.startsWith(USER_LOCK))).toEqual([])
})

test('a user file lock held by another session delays the edit; it writes once the lock is gone', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE, ...lockedBy(T0 - 1000) })
  await start($)
  const pending = run($, 'block writing-guide')
  await w.clock.advance(500)
  expect(userWrites(w).length).toBe(0)
  delete w.files[USER_LOCK_OWNER]
  const dirs = w.runs.filter((r) => r.argv[0] === 'mkdir' && r.argv[1] === USER_LOCK).length
  expect(dirs).toBeGreaterThan(1)
  await w.clock.advance(200)
  expect(await pending).toMatch(/writing-guide blocked/)
  expect(blockedIn(w)).toEqual(['writing-guide'])
})

test('a user file lock held past 3 seconds: writing failed, nothing written, the lock stays', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE, ...lockedBy(T0 - 1000) })
  await start($)
  const pending = run($, 'block writing-guide')
  await w.clock.advance(3500)
  expect(await pending).toMatch(/could not write .*souffleur\.json.*holds the lock.*nothing was written/)
  expect(w.files[USER_FILE]).toBe(BLOCKABLE)
  expect(userWrites(w).length).toBe(0)
  expect(JSON.parse(w.files[USER_LOCK_OWNER]!).token).toBe('other')
})

test('a stale user file lock (older than 30 seconds) is taken over and the edit goes through', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE, ...lockedBy(T0 - 31_000) })
  await start($)
  expect(await run($, 'block writing-guide')).toMatch(/writing-guide blocked/)
  expect(blockedIn(w)).toEqual(['writing-guide'])
  expect(w.files[USER_LOCK_OWNER]).toBeUndefined()
})

test('a user file lock of 20 seconds is still held', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE, ...lockedBy(T0 - 20_000) })
  await start($)
  const pending = run($, 'block writing-guide')
  await w.clock.advance(3500)
  expect(await pending).toMatch(/could not write/)
  expect(userWrites(w).length).toBe(0)
})

test('a host where mkdir does not work still writes the user file, with one debug line', async ($, on) => {
  const w = world(on, { [USER_FILE]: BLOCKABLE }, { noMkdir: true })
  await start($)
  expect(await run($, 'block writing-guide')).toMatch(/writing-guide blocked/)
  expect(await run($, 'block terse:terse-mode')).toMatch(/terse:terse-mode blocked/)
  expect([...blockedIn(w)].sort()).toEqual(['terse:terse-mode', 'writing-guide'])
  expect(w.debugLogs.filter((l) => l.includes('user file lock')).length).toBeGreaterThan(0)
})

test('an edit that fails inside the lock still releases it, and the next edit writes', async ($, on) => {
  const opts: Opts = { failWrite: /\.tmp-/ }
  const w = world(on, { [USER_FILE]: BLOCKABLE }, opts)
  await start($)
  expect(await run($, 'block writing-guide')).toMatch(/could not write/)
  expect(Object.keys(w.files).filter((f) => f.startsWith(USER_LOCK))).toEqual([])
  delete opts.failWrite
  expect(await run($, 'block terse:terse-mode')).toMatch(/terse:terse-mode blocked/)
  expect(blockedIn(w)).toEqual(['terse:terse-mode'])
})

test('a mkdir that fails while the lock is gone again is retried: the edit still runs under the lock', async ($, on) => {
  let underLock = false
  let w!: World
  w = world(on, { [USER_FILE]: BLOCKABLE }, { mkdirFailsOnce: true, onWrite: (p) => { if (/\.tmp-/.test(p)) underLock = USER_LOCK_OWNER in w.files } })
  await start($)
  expect(await run($, 'block writing-guide')).toMatch(/writing-guide blocked/)
  expect(underLock).toBe(true)
  expect(w.debugLogs.filter((l) => l.includes('user file lock'))).toEqual([])
})

test('a lock that cannot be made on a later attempt counts as held: no unlocked edit', async ($, on) => {
  const opts: Opts = {}
  const w = world(on, { [USER_FILE]: BLOCKABLE, ...lockedBy(T0 - 1000) }, opts)
  await start($)
  const pending = run($, 'block writing-guide')
  await w.clock.advance(300)
  delete w.files[USER_LOCK_OWNER]
  opts.noMkdir = true
  await w.clock.advance(3500)
  expect(await pending).toMatch(/holds the lock/)
  expect(userWrites(w).length).toBe(0)
  expect(w.debugLogs.filter((l) => l.includes('user file lock'))).toEqual([])
})
