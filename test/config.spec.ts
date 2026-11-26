import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseConfig, matches, matchesCommand } from '../src/core/config.ts'

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
        evidence: { tool: 'Bash', command: '*ui-checklist*detect*' },
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
  assert.deepEqual(config.skills['terse:terse-mode'], { from: 'user', always: true, startup: 'injected' })
  assert.deepEqual(config.skills['ui-checklist'], { from: 'user', ...fullExample.skills['ui-checklist'] })
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

test('missing files give an empty config without errors', () => {
  const { config, errors } = parseConfig(undefined, undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(config, { mode: 'observe', skills: {}, needs: {}, trustProjects: [], rules: [], notes: [], learn: { skills: true }, notices: true })
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
  assert.match(errors[0]!, /mode/)
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

const ms = (fn: () => void): number => {
  const t = performance.now()
  fn()
  return performance.now() - t
}

test('glob: nested ** against a long non-matching path stays fast', () => {
  const glob = '**/'.repeat(12) + 'x'
  const path = 'a/'.repeat(24) + 'y'
  let result = true
  const took = ms(() => (result = matches({ tools: ['Write'], paths: [glob] }, 'Write', path)))
  assert.equal(result, false)
  assert.ok(took < 50, `took ${took} ms`)
})

test('glob: many * against a long non-matching path stays fast', () => {
  const glob = '*a'.repeat(19) + '*b'
  const path = 'a'.repeat(60)
  let result = true
  const took = ms(() => (result = matches({ tools: ['Write'], paths: [glob] }, 'Write', path)))
  assert.equal(result, false)
  assert.ok(took < 50, `took ${took} ms`)
})

test('glob: * and ? do not cross a slash, ** does', () => {
  const m = (g: string, p: string): boolean => matches({ tools: ['W'], paths: [g] }, 'W', p, '/proj')
  assert.equal(m('src/*.ts', '/proj/src/a.ts'), true)
  assert.equal(m('src/*.ts', '/proj/src/x/a.ts'), false)
  assert.equal(m('src/**/*.ts', '/proj/src/x/y/a.ts'), true)
  assert.equal(m('src/**/*.ts', '/proj/src/a.ts'), true)
  assert.equal(m('src/a?c', '/proj/src/abc'), true)
  assert.equal(m('src/a?c', '/proj/src/a/c'), false)
  assert.equal(m('src/**', '/proj/src/x/y'), true)
})

test('glob: newlines in a path are ordinary characters', () => {
  const m = { tools: ['Write'], paths: ['**/*.html'] }
  assert.equal(matches(m, 'Write', '/p/a\nb/c\nd.html'), true)
  assert.equal(matches({ tools: ['Write'], paths: ['/p/a?b'] }, 'Write', '/p/a\nb'), true)
  assert.equal(matches(m, 'Write', '/p/a.html\nx'), false)
})

test('glob: relative globs match under the root only', () => {
  const m = { tools: ['Write'], paths: ['docs/*.md', './notes/*.md'] }
  assert.equal(matches(m, 'Write', '/proj/docs/a.md', '/proj'), true)
  assert.equal(matches(m, 'Write', '/proj/notes/a.md', '/proj/'), true)
  assert.equal(matches(m, 'Write', '/other/docs/a.md', '/proj'), false)
  assert.equal(matches(m, 'Write', '/projx/docs/a.md', '/proj'), false)
  assert.equal(matches(m, 'Write', '/proj/../other/docs/a.md', '/proj'), false)
  assert.equal(matches(m, 'Write', './docs/a.md', undefined), true)
})

test('glob: absolute and **/ globs ignore the root', () => {
  assert.equal(matches({ tools: ['Write'], paths: ['/etc/*.conf'] }, 'Write', '/etc/a.conf', '/proj'), true)
  assert.equal(matches({ tools: ['Write'], paths: ['**/*.html'] }, 'Write', '/other/a.html', '/proj'), true)
})

test('glob syntax { } [ ] ! is rejected at parse time, naming the skill', () => {
  for (const bad of ['**/*.{html,tsx}', 'a[bc]', '!x', 'a]', 'a}']) {
    const user = { skills: { bigtest: { always: true, gate: { tools: ['Write'], paths: [bad] } } } }
    const { config, errors } = parseConfig(json(user), undefined)
    assert.equal(errors.length, 1, bad)
    assert.match(errors[0]!, /bigtest/)
    assert.equal(config.skills.bigtest, undefined)
  }
})

test('empty paths and empty tools are errors', () => {
  for (const gate of [{ tools: ['Write'], paths: [] }, { tools: [] }]) {
    const { config, errors } = parseConfig(json({ skills: { bigtest: { always: true, gate } } }), undefined)
    assert.equal(errors.length, 1)
    assert.equal(config.skills.bigtest, undefined)
  }
})

test('evidence command is a glob over the command line', () => {
  assert.equal(matchesCommand('*ui-checklist*detect*', 'node /a/b/ui-checklist/detect.js x.html'), true)
  assert.equal(matchesCommand('*ui-checklist*detect*', 'ls'), false)
  assert.equal(matchesCommand('echo ?', 'echo a'), true)
  assert.equal(matchesCommand('echo *', 'echo a\nb'), true)
  const user = {
    skills: { bigtest: { need: 'n', duty: { after: { tools: ['Write'] }, evidence: { tool: 'Bash', command: '([' } } } },
    needs: { n: 'Something.' },
  }
  const { config, errors } = parseConfig(json(user), undefined)
  assert.equal(errors.length, 1)
  assert.equal(config.skills.bigtest, undefined)
  const ok = { ...user, skills: { bigtest: { need: 'n', duty: { after: { tools: ['Write'] }, evidence: { tool: 'Bash', command: '*(*' } } } } }
  assert.deepEqual(parseConfig(json(ok), undefined).errors, [])
})

test('evidence command is a glob: { } [ ] ! are rejected', () => {
  const user = {
    skills: { bigtest: { need: 'n', duty: { after: { tools: ['Write'] }, evidence: { tool: 'Bash', command: 'a{b,c}' } } } },
    needs: { n: 'Something.' },
  }
  assert.equal(parseConfig(json(user), undefined).errors.length, 1)
})

test('an invalid entry drops only that entry, not the file', () => {
  const user = {
    skills: { bad: { need: 'prose', typo: 1 }, 'writing-guide': { need: 'prose' } },
    needs: { prose: 'Writing.', 'bad name': 'x' },
  }
  const { config, errors } = parseConfig(json(user), undefined)
  assert.deepEqual(Object.keys(config.skills), ['writing-guide'])
  assert.deepEqual(Object.keys(config.needs), ['prose'])
  assert.equal(errors.length, 2)
  assert.ok(errors.every((e) => e.startsWith('user config')))
  assert.ok(errors.some((e) => e.includes('"bad"')))
})

test('unknown top-level keys are an error but the rest of the file applies', () => {
  const user = { extra: 1, skills: { 'writing-guide': { always: true } } }
  const { config, errors } = parseConfig(json(user), undefined)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /extra/)
  assert.deepEqual(Object.keys(config.skills), ['writing-guide'])
})

test('a skill with an unknown key is dropped alone, and "from" cannot come from JSON', () => {
  const user = { skills: { a: { always: true, from: 'user' }, b: { always: true } } }
  const { config, errors } = parseConfig(json(user), undefined)
  assert.deepEqual(Object.keys(config.skills), ['b'])
  assert.equal(errors.length, 1)
  const project = { skills: { c: { always: true, from: 'user' } } }
  assert.equal(parseConfig(undefined, json(project)).config.skills.c, undefined)
})

test('project file adds new skills and needs, marked from "project"', () => {
  const project = { skills: { 'ui-extra': { need: 'extra' } }, needs: { extra: 'Extra work.' } }
  const { config, errors } = parseConfig(json(fullExample), json(project))
  assert.deepEqual(errors, [])
  assert.equal(config.skills['ui-extra']!.from, 'project')
  assert.equal(config.skills['writing-guide']!.from, 'user')
  assert.equal(config.needs.extra?.what, 'Extra work.')
})

test('project skill with a user name is an error: user entry stays, project entry ignored', () => {
  const project = { skills: { 'writing-guide': { always: true } } }
  const { config, errors } = parseConfig(json(fullExample), json(project))
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /project/)
  assert.match(errors[0]!, /writing-guide/)
  assert.deepEqual(config.skills['writing-guide'], { from: 'user', need: 'prose' })
})

test('project need with a user name is an error: user text stays', () => {
  const project = { needs: { prose: 'Hijacked.' } }
  const { config, errors } = parseConfig(json(fullExample), json(project))
  assert.equal(errors.length, 1)
  assert.equal(config.needs.prose?.what, fullExample.needs.prose)
})

test('a clash with an invalid user entry still blocks the project entry', () => {
  const user = { skills: { bigtest: { always: true, typo: 1 } } }
  const project = { skills: { bigtest: { always: true } } }
  const { config, errors } = parseConfig(json(user), json(project))
  assert.equal(config.skills.bigtest, undefined)
  assert.equal(errors.length, 2)
})

test('a user skill cannot lean on a need only the project file defines', () => {
  const user = { skills: { bigtest: { need: 'extra' } } }
  const project = { needs: { extra: 'Extra work.' } }
  const { config, errors } = parseConfig(json(user), json(project))
  assert.equal(config.skills.bigtest, undefined)
  assert.equal(errors.length, 1)
})

test('mode in the project file is an error whatever its value', () => {
  for (const mode of ['observe', 'enforce', 'nonsense', 7]) {
    const { config, errors } = parseConfig(json({ mode: 'enforce' }), json({ mode }))
    assert.equal(config.mode, 'enforce')
    assert.equal(errors.length, 1)
    assert.match(errors[0]!, /project/)
  }
})

test('trustProjects: user file only, absolute paths', () => {
  const user = { trustProjects: ['/work/a', '/work/b'] }
  assert.deepEqual(parseConfig(json(user), undefined).config.trustProjects, ['/work/a', '/work/b'])
  const rel = parseConfig(json({ trustProjects: ['work/a'] }), undefined)
  assert.deepEqual(rel.config.trustProjects, [])
  assert.equal(rel.errors.length, 1)
  const fromProject = parseConfig(undefined, json({ trustProjects: ['/work/a'] }))
  assert.deepEqual(fromProject.config.trustProjects, [])
  assert.equal(fromProject.errors.length, 1)
  assert.match(fromProject.errors[0]!, /project/)
})

test('names must match [A-Za-z0-9:_-]{1,64}', () => {
  const names = ['', 'a b', 'a/b', 'x'.repeat(65), 'ü', '__proto__x\n']
  for (const name of names) {
    const { config, errors } = parseConfig(json({ skills: { [name]: { always: true } } }), undefined)
    assert.equal(errors.length, 1, JSON.stringify(name))
    assert.deepEqual(Object.keys(config.skills), [])
  }
  const ok = parseConfig(json({ skills: { 'terse:terse-mode_1': { always: true }, ['x'.repeat(64)]: { always: true } } }), undefined)
  assert.deepEqual(ok.errors, [])
  const needBad = parseConfig(json({ needs: { 'bad name': 'x' } }), undefined)
  assert.equal(needBad.errors.length, 1)
})

test('need texts are one line of 1 to 200 characters', () => {
  for (const text of ['', 'two\nlines', 'cr\rhere', 'x'.repeat(201), 5]) {
    const { config, errors } = parseConfig(json({ needs: { prose: text } }), undefined)
    assert.equal(errors.length, 1, JSON.stringify(text))
    assert.deepEqual(config.needs, {})
    const o = parseConfig(json({ needs: { prose: { for: 'work', what: text } } }), undefined)
    assert.equal(o.errors.length, 1, JSON.stringify(text))
    assert.deepEqual(o.config.needs, {})
  }
  assert.deepEqual(parseConfig(json({ needs: { prose: { for: 'work', what: 'x'.repeat(200) } } }), undefined).errors, [])
  assert.deepEqual(parseConfig(json({ needs: { prose: 'x'.repeat(200) } }), undefined).errors, [])
})

test('always with need is an error; a skill with no trigger is an error', () => {
  const user = {
    skills: { a: { always: true, need: 'prose' }, b: {}, c: { always: false }, d: { startup: 'injected' } },
    needs: { prose: 'Writing.' },
  }
  const { config, errors } = parseConfig(json(user), undefined)
  assert.deepEqual(Object.keys(config.skills), ['d'])
  assert.equal(errors.length, 3)
})

test('a leading BOM is stripped before parsing', () => {
  const { config, errors } = parseConfig('\uFEFF' + json({ skills: { a: { always: true } } }), undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(Object.keys(config.skills), ['a'])
})

test('file-supplied text in error messages is cut to 80 characters', () => {
  const long = 'q'.repeat(500)
  const outputs = [
    parseConfig(json({ [long]: 1 }), undefined).errors,
    parseConfig(json({ skills: { [long]: { always: true } } }), undefined).errors,
    parseConfig(json({ skills: { a: { need: long } } }), undefined).errors,
    parseConfig(json({ skills: { a: { [long]: 1 } } }), undefined).errors,
    parseConfig('{"x":"' + long + '" nope', undefined).errors,
  ]
  for (const errors of outputs) {
    assert.ok(errors.length >= 1)
    for (const e of errors) assert.ok(!e.includes('q'.repeat(81)), e.slice(0, 200))
  }
})

test('project file: at most 20 skills and 10 needs are read, and the error names the cap', () => {
  const skills = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`s${i}`, { always: true }]))
  const needs = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`n${i}`, `Need ${i}.`]))
  const { config, errors } = parseConfig(undefined, json({ skills, needs }))
  assert.equal(Object.keys(config.skills).length, 20)
  assert.equal(Object.keys(config.needs).length, 10)
  assert.ok(errors.some((e) => /project config: .*20 skills/.test(e)), errors.join('\n'))
  assert.ok(errors.some((e) => /project config: .*10 needs/.test(e)), errors.join('\n'))
  const user = parseConfig(json({ skills, needs }), undefined)
  assert.equal(Object.keys(user.config.skills).length, 25, 'the user file has no cap')
})

