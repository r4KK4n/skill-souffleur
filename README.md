# skill-souffleur

Keeps the skills a Claude Code session needs loaded across compaction and resume.

It is for people who rely on a few long skills (a writing guide, a design checklist, a rule set) in long sessions. Claude Code cuts a skill's text during compaction, and after a resume plus compaction it does not bring the text back. The model then works without rules it followed an hour earlier, and Claude Code does not say so. Souffleur keeps a ledger of the skills a session has loaded, notices when one is cut or dropped, and asks the model to load it again when the current task needs it. [docs/background.md](docs/background.md) has the measurements and the upstream reports.

Version 0.2.9, tag `v0.2.9`, verified on Claude Code 2.1.332. Souffleur is a Claude Code mod, TypeScript that runs inside Claude Code through its early-access mod API, so a Claude Code update can break it until it is adapted. It is provided as is. [docs/compatibility.md](docs/compatibility.md) lists what was checked on which version and how.

## Quick start

1. Install it (Claude Code 2.1.332 or later). At the prompt of a terminal session:

   ```
   /plugin install skill-souffleur --marketplace r4KK4n/skill-souffleur
   ```

   From a shell, or in a Remote Control session, use the two `claude plugin` commands in [docs/updates.md](docs/updates.md#marketplace-install).

   Then run `/reload-plugins` or restart the session, so the running session loads it.
2. Run `/souffleur init`. It asks how Souffleur should keep your skills, one question per plugin, and writes `~/.claude/souffleur.json`.
3. Run `/souffleur`. It shows what Souffleur knows about the session:

   ```
   Mode: observe. Times in UTC.

   | Skill | State | Since | Reason |
   | --- | --- | --- | --- |
   | writing-guide | loaded | 09:12 | skill.prompt |
   | ui-checklist | restoring | 09:42 | skill.prompt |
   | code-style | not needed yet | 09:03 | |

   Active needs:
   - prose (since 09:12)
   - ui (since 09:35)

   Small model: 14 calls, 9.1k in / 0.2k out, about $0.01 this session (total 120 calls, about $0.09). Estimate at list price.
   Version 0.2.9 · latest 0.2.9 · checked 08:55 · update: notify

   Claude Code 2.1.332
   ```

   Here a compaction cut `ui-checklist`. The Since column of a restoring row is the time of the request: at 09:42 Souffleur asked the model to load it again.

Keep the default mode, `observe`, for a few sessions and look at `/souffleur` after a compaction. If the ledger matches what you saw, you can switch to `enforce`.

## What it does

- Tracks which skills a session loaded, and notices when compaction or a resume drops or truncates one.
- Decides from the current work which skills it needs (a skill's need is the kind of work it serves, such as writing), and asks the model to invoke the missing ones again. It does not inject skill text itself.
- In `enforce` mode, holds back a configured step, such as writing a file (a gate), until the skills it needs are loaded.
- Shows which skills are active, since when and why.

You choose the skills and the rules in `~/.claude/souffleur.json` ([docs/config.md](docs/config.md)). What you type in the chat still wins: if you tell the model not to invoke any skill, it follows you and only mentions Souffleur's request.

Souffleur shows up in four places. A short note in your prompt asks the model to load a missing skill first. The status line shows a summary such as `14:02 · observe · 3 loaded, 1 restoring · ~$0.03`, and the desktop and mobile apps show a one-row band above the prompt while something needs attention. In `enforce` a step that needs a missing skill is refused once with the reason. An open duty (a step that must be followed by evidence, such as a detector run) is mentioned once when it opens. `/souffleur` lists all of it.

## Modes

`observe` is the default. Souffleur keeps the ledger, asks the model to reload skills and reports through `/souffleur`, but it never denies a tool call. Calls it would have denied are listed under "Would have denied", so you can see what `enforce` would do first.

`enforce` lets gates and duties deny a tool call until the skill it names is loaded. A gate names the tools and paths it guards, and a duty names the evidence a step needs. Only your user file can set it. It is advisory: a `Bash` redirect, a file tool from an MCP server and any write by a subagent pass a `Write` gate. [What enforce does not cover](docs/config.md#what-enforce-does-not-cover) has the details.

## Network, files and cost

- Once a day Souffleur runs `git ls-remote --tags --refs` against `https://github.com/r4KK4n/skill-souffleur` to look for a newer release (`update: "notify"`, the default). Set `"update": "off"` in `~/.claude/souffleur.json` to stop it.
- It also fetches from that URL when you set `"update": "auto"` or type `/souffleur update`. This look-up is the only request it makes unasked.
- Everything else goes through Claude Code's own model calls. The small model is the cheap model Claude Code runs for Souffleur: two calls on each prompt you type, and one per skill text it reads to propose rules (switch off with `"learn": { "skills": false }`).
- It reads your config files, and writes `~/.claude/souffleur.json` only after your answer. [docs/data.md](docs/data.md) lists every read, write, store and cost.

## If you already use reload hooks

Hooks that re-inject a skill at session start or remind the model on every prompt do not know whether the skill text is still there. Running them next to Souffleur doubles every reminder. `/souffleur migrate` goes through your old hooks one by one, asks first and turns off only the ones you pick.

## Updates and install options

Souffleur tells you about a newer release at session start. `"update": "auto"` installs signed releases (folder installs only), and the maintainer's public key is in [docs/updates.md](docs/updates.md#signed-releases). To have updates reach running sessions without a restart, uninstall the marketplace plugin first (`claude plugin uninstall skill-souffleur@skill-souffleur`), then install from a release tag into your skills folder:

```
git clone --branch v0.2.9 https://github.com/r4KK4n/skill-souffleur ~/.claude/skills/skill-souffleur
```

## Uninstall and pause

`/souffleur pause` switches Souffleur off for the current session, and `/souffleur resume` switches it on again. To remove it, run `claude plugin uninstall skill-souffleur@skill-souffleur`, or `rm -rf ~/.claude/skills/skill-souffleur` for a folder install. Your `~/.claude/souffleur.json` stays.

## Troubleshooting

- `degraded, see /souffleur` in the status line: Souffleur could not read its config, an event changed shape after a Claude Code update, or the small model failed three times in a row. `/souffleur` lists what failed.
- No status line: your app may not show mod status lines. `/souffleur` always works.
- Report problems with your Claude Code version (`claude --version`) in the [issue tracker](https://github.com/r4KK4n/skill-souffleur/issues).

## Status

- Works and has tests: the ledger, restores after compaction and resume, need detection, gates, duties, rules and notes, `/souffleur`, signed updates. Release tags `v0.1.0` to `v0.2.9`.
- Not verified live: the dialogs of `init`, `migrate` and proposals have not run end to end in a live session, and the band in the apps was checked with the test kit only. See [docs/data.md](docs/data.md#limits).
- Next: project rule files, not only skills ([#42](https://github.com/r4KK4n/skill-souffleur/issues/42)); see the other [open issues](https://github.com/r4KK4n/skill-souffleur/issues).

## More

- [docs/config.md](docs/config.md): the config format, rules and notes, notices.
- [docs/commands.md](docs/commands.md): every `/souffleur` command, `init` and `migrate`.
- [docs/updates.md](docs/updates.md): install kinds, updates, signed releases.
- [docs/data.md](docs/data.md): what Souffleur reads, stores and costs, and its limits.
- [docs/design.md](docs/design.md): how it works. [docs/background.md](docs/background.md): why it exists.
- [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [LICENSE](LICENSE) (MIT, no warranty). Read `src/mod/register.ts` first: it is the adapter that touches your machine (files, processes, and the network for updates). `src/core/` holds the pure rules and has no such access.
