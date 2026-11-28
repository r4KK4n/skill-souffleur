// Type-checks src/mod against the mod API types that Claude Code writes out (see docs/compatibility.md).
// The file is not in the npm package and is not ours to redistribute, so this looks for a local copy,
// links it into the git-ignored .mod-types/ and runs tsc. Without a copy it prints one line and exits 0.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const target = join(root, '.mod-types', 'claude-code.d.ts')
const HOW =
  'Open a Claude Code session and load the plugin-authoring skill (it writes the file under <tmp>/claude-<uid>/bundled-skills/<version>/), or set CLAUDE_MOD_TYPES to a claude-code.d.ts.'

function newest(paths) {
  return paths.filter((p) => existsSync(p)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0]
}

function find() {
  const explicit = process.env.CLAUDE_MOD_TYPES
  if (explicit) return existsSync(explicit) && statSync(explicit).isFile() ? explicit : undefined
  let version
  try {
    version = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim().split(' ')[0]
  } catch {
    console.log(`typecheck:mod skipped: no \`claude\` on PATH to name the version. ${HOW}`)
    return undefined
  }
  const bases = new Set([tmpdir(), process.env.TMPDIR ?? '', '/tmp'].filter(Boolean))
  const found = []
  for (const base of bases) {
    let dirs = []
    try {
      dirs = readdirSync(base).filter((d) => d.startsWith('claude-'))
    } catch {}
    for (const d of dirs) {
      const vdir = join(base, d, 'bundled-skills', version)
      let hashes = []
      try {
        hashes = readdirSync(vdir)
      } catch {}
      for (const h of hashes) found.push(join(vdir, h, 'plugin-authoring', 'types', 'claude-code.d.ts'))
    }
  }
  const pick = newest(found)
  if (!pick) console.log(`typecheck:mod skipped: no claude-code.d.ts for Claude Code ${version}. ${HOW}`)
  return pick
}

const source = find()
if (!source) {
  if (process.env.CLAUDE_MOD_TYPES) {
    console.error(`typecheck:mod: CLAUDE_MOD_TYPES does not point to a file.`)
    process.exit(1)
  }
  process.exit(0)
}
mkdirSync(dirname(target), { recursive: true })
rmSync(target, { force: true })
try {
  symlinkSync(source, target)
} catch {
  copyFileSync(source, target)
}
console.log(`typecheck:mod using ${source}`)
const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const r = spawnSync(process.execPath, [tsc, '-p', join(root, 'tsconfig.mod.json')], { stdio: 'inherit', cwd: root })
process.exit(r.status ?? 1)