test('duty evidence gets the same length and control character checks as rule evidence', () => {
  const duty = (evidence: unknown) => ({ skills: { x: { always: true, duty: { after: { tools: ['Write'] }, evidence } } } })
  for (const evidence of [{ tool: 'Bash', command: 'a‮b' }, { tool: 'Bash', command: 'x'.repeat(201) }, { tool: 'Ba\nsh' }, { tool: 'T'.repeat(101) }]) {
    for (const [user, project] of [[json(duty(evidence)), undefined], [undefined, json(duty(evidence))]] as const) {
      const { config, errors } = parseConfig(user, project)
      assert.deepEqual(Object.keys(config.skills), [], JSON.stringify(evidence))
      assert.ok(errors.some((e) => /duty\.evidence/.test(e)), errors.join('\n'))
    }
  }
  assert.deepEqual(parseConfig(json(duty({ tool: 'Bash', command: 'npm test' })), undefined).errors, [])
})

test('a gate cannot name the Skill tool: the entry is dropped like a skill rule', () => {
  const { config, errors } = parseConfig(json({ skills: { x: { always: true, gate: { tools: ['Write', 'Skill'] } }, y: { always: true } } }), undefined)
  assert.deepEqual(Object.keys(config.skills), ['y'])
  assert.ok(errors.some((e) => /gate/.test(e) && /Skill/.test(e)), errors.join('\n'))
})

