import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { decide, initSession } from '../core/decide.ts'
import { parseConfig } from '../core/config.ts'

const HOME = '/users/test'
const USER_FILE = `${HOME}/.claude/souffleur.json`
const PROJECT_FILE = '/work/proj/.claude/souffleur.json'

type World = {
  statuses: (string | undefined)[]
  setId: (id: string) => void
  seen: { prompts: { text: string; context?: readonly string[] }[] }
  writes: { path: string; text: string }[]
  asked: string[]
  hide: (path: string) => void
  files: Record<string, string>
}

type Opts = {
  classify?: string
  stored?: Record<string, unknown>
  skipCompact?: boolean
  /** Installed skill names `$.session.usage` lists. */
  skills?: string[]
  /** What the small model answers to the init prompt. */
  proposals?: string
  /** The labels the user picks, in order; 'reject' makes every dialog reject, as in a `-p` run. */
  answers?: string[] | 'reject'
  /** Paths that exist but whose read throws, as a permission error would. */
  failRead?: string[]
  /** Writes to a path that matches throw. */
  failWrite?: RegExp
  /** Runs after each successful write, with its path. */
  onWrite?: (path: string) => void
  /** Runs when a dialog opens. */
  onAsk?: () => void
}

/** Answers every call the mod makes on `$`; files maps an absolute path to its text, a missing path throws. */
const registeredCommands: unknown[] = []

function world(on: On, files: Record<string, string>, opts: Opts = {}): World {
  let id = 's1'
  const statuses: (string | undefined)[] = []
  const seen: World['seen'] = { prompts: [] }
  const writes: World['writes'] = []
  const asked: string[] = []
  const hidden = new Set<string>()
  const answers = opts.answers === 'reject' ? [] : [...(opts.answers ?? [])]
  mock.store(on, opts.stored)
  mock.clock(on)
  mock.session(on)
  on('session.id', () => ({ value: id }))
  on('session.cwd', () => ({ value: '/work/proj' }))
  on('session.repo', () => ({ value: null }))
  on('session.version', () => ({ value: { version: '2.1.332' } }))
  on('env.get', () => ({ value: HOME }))
  on('fs.exists', (_, e) => ({ value: files[e.path] !== undefined && !hidden.has(e.path) }))
  on('fs.read', (_, e) => {
    if (opts.failRead?.includes(e.path)) throw new Error('EACCES: permission denied')
    const text = files[e.path]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('model.classify', () => ({ value: opts.classify ?? 'no-match' }))
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
    writes.push({ path: e.path, text: e.text })
    files[e.path] = e.text
    opts.onWrite?.(e.path)
    return { value: undefined }
  })
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 1, breakdown: { skills: { totalSkills: 0, includedSkills: 0, tokens: 0, skillFrontmatter: (opts.skills ?? []).map((name) => ({ name, source: 'plugin', tokens: 1 })) } } },
      rateLimits: [],
      cost: {},
    },
  }) as never)
  on('model.complete', () => ({ value: { isAnswered: true, text: opts.proposals ?? '{"skills":[]}', usage: {} } }) as never)
  on('tool.call', (_, e) => {
    if (e.tool !== 'AskUserQuestion') return { result: {} }
    const question = (e as unknown as { questions: { question: string }[] }).questions[0]!.question
    asked.push(question)
    opts.onAsk?.()
    const label = answers.shift()
    if (opts.answers === 'reject' || label === undefined) throw new Error('nobody to ask')
    if (label === '__undefined__') return { result: { questions: [], answers: { [question]: undefined } } } as never
    return { result: { questions: [], answers: { [question]: label } } } as never
  })
  on('skill.prompt', (_, e) => ({ text: e.text }))
  on('session.compact', () => (opts.skipCompact ? { skip: 'vetoed' } : { messages: [{ role: 'user', text: 'summary', toolUses: [] }] }))
  on('command.run', () => ({}))
  return { statuses, setId: (next) => { id = next }, seen, writes, asked, hide: (path) => void hidden.add(path), files }
}

