# Statistics

Figures measured on this repository or recorded in its docs. Each row gives the date and where to check it. Nothing here is an estimate.

## Measured on 2026-11-28

| Figure | Value | Source |
|---|---|---|
| Tests | 590 pass, 0 fail, 3.5 s | `npm test` (the `ℹ tests`, `ℹ fail` and `ℹ duration_ms` lines) |
| Node versions in CI | 22.6.0, 22, 24, 26 | `.github/workflows/ci.yml:22` |
| Lines in `src/` | 12,334 in all, 6,297 without the test file `src/mod/register.test.ts` (6,037 lines) | `find src -name '*.ts' \| xargs wc -l` |
| Runtime dependencies | 0 | `package.json` (no `dependencies` key) |
| Dev dependencies | 2: `@types/node`, `typescript` | `package.json:17-20` |

## Recorded in the research notes (2026-11-25)

| Figure | Value | Source |
|---|---|---|
| Skill after `/compact` in the same process | A 43 KB test skill comes back cut at exactly 20,000 characters (Claude Code 2.1.322, still true on 2.1.332) | `docs/background.md:42`, `:63` |
| Skill after resume plus `/compact` | Not re-attached at all | `docs/background.md:43`, `:63` |
| Caps on restored skill text | 5,000 tokens per skill, 25,000 in total, as reported upstream | `docs/background.md:23` |
| Restore compliance | The model loaded the named skills first in 10 of 10 fresh sessions, 5 on Haiku and 5 on Opus (Claude Code 2.1.332) | `docs/background.md:65` |
| Classifier calls | 10 calls on 5 prompts (call A and call B) all returned a label; latency 0.73 to 2.14 s. This checks that labels come back, not how often they are right | `docs/compatibility.md:50` |
| Small-model read of a skill | About 2 s for the 43 KB skill with `haiku` | `docs/background.md:87` |
| Upstream reports | About 30 issues, July 2025 to November 2026 | `docs/background.md:19` |
| Price basis | $0.10 per million input tokens and $0.50 per million output tokens for Haiku, list price cached 2026-11-03 | `src/core/cost.ts:18-21` |

## Not measured yet

- Median cost per prompt and per session, from the `/souffleur` totals.
- Classifier accuracy on 100 to 200 scrubbed real prompts, with the rates of false "need started" and timeouts.
- Added latency at p50 and p95.
- Restore success after real compactions, in `observe` and in `enforce`.
- False denials per 100 tool calls, and how often "released after 3 denials" fired.
- Tokens re-added per restore.
- Whether the third-party forced-evaluation numbers (80 to 100 percent activation against about 20 percent, on older Haiku and Sonnet models, `docs/background.md:33`) hold on current models.