test('trustProjects compares with the same root normalisation as where', async () => {
  const { isTrustedRoot } = await import('../src/core/config.ts')
  const { config } = parseConfig(json({ trustProjects: ['/work/a/', '/work/b'] }), undefined)
  assert.equal(isTrustedRoot(config, '/work/a'), true)
  assert.equal(isTrustedRoot(config, '/work/a//'), true)
  assert.equal(isTrustedRoot(config, '/work/b/'), true)
  assert.equal(isTrustedRoot(config, '/work/c'), false)
  assert.equal(isTrustedRoot(config, undefined), false)
  assert.equal(isTrustedRoot({ trustProjects: ['/work/a/'] }, '/work/a'), true, 'a config built by hand is normalised too')
})

test('project needs are named in the config', () => {
  const { config } = parseConfig(json({ needs: { a: 'A.' } }), json({ needs: { b: 'B.' } }))
  assert.deepEqual(config.projectNeeds, ['b'])
})

test('notices false read from user file', () => {
  const r = parseConfig(JSON.stringify({ notices: false }), undefined)
  assert.deepEqual(r.errors, [])
  assert.equal(r.config.notices, false)
})

test('notices in project file → error text above', () => {
  const r = parseConfig(undefined, JSON.stringify({ notices: false }))
  assert.equal(r.config.notices, true)
  assert.equal(r.errors.filter((e) => /notices is only allowed in the user config; ignored/.test(e)).length, 1)
})

