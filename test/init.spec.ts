import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findHookOverlaps, findPassages, initSteps, mergeUserConfig, parseSkillProposals, removeHook } from '../src/core/init.ts'

const SKILLS = ['writing-guide', 'ui-checklist', 'terse:terse-mode']

const settings = () => ({
  model: 'opus',
  hooks: {
    SessionStart: [
      { matcher: 'compact|resume', hooks: [{ type: 'command', command: 'bash ~/.claude/hooks/writing-guide-reload.sh' }] },
      { matcher: 'startup', hooks: [{ type: 'command', command: 'notify-send started' }] },
    ],
    UserPromptSubmit: [
      { hooks: [{ type: 'command', command: '~/.claude/hooks/remind.sh ui-checklist' }, { type: 'command', command: 'date >> ~/log.txt' }] },
    ],
    PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'prettier --write .' }] }],
  },
})

test('finds a SessionStart hook that re-injects a known skill', () => {
  const found = findHookOverlaps(settings(), SKILLS)
  const start = found.find((o) => o.event === 'SessionStart')
  assert.ok(start)
  assert.equal(start.command, 'bash ~/.claude/hooks/writing-guide-reload.sh')
  assert.equal(start.matcher, 'compact|resume')
  assert.deepEqual(start.index, [0, 0])
  assert.match(start.why, /writing-guide/)
  const prompt = found.find((o) => o.event === 'UserPromptSubmit')
  assert.deepEqual(prompt?.index, [0, 0])
})

test('finds a preload script by its name pattern even without a known skill name', () => {
  const s = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '~/.claude/hooks/skill-preload.sh' }] }] } }
  const found = findHookOverlaps(s, [])
  assert.equal(found.length, 1)
  assert.match(found[0]!.why, /preload/)
})

test('ignores unrelated hooks', () => {
  const s = {
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'notify-send started' }] }],
      PostToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'prettier --write .' }] }],
      Stop: [{ hooks: [{ type: 'command', command: 'echo reload the page' }] }],
    },
  }
  assert.deepEqual(findHookOverlaps(s, SKILLS), [])
  assert.deepEqual(findHookOverlaps(undefined, SKILLS), [])
  assert.deepEqual(findHookOverlaps({ hooks: 'nope' }, SKILLS), [])
})

test('a short skill name inside another word is not an overlap', () => {
  assert.deepEqual(findHookOverlaps({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'git init' }] }] } }, ['init']), [])
})

test('removeHook removes only that entry and keeps the rest byte-equal in content', () => {
  const before = settings()
  const frozen = structuredClone(before)
  const target = findHookOverlaps(before, SKILLS).find((o) => o.event === 'UserPromptSubmit')!
  const after = removeHook(before, target) as ReturnType<typeof settings>
  assert.deepEqual(before, frozen, 'the input is not changed')
  assert.deepEqual(after.hooks.UserPromptSubmit, [{ hooks: [{ type: 'command', command: 'date >> ~/log.txt' }] }])
  assert.deepEqual(after.hooks.SessionStart, frozen.hooks.SessionStart)
  assert.deepEqual(after.hooks.PostToolUse, frozen.hooks.PostToolUse)
  assert.equal(after.model, 'opus')
})

test('removeHook drops an emptied matcher group', () => {
  const before = settings()
  const target = findHookOverlaps(before, SKILLS).find((o) => o.event === 'SessionStart')!
  const after = removeHook(before, target) as ReturnType<typeof settings>
  assert.deepEqual(after.hooks.SessionStart, [{ matcher: 'startup', hooks: [{ type: 'command', command: 'notify-send started' }] }])
})

test('removeHook drops an emptied event, and leaves settings alone when the entry changed', () => {
  const only = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'writing-guide-reload.sh' }] }] }, theme: 'dark' }
  const target = findHookOverlaps(only, SKILLS)[0]!
  assert.deepEqual(removeHook(only, target), { theme: 'dark', hooks: {} })
  const edited = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'something else' }] }] } }
  assert.deepEqual(removeHook(edited, target), edited)
})

