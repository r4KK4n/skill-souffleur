import { compareVersions } from './version.ts'

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/
const DAY_MS = 86_400_000

/** The newest release tag in `git ls-remote --tags --refs` output that is newer than `current`; only `vX.Y.Z` tags count. */
export function newestRelease(lsRemote: string, current: string): string | undefined {
  let best: string | undefined
  for (const line of lsRemote.split(/\r?\n/)) {
    const m = /^[0-9a-f]+\trefs\/tags\/(\S+)$/.exec(line.trim())
    const tag = m?.[1]
    if (tag === undefined || !TAG.test(tag)) continue
    if (compareVersions(tag.slice(1), current) !== 1) continue
    if (best === undefined || compareVersions(tag.slice(1), best.slice(1)) === 1) best = tag
  }
  return best
}

/** True when no check is stored or the stored one is at least 24 hours old. */
export function isCheckDue(check: { at: number } | undefined, now: number): boolean {
  return check === undefined || now - check.at >= DAY_MS
}

export function isUpdateCheck(v: unknown): v is { at: number; latest?: string } {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  const o = v as Record<string, unknown>
  return typeof o.at === 'number' && Number.isFinite(o.at) && (o.latest === undefined || typeof o.latest === 'string')
}

export type UpdateKind = 'notify' | 'notify-market' | 'auto-done' | 'auto-unverified' | 'auto-no-signer'

/** The one line shown for a newer release. */
export function updateLine(kind: UpdateKind, next: string, cur: string): string {
  const out = `Souffleur ${next} is out (you run ${cur}).`
  switch (kind) {
    case 'notify': return `${out} /souffleur update installs it.`
    case 'notify-market': return `${out} /plugin update installs it.`
    case 'auto-done': return `Souffleur updated to ${next} (tag signed by your key).`
    case 'auto-unverified': return `Souffleur ${next} is out but its tag is not signed by your updateSigner key; not installed. /souffleur update installs it anyway.`
    case 'auto-no-signer': return `${out} /souffleur update installs it. Set updateSigner to let auto install it.`
  }
}

/** Why a folder install was left alone. */
export function refusalLine(reason: string, root: string): string {
  return `Souffleur: not updated, ${reason}. Update by hand with git in ${root}.`
}