test('notices "no" → error text above', () => {
  const r = parseConfig(JSON.stringify({ notices: 'no' }), undefined)
  assert.equal(r.config.notices, true)
  assert.equal(r.errors.filter((e) => /notices: must be true or false; ignored/.test(e)).length, 1)
})

test('a string need counts as work and is marked as having no audience', () => {
  const { config, errors } = parseConfig(json({ needs: { prose: 'Writing.' } }), undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(config.needs.prose, { for: 'work', what: 'Writing.', noAudience: true })
})

test('an object need is parsed with its audience', () => {
  const { config, errors } = parseConfig(json({ needs: { prose: { for: 'readers', what: 'A text others read.' } } }), undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(config.needs.prose, { for: 'readers', what: 'A text others read.' })
})

test('an object need with a bad or missing for is kept as work, with the error', () => {
  for (const need of [{ for: 'everyone', what: 'x' }, { what: 'x' }]) {
    const { config, errors } = parseConfig(json({ needs: { prose: need } }), undefined)
    assert.equal(errors.length, 1, JSON.stringify(need))
    assert.match(errors[0]!, /prose\.for: must be one of chat, readers, users, work; counted as work/)
    assert.deepEqual(config.needs.prose, { for: 'work', what: 'x' })
  }
})

test('an object need with an unknown key, no what, or a bad what is dropped', () => {
  for (const need of [{ for: 'work' }, { for: 'work', what: 'x', extra: 1 }, { what: '' }]) {
    const { config, errors } = parseConfig(json({ needs: { prose: need } }), undefined)
    assert.ok(errors.length >= 1, JSON.stringify(need))
    assert.deepEqual(config.needs, {})
  }
})

test('for on an always-on skill is read; elsewhere it is an error and ignored', () => {
  const ok = parseConfig(json({ skills: { 'terse:terse-mode': { always: true, for: 'chat' } } }), undefined)
  assert.deepEqual(ok.errors, [])
  assert.equal(ok.config.skills['terse:terse-mode']?.for, 'chat')
  const bad = parseConfig(json({ skills: { g: { need: 'n', for: 'chat' } }, needs: { n: 'x' } }), undefined)
  assert.equal(bad.errors.length, 1)
  assert.match(bad.errors[0]!, /g\.for: only for always-on skills; ignored/)
  assert.equal(bad.config.skills.g?.for, undefined)
  assert.equal(bad.config.skills.g?.need, 'n')
  const worse = parseConfig(json({ skills: { g: { always: true, for: 'nobody' } } }), undefined)
  assert.match(worse.errors[0]!, /g\.for: must be one of chat, readers, users, work; ignored/)
  assert.equal(worse.config.skills.g?.always, true)
  assert.equal(worse.config.skills.g?.for, undefined)
})

test('notIn is read from the user file, normalised without trailing slash', () => {
  const { config, errors } = parseConfig(json({ skills: { g: { always: true, notIn: ['/home/a/repo/', '/x'] } } }), undefined)
  assert.deepEqual(errors, [])
  assert.deepEqual(config.skills.g?.notIn, ['/home/a/repo', '/x'])
  for (const bad of ['/x', ['relative'], [5]]) {
    const r = parseConfig(json({ skills: { g: { always: true, notIn: bad } } }), undefined)
    assert.equal(r.errors.length, 1, JSON.stringify(bad))
    assert.equal(r.config.skills.g?.notIn, undefined)
  }
})

test('notIn in the project file is an error and ignored; it cannot switch off a user skill', () => {
  const user = { skills: { g: { always: true } } }
  const project = { skills: { g: { always: true, notIn: ['/p'] }, h: { always: true, notIn: ['/p'] } } }
  const { config, errors } = parseConfig(json(user), json(project))
  assert.ok(errors.some((e) => /notIn is only allowed in the user config; ignored/.test(e)))
  assert.equal(config.skills.g?.notIn, undefined)
  assert.equal(config.skills.h?.notIn, undefined)
  assert.equal(config.skills.h?.always, true)
})

test('notIn holds at most 20 paths; for on a startup-injected skill without always is an error', () => {
  const many = Array.from({ length: 21 }, (_, i) => `/r${i}`)
  const r = parseConfig(json({ skills: { g: { always: true, notIn: many } } }), undefined)
  assert.equal(r.errors.length, 1)
  assert.equal(r.config.skills.g?.notIn, undefined)
  assert.deepEqual(parseConfig(json({ skills: { g: { always: true, notIn: many.slice(0, 20) } } }), undefined).errors, [])
  const s = parseConfig(json({ skills: { g: { startup: 'injected', for: 'chat' } } }), undefined)
  assert.match(s.errors[0]!, /g\.for: only for always-on skills; ignored/)
  assert.equal(s.config.skills.g?.for, undefined)
})

test('a duty whose after.tools has no file-changing tool is kept with an error', () => {
  const cfg = { skills: { x: { need: 'n', duty: { after: { tools: ['Artifact'] }, evidence: { tool: 'Bash' } } } }, needs: { n: 'Something.' } }
  const { config, errors } = parseConfig(json(cfg), undefined)
  assert.ok(config.skills.x?.duty)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /x\.duty\.after\.tools: needs Write, Edit, MultiEdit or NotebookEdit; the duty never opens/)
})

test('a need named none is dropped: the name is the classifier label for no work', () => {
  const { config, errors } = parseConfig(json({ skills: { s: { need: 'none' } }, needs: { none: { for: 'work', what: 'x' }, ok: { for: 'work', what: 'y' } } }), undefined)
  assert.ok(errors.some((m) => m.endsWith('none: "none" is reserved; need dropped')), errors.join('|'))
  assert.equal('none' in config.needs, false)
  assert.ok('ok' in config.needs)
})

test('a chat need gets a warning: it only starts with /souffleur need', () => {
  const { config, errors } = parseConfig(json({ needs: { talk: { for: 'chat', what: 'x' } } }), undefined)
  assert.equal(errors.length, 1)
  assert.match(errors[0]!, /talk\.for: .*chat.*\/souffleur need/)
  assert.equal(config.needs.talk!.for, 'chat')
})

test('reply is read on an always-on chat skill; both fields are optional', () => {
  const ok = parseConfig(json({ skills: { chat: { always: true, for: 'chat', reply: { maxChars: 800, headings: 0 } }, c2: { always: true, for: 'readers' } } }), undefined)
  assert.deepEqual(ok.errors, [])
  assert.deepEqual(ok.config.skills.chat?.reply, { maxChars: 800, headings: 0 })
})

test('reply elsewhere is an error and ignored', () => {
  const cases = [
    { always: true, reply: { maxChars: 800 } },
    { always: true, for: 'readers', reply: { maxChars: 800 } },
    { need: 'n', for: 'chat', reply: { maxChars: 800 } },
  ]
  for (const rule of cases) {
    const r = parseConfig(json({ needs: { n: 'x' }, skills: { s: rule } }), undefined)
    assert.ok(r.errors.some((e) => e.endsWith('s.reply: only for an always-on skill with "for": "chat"; ignored')), JSON.stringify(rule))
    assert.equal(r.config.skills.s?.reply, undefined)
  }
})

test('reply values out of range, not integer or unknown are errors and ignored', () => {
  for (const reply of [{ maxChars: 199 }, { maxChars: 20001 }, { maxChars: 800.5 }, { maxChars: '800' }, { headings: -1 }, { headings: 21 }, { headings: 1.5 }, { words: 3 }, 'short', [1]]) {
    const r = parseConfig(json({ skills: { s: { always: true, for: 'chat', reply } } }), undefined)
    assert.ok(r.errors.some((e) => e.includes('s.reply')), JSON.stringify(reply))
    assert.equal(r.config.skills.s?.reply, undefined, JSON.stringify(reply))
  }
  const edge = parseConfig(json({ skills: { s: { always: true, for: 'chat', reply: { maxChars: 200, headings: 20 } } } }), undefined)
  assert.deepEqual(edge.errors, [])
})

test('reply with neither field is an error and ignored', () => {
  const r = parseConfig(json({ skills: { s: { always: true, for: 'chat', reply: {} } } }), undefined)
  assert.ok(r.errors.some((e) => e.endsWith('s.reply: needs maxChars or headings; ignored')))
  assert.equal(r.config.skills.s?.reply, undefined)
})

test('only one chat skill can carry reply; the later one is an error and ignored', () => {
  const r = parseConfig(json({ skills: { a: { always: true, for: 'chat', reply: { maxChars: 800 } }, b: { always: true, for: 'chat', reply: { headings: 0 } } } }), undefined)
  assert.deepEqual(r.config.skills.a?.reply, { maxChars: 800 })
  assert.equal(r.config.skills.b?.reply, undefined)
  assert.ok(r.errors.some((e) => e.endsWith('b.reply: only one chat skill can carry reply; ignored')))
})
