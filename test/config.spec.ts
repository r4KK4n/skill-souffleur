import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, matches } from '../src/core/config.ts'

const fullExample = {
  skills: {
    'terse:terse-mode': { always: true, startup: 'injected' },
    'writing-guide': { need: 'prose' },
    'writing-check': { need: 'prose' },
    'ui-checklist': {
      need: 'ui',
      gate: { tools: ['Write', 'Edit', 'Artifact'], paths: ['**/*.html', '**/*.tsx'] },
      duty: {
        after: { tools: ['Write'], paths: ['**/*.html'] },
        evidence: { tool: 'Bash', command: 'ui-checklist.*detect' },
      },
    },
  },
  needs: {
    prose: 'Writing text people read: docs, specs, plans, issues, UI copy.',
    ui: 'Designing or building something a user sees: screens, prototypes, mockups, components.',
  },
}

const json = (value: unknown): string => JSON.stringify(value)

test('parses a full example config', () => {
  const { config, errors } = parseConfig(json(fullExample), undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(Object.keys(config.skills), ['terse:terse-mode', 'writing-guide', 'writing-check', 'ui-checklist'])
  assert.deepEqual(Object.keys(config.needs), ['prose', 'ui'])
  assert.deepEqual(config.skills['terse:terse-mode'], { always: true, startup: 'injected' })
  assert.deepEqual(config.skills['ui-checklist'], fullExample.skills['ui-checklist'])
})

test('project entry replaces user entry for the same skill', () => {
  const project = { skills: { 'writing-guide': { always: true } } }
  const { config, errors } = parseConfig(json(fullExample), json(project))
  assert.deepEqual(errors, [])
  assert.deepEqual(config.skills['writing-guide'], { always: true })
  assert.deepEqual(config.skills['writing-check'], { need: 'prose' })
})

test('invalid JSON in project file keeps user config and reports "project"', () => {
  const { config, errors } = parseConfig(json(fullExample), '{ not json')
  assert.equal(Object.keys(config.skills).length, 4)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /project/)
})

test('unknown need on a skill is an error and drops the skill', () => {
  const user = { skills: { bigtest: { need: 'nope' }, 'writing-guide': { always: true } }, needs: {} }
  const { config, errors } = parseConfig(json(user), undefined)
  assert.deepEqual(Object.keys(config.skills), ['writing-guide'])
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /bigtest/)
  assert.match(errors[0]!, /nope/)
})

test('invalid evidence regex is an error', () => {
  const user = {
    skills: {
      bigtest: { duty: { after: { tools: ['Write'] }, evidence: { tool: 'Bash', command: '([' } } },
    },
  }
  const { config, errors } = parseConfig(json(user), undefined)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /bigtest/)
  assert.equal(config.skills.bigtest, undefined)
})

test('missing files give an empty config without errors', () => {
  const { config, errors } = parseConfig(undefined, undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(config, { mode: 'observe', skills: {}, needs: {} })
})

test('mode defaults to observe', () => {
  assert.equal(parseConfig(json(fullExample), undefined).config.mode, 'observe')
})

test('user file can set enforce', () => {
  const { config, errors } = parseConfig(json({ ...fullExample, mode: 'enforce' }), undefined)
  assert.deepEqual(errors, [])
  assert.equal(config.mode, 'enforce')
})

test('project file cannot set enforce: stays observe and reports it', () => {
  const { config, errors } = parseConfig(json(fullExample), json({ mode: 'enforce' }))
  assert.equal(config.mode, 'observe')
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /project/)
  assert.match(errors[0]!, /enforce/)
})

test('matches: "**/*.html" matches "a/b/c.html" and not "a/b/c.tsx"', () => {
  const m = { tools: ['Write'], paths: ['**/*.html'] }
  assert.equal(matches(m, 'Write', 'a/b/c.html'), true)
  assert.equal(matches(m, 'Write', 'a/b/c.tsx'), false)
})

test('matches: no paths matches any path', () => {
  const m = { tools: ['Bash'] }
  assert.equal(matches(m, 'Bash', undefined), true)
  assert.equal(matches(m, 'Bash', '/any/where.txt'), true)
  assert.equal(matches(m, 'Write', '/any/where.txt'), false)
})

test('matches: "**/*.html" matches the absolute path "/srv/p/x.html"', () => {
  assert.equal(matches({ tools: ['Write'], paths: ['**/*.html'] }, 'Write', '/srv/p/x.html'), true)
})