test('parseSkillProposals drops unknown skills and garbage', () => {
  const raw = [
    'Here you go:',
    '```json',
    JSON.stringify({
      skills: [
        { name: 'writing-guide', need: 'prose', needText: 'Writing text people read.' },
        { name: 'terse:terse-mode', always: true },
        { name: 'not-installed', always: true },
        { name: 'ui-checklist' },
        { name: 'ui-checklist', need: 'bad name with spaces' },
        'junk',
        null,
      ],
    }),
    '```',
  ].join('\n')
  const got = parseSkillProposals(raw, SKILLS)
  assert.deepEqual(got, [
    { name: 'writing-guide', rule: { from: 'user', need: 'prose' }, needText: 'Writing text people read.' },
    { name: 'terse:terse-mode', rule: { from: 'user', always: true } },
  ])
  assert.deepEqual(parseSkillProposals('no json here', SKILLS), [])
  assert.deepEqual(parseSkillProposals('{ "skills": [', SKILLS), [])
  assert.deepEqual(parseSkillProposals('', SKILLS), [])
})

test('parseSkillProposals accepts a bare array and keeps at most 10', () => {
  const known = Array.from({ length: 14 }, (_, i) => `skill-number-${i}`)
  const raw = JSON.stringify(known.map((name) => ({ name, always: true })))
  assert.equal(parseSkillProposals(raw, known).length, 10)
})

test('mergeUserConfig keeps every existing key and does not overwrite an entry', () => {
  const existing = JSON.stringify({ mode: 'enforce', trustProjects: ['/work/a'], skills: { 'writing-guide': { always: true } }, needs: { prose: 'mine' } })
  const merged = mergeUserConfig(existing, [
    { name: 'writing-guide', rule: { from: 'user', need: 'prose' }, needText: 'other' },
    { name: 'ui-checklist', rule: { from: 'user', need: 'ui' }, needText: 'Building a screen.' },
  ])
  assert.ok('text' in merged)
  const out = JSON.parse(merged.text)
  assert.equal(out.mode, 'enforce')
  assert.deepEqual(out.trustProjects, ['/work/a'])
  assert.deepEqual(out.skills['writing-guide'], { always: true })
  assert.deepEqual(out.skills['ui-checklist'], { need: 'ui' })
  assert.deepEqual(out.needs, { prose: 'mine', ui: 'Building a screen.' })
  assert.deepEqual(merged.added, ['ui-checklist'])
})

test('mergeUserConfig starts a new file in observe mode and refuses invalid JSON', () => {
  const fresh = mergeUserConfig(undefined, [{ name: 'terse:terse-mode', rule: { from: 'user', always: true } }])
  assert.ok('text' in fresh)
  assert.deepEqual(JSON.parse(fresh.text), { mode: 'observe', skills: { 'terse:terse-mode': { always: true } }, needs: {} })
  const bad = mergeUserConfig('{ nope', [])
  assert.ok('error' in bad)
})

test('findPassages lists file and line of text that names a skill', () => {
  const got = findPassages([{ file: 'CLAUDE.md', text: 'one\nAlways load writing-guide first.\nthree' }], SKILLS)
  assert.deepEqual(got, [{ file: 'CLAUDE.md', line: 2, text: 'Always load writing-guide first.' }])
})

test('initSteps lists proposals, JSON and steps for the no-dialog case', () => {
  const text = initSteps({
    proposals: [{ name: 'writing-guide', rule: { from: 'user', need: 'prose' }, needText: 'Writing text people read.' }],
    hooks: findHookOverlaps(settings(), SKILLS),
    passages: [{ file: 'CLAUDE.md', line: 2, text: 'Always load writing-guide first.' }],
    configPath: '~/.claude/souffleur.json',
    settingsPath: '~/.claude/settings.json',
  })
  assert.match(text, /nothing was changed/i)
  assert.match(text, /"writing-guide"/)
  assert.match(text, /writing-guide-reload\.sh/)
  assert.match(text, /CLAUDE\.md:2/)
  assert.match(text, /Steps/)
})
