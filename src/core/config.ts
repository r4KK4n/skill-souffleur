import type { Config, Match, Mode, NeedName, SkillName, SkillRule } from './types.ts'

type Source = 'user' | 'project'
type FileConfig = { mode?: Mode; skills: Record<SkillName, SkillRule>; needs: Record<NeedName, string> }

class SchemaError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

function check(ok: boolean, where: string, problem: string): void {
  if (!ok) throw new SchemaError(`${where}: ${problem}`)
}

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string): void {
  for (const key of Object.keys(obj)) check(allowed.includes(key), where, `unknown key "${key}"`)
}

function stringList(v: unknown, where: string): string[] {
  check(Array.isArray(v) && v.every((s) => typeof s === 'string'), where, 'must be a list of strings')
  return [...(v as string[])]
}

function parseMatch(v: unknown, where: string): Match {
  check(isObject(v), where, 'must be an object')
  const obj = v as Record<string, unknown>
  onlyKeys(obj, ['tools', 'paths'], where)
  const match: Match = { tools: stringList(obj.tools, `${where}.tools`) }
  if (obj.paths !== undefined) match.paths = stringList(obj.paths, `${where}.paths`)
  return match
}

function parseRule(v: unknown, where: string): SkillRule {
  check(isObject(v), where, 'must be an object')
  const obj = v as Record<string, unknown>
  onlyKeys(obj, ['always', 'startup', 'need', 'gate', 'duty'], where)
  const rule: SkillRule = {}
  if (obj.always !== undefined) {
    check(typeof obj.always === 'boolean', `${where}.always`, 'must be true or false')
    rule.always = obj.always as boolean
  }
  if (obj.startup !== undefined) {
    check(obj.startup === 'injected', `${where}.startup`, 'must be "injected"')
    rule.startup = 'injected'
  }
  if (obj.need !== undefined) {
    check(typeof obj.need === 'string', `${where}.need`, 'must be a string')
    rule.need = obj.need as string
  }
  if (obj.gate !== undefined) rule.gate = parseMatch(obj.gate, `${where}.gate`)
  if (obj.duty !== undefined) {
    check(isObject(obj.duty), `${where}.duty`, 'must be an object')
    const duty = obj.duty as Record<string, unknown>
    onlyKeys(duty, ['after', 'evidence'], `${where}.duty`)
    const after = parseMatch(duty.after, `${where}.duty.after`)
    check(isObject(duty.evidence), `${where}.duty.evidence`, 'must be an object')
    const ev = duty.evidence as Record<string, unknown>
    onlyKeys(ev, ['tool', 'command'], `${where}.duty.evidence`)
    check(typeof ev.tool === 'string', `${where}.duty.evidence.tool`, 'must be a string')
    const evidence: { tool: string; command?: string } = { tool: ev.tool as string }
    if (ev.command !== undefined) {
      check(typeof ev.command === 'string', `${where}.duty.evidence.command`, 'must be a string')
      evidence.command = ev.command as string
    }
    rule.duty = { after, evidence }
  }
  return rule
}

function parseFile(text: string): FileConfig {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    throw new SchemaError(`invalid JSON (${(e as Error).message})`)
  }
  check(isObject(data), 'top level', 'must be an object')
  const obj = data as Record<string, unknown>
  onlyKeys(obj, ['mode', 'skills', 'needs'], 'top level')
  const file: FileConfig = { skills: {}, needs: {} }
  if (obj.mode !== undefined) {
    check(obj.mode === 'observe' || obj.mode === 'enforce', 'mode', 'must be "observe" or "enforce"')
    file.mode = obj.mode as Mode
  }
  if (obj.skills !== undefined) {
    check(isObject(obj.skills), 'skills', 'must be an object')
    for (const [name, rule] of Object.entries(obj.skills as Record<string, unknown>)) {
      check(name !== '__proto__', 'skills', '"__proto__" is not a skill name')
      file.skills[name] = parseRule(rule, `skills["${name}"]`)
    }
  }
  if (obj.needs !== undefined) {
    check(isObject(obj.needs), 'needs', 'must be an object')
    for (const [name, text] of Object.entries(obj.needs as Record<string, unknown>)) {
      check(name !== '__proto__', 'needs', '"__proto__" is not a need name')
      check(typeof text === 'string', `needs["${name}"]`, 'must be a string')
      file.needs[name] = text as string
    }
  }
  return file
}

/**
 * Reads the user file and the project file (either may be absent). A file with
 * invalid JSON or an invalid shape is skipped as a whole. Project entries replace
 * user entries per skill name and per need name. Only the user file may set
 * `mode: "enforce"`, so a cloned repository cannot turn gates on for its reader.
 */
export function parseConfig(
  userText: string | undefined,
  projectText: string | undefined,
): { config: Config; errors: string[] } {
  const errors: string[] = []
  const config: Config = { mode: 'observe', skills: {}, needs: {} }
  const origin: Record<SkillName, Source> = {}

  const files: [Source, string | undefined][] = [
    ['user', userText],
    ['project', projectText],
  ]
  for (const [source, text] of files) {
    if (text === undefined) continue
    let file: FileConfig
    try {
      file = parseFile(text)
    } catch (e) {
      if (!(e instanceof SchemaError)) throw e
      errors.push(`${source} config skipped: ${e.message}`)
      continue
    }
    if (file.mode === 'enforce' && source === 'project') {
      errors.push('project config: mode "enforce" is only allowed in the user config; ignored')
    } else if (file.mode !== undefined) {
      config.mode = file.mode
    }
    for (const [name, rule] of Object.entries(file.skills)) {
      config.skills[name] = rule
      origin[name] = source
    }
    Object.assign(config.needs, file.needs)
  }

  for (const [name, rule] of Object.entries(config.skills)) {
    const source = origin[name]
    if (rule.need !== undefined && !Object.hasOwn(config.needs, rule.need)) {
      errors.push(`${source} config: skill "${name}" names unknown need "${rule.need}"; skill dropped`)
      delete config.skills[name]
      continue
    }
    const command = rule.duty?.evidence.command
    if (command !== undefined) {
      try {
        new RegExp(command)
      } catch (e) {
        errors.push(`${source} config: skill "${name}" has an invalid evidence command regex (${(e as Error).message}); skill dropped`)
        delete config.skills[name]
      }
    }
  }

  return { config, errors }
}

function globToRegExp(glob: string): RegExp {
  let src = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        src += '(?:.*/)?'
        i += 2
      } else {
        src += '.*'
        i += 1
      }
    } else if (c === '*') {
      src += '[^/]*'
    } else if (c === '?') {
      src += '[^/]'
    } else {
      src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`^${src}$`)
}

/** True when `tool` is listed and, if `paths` is set, `path` matches one of its globs (`**`, `*`, `?`). */
export function matches(m: Match, tool: string, path: string | undefined): boolean {
  if (!m.tools.includes(tool)) return false
  if (m.paths === undefined) return true
  if (path === undefined) return false
  return m.paths.some((glob) => globToRegExp(glob).test(path))
}
