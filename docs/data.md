# What Souffleur reads, stores and costs

Reads:

- `~/.claude/souffleur.json` and the project's `.claude/souffleur.json`, at session start, on every `/souffleur` command, and at the next prompt after either file changed on disk (its modification time or size).
- The text of each skill the main session loads, for learning (see [Rules and notes](config.md#rules-and-notes)): the skill file at its path, up to 60,000 characters, sent to the small model. This needs your user file and stops under `/souffleur pause` or `"learn": { "skills": false }`.
- Only during `/souffleur init` and `/souffleur migrate`: your `~/.claude/settings.json`, your user and project `CLAUDE.md` files, the files those import with `@path` (one level), and the current project's memory index. `init` also reads `~/.claude/plugins/installed_plugins.json` and the `hooks/hooks.json` and `.claude-plugin/plugin.json` of an installed plugin, to find out whether a plugin skill is loaded by a `SessionStart` hook.

Writes:

- `/souffleur init` writes `~/.claude/souffleur.json` after each of your answers, and so does a yes to a rule or note proposal. `/souffleur migrate` writes `settings.json` only after you answer `Turn off`, with a backup copy first. Every write of the user file goes through a temporary file `souffleur.json.tmp-<time>-<random>` next to it that replaces the file in one move; a symlinked `souffleur.json` is written through to what it points to. The mod API does not expose a file's mode, so the replacement file gets the default mode of a new file, not the old file's. Before the first write after a session start it saves `souffleur.json.bak-<ms>` and keeps the newest three of those (a copy with another suffix is never removed).

Stores, in Claude Code's plugin store on your machine:

- `session:<id>`: the ledger, active needs, open duties, waiting proposals and errors of one session, stamped with the time it was stored. At session start Souffleur removes `session:*` entries that were not stored for 14 days, and keeps at most 50 copies.
- `souffleur:declined`: the hashes of the last 200 proposals you declined, so they are not proposed again.
- `souffleur:skill-hash:<hash>`: one small entry per skill version that was read, with its state (done, offered or failed) and the time it was last stored or read (refreshed at most once a day). At session start Souffleur removes the ones not stored or read for 14 days, so a version you no longer use is read again if it comes back.

Plugin data folder (`CLAUDE_PLUGIN_DATA`): `allowed_signers` while a signed update is checked, `update.lock` while an update installs, and `user-file.lock` for a moment while Souffleur writes your user file. A lock folder holds one small `owner` file with a time and a random token. A lock older than its limit (30 seconds for `user-file.lock`, 2 minutes for `update.lock`) is treated as left behind and taken over.

Network:

- Once a day Souffleur runs `git ls-remote --tags --refs` against `https://github.com/r4KK4n/skill-souffleur` to find a newer release. This is the default (`update: "notify"`). Set `"update": "off"` in your user file and the look-up stops. `auto` and `/souffleur update` also fetch from that URL. See [updates.md](updates.md#update-notice-and-automatic-update).
- Everything else goes through Claude Code's own model calls: the small model that detects needs and reads skill texts. Souffleur opens no other connection.

Costs:

- Detecting needs costs two small-model calls on each prompt you type, by default run in parallel (with `"workCheck": "after"` call B runs only on code prompts, so most prompts cost one; while call B is paused a code prompt costs one): call A asks what the prompt will produce (budget 2.5 seconds, a `chat-reply` starts nothing) and call B picks a `work` need, awaited only for code work (budget 4 seconds). A call that runs out of time means no new need for that prompt. Needs from a project file that is not trusted are not classified.
- `/souffleur` shows the small-model calls, their tokens and an estimated cost at list price; the figure is an estimate, not a bill.
- Reading a skill costs one small-model call of up to 30 seconds in the background, at most five per session.
- A restored skill adds its full text to the context again. The restore request and the notes of one prompt stay under 10,000 characters together; skills that do not fit stay `not needed yet` or `stale` in `/souffleur` and are asked for on a later prompt.

## Limits

- Subagents are not gated. When the session hands work to a subagent while a need is active or an always-on skill that is not `for: chat` applies, the brief has to name the skills the subagent should load, or say `skills: none`.
- Souffleur checks that a skill is loaded and that a duty left its trace. It does not judge how well the model followed a skill.
- A restore request after a compaction in the middle of a long turn rides on the next tool result. Models may treat such notes as untrusted and skip them; in `enforce` the gate still catches the next gated step.
- A skill that does not load after two requests is marked `unavailable` and is neither requested nor gated again in that session.
- Not every path has run live. The dialogs of `/souffleur init`, `/souffleur migrate` and the turn-end question were tested with the test kit and in the desktop app's dialog. `init`, `migrate` and the proposal dialogs have not yet run end to end in a live session, and the band above the prompt in the desktop and mobile apps was checked with the test kit only. Where no dialog can open, the commands print what they would ask and change nothing.
- `enforce` does not reach a `Bash` redirect, an MCP file tool or a subagent's writes. See [config.md](config.md#what-enforce-does-not-cover).