const COMPOSE = { model: 'm', promptModel: 'm', surfaces: ['terminal'], tools: [], outputStyle: null, traits: [] } as never
const start = ($: any) => $.session.start({ cwd: '/work/proj', surface: 'terminal', isInteractive: true })
const skillLoaded = ($: any, skill: string) => $.skill.prompt({ skill, text: 'x', len: 1, head: 'x', tail: 'x' })
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
  expect(w.statuses.at(-1)).toBe('degraded, see /souffleur')
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
    held = e.value
    return { value: { isSet: true, version: 1 } }
  })
  await start($)
  fail = true
  const r = await $.prompt.submit({ text: 'hello there' })
  expect(r.text).toBe('hello there')
  expect(w.statuses.at(-1)).toBe('degraded, see /souffleur')
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
    await $.tool.call({ tool: 'Skill', skill: 'writing-guide', agentId: 'a1' } as never)
    await skillLoaded($, 'writing-guide')
    return { result: {} }
  })
  await start($)
  await $.tool.call({ tool: 'Agent', prompt: 'skills: writing-guide', description: 'd', subagent_type: 'general-purpose' } as never)
  expect(await table($)).toMatch(/writing-guide \| absent/)
})

test('new session id after clear starts a fresh ledger', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS })
  await start($)
  await skillLoaded($, 'writing-guide')
  expect(await table($)).toMatch(/writing-guide \| loaded/)
  await $.command.run({ command: 'clear', args: '' })
  w.setId('s2')
  expect(await table($)).toMatch(/writing-guide \| absent/)
  const r = await $.prompt.submit({ text: 'fresh' })
  expect(r.context?.join('\n')).toMatch(/writing-guide/)
})

test('the system prompt section names the always-on skills and depends on config only', async ($, on) => {
  world(on, { [USER_FILE]: ALWAYS })
  on('prompt.compose', () => ({ sections: [] }))
  await start($)
  const r = await $.prompt.compose(COMPOSE)
  const section = r.sections.find((s: { id: string }) => s.id === 'souffleur')
  expect(section?.scope).toBe('session')
  expect(section?.text).toMatch(/invoke each one with the Skill tool/)
  expect(section?.text).toMatch(/Always-on skills: writing-guide\./)
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
const run = async ($: any, args: string) => (await $.command.run({ command: 'souffleur', args })).text as string
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

test('init starts its first dialog with the explanation', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['Stop'] })
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
  expect(JSON.stringify(registeredCommands)).toContain('"argumentHint":"[status | need <name> | drop <name> | pause | init | migrate]"')
})

// ---- review fixes ----

const written = (w: World, path: string) => w.writes.filter((x) => x.path === path)
const backups = (w: World) => w.writes.filter((x) => /settings\.json\.bak-souffleur-/.test(x.path))
const TWO = JSON.stringify({ skills: { 'writing-guide': { always: true }, 'ui-checklist': { always: true } } })

test('a read error on the user file stops init and writes nothing', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['Stop'], failRead: [USER_FILE] })
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
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['When the task needs it', 'Stop'] })
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
  const a = world(on, { [USER_FILE]: '{"skills":{}}', [SETTINGS_PATH]: hooksOn('SessionStart') }, { skills: ['ui-checklist'], answers: ['Stop'] })
  await start($)
  await run($, 'init')
  expect(a.asked[0]).toMatch(/recommended: From the start/)
})

test('a hook on another event does not', async ($, on) => {
  const b = world(on, { [USER_FILE]: '{"skills":{}}', [SETTINGS_PATH]: hooksOn('UserPromptSubmit') }, { skills: ['ui-checklist'], answers: ['Stop'] })
  await start($)
  await run($, 'init')
  expect(b.asked[0]).toMatch(/recommended: When the task needs it/)
})

test('a configured skill without a need shows the proposed description before the user picks', async ($, on) => {
  const w = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['Stop'], proposals: JSON.stringify({ skills: [{ name: 'writing-guide', need: 'prose', needText: 'Writing text people read.' }] }) })
  await start($)
  await run($, 'init')
  expect(w.asked[0]).toMatch(/Writing text people read\./)
})

test('without a proposal the dialog shows the fallback description', async ($, on) => {
  const v = world(on, { [USER_FILE]: ALWAYS }, { skills: ['writing-guide'], answers: ['Stop'] })
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
