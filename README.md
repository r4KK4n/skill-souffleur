# skill-souffleur

Keeps Claude Code skills loaded and in use for the whole session, including after the context is compacted or the session is resumed.

In a theatre, the souffleur sits out of sight at the edge of the stage and gives an actor the line they forgot, at the moment they need it. Souffleur does the same for skills: when compaction drops a skill the current task needs, it brings the skill back.

> **Status:** work in progress, no release yet. See the [roadmap](#roadmap).
>
> **Early access.** Souffleur is a Claude Code mod: TypeScript that runs inside Claude Code through its mod API, shipped and installed as a plugin. Anthropic still changes that API between releases, so an update of Claude Code can break Souffleur until it is adapted. It is provided as is, with no guarantee of fixes or dates. [docs/compatibility.md](docs/compatibility.md) lists the versions each behaviour was checked on.

## The problem

Claude Code loads a skill's instructions into the context when the skill is invoked. Long sessions compact that context, and the skill text does not reliably come back. Tested on Claude Code 2.1.322 with a 43 KB skill:

- In a running session, compaction re-attaches the skill cut off at 20,000 characters. The model no longer sees the rest.
- When a session is resumed and then compacted, the skill is not re-attached at all.
- Claude Code re-attaches at most 5,000 tokens per skill and 25,000 tokens across all skills. Skills that do not fit the budget are dropped.
- Invoking the skill again restores the full text.

The skill list itself comes back after compaction since Claude Code 2.1.304. What gets lost is the content of skills you already used. The model then keeps working without rules it followed an hour earlier, and nothing tells you. Related upstream reports: [#94564](https://github.com/anthropics/claude-code/issues/94564), [#82144](https://github.com/anthropics/claude-code/issues/82144), [#74990](https://github.com/anthropics/claude-code/issues/74990).

## What Souffleur will do

- Keep a ledger of the skills a session has loaded, and notice when compaction or a resume drops or truncates one.
- Decide from what you are working on which skills the current task needs, and load the missing ones by invoking them again.
- Hold back a step, such as writing a file, until the skills that step needs are loaded.
- Show which skills are active in the session, since when, and why.

You choose the skills and the rules in a configuration file. Souffleur never pastes a full skill text into every prompt.

Souffleur is a Claude Code mod, an in-process plugin. For why, including test results on Claude Code 2.1.322, see [docs/background.md](docs/background.md).

## How it works in a session

You work as usual. Souffleur stays quiet while nothing is missing. You notice it in three places:

- When the task needs a skill that is not loaded, or a compaction has cut one, Souffleur adds a short note to your prompt asking the model to invoke that skill first. The model loads it before it answers.
- The status line shows a summary such as `souffleur (observe): 3 loaded, 1 restoring`. If your app does not show it, `/souffleur` gives the same summary as a table.
- In `enforce` mode, a step that needs a missing skill is refused once with the reason, and the model loads the skill and tries again.

A good way to start: install it, run `/souffleur init`, keep `observe` for a few sessions, and look at `/souffleur` after a compaction. If the ledger matches what you saw, switch to `enforce`.

Instructions you give in the chat still win. If you tell the model not to invoke any skill, it follows you and only mentions Souffleur's request.

## Why your own reload hooks are no longer needed

Hooks that re-inject a skill at session start or remind the model on every prompt run blind: they do not know whether the skill text is still there, so they repeat it when nothing is missing and cannot tell when compaction cut it in the middle of a turn. Souffleur sees each skill load and each compaction as it happens and asks for a skill again only when it is missing or cut. Keeping both doubles every reminder and leaves your rules in two places, which is why `/souffleur init` offers to turn the old hooks off.

## Install

Souffleur needs Claude Code 2.1.332 or later. Type this at the prompt of a terminal session:

```
/plugin install skill-souffleur --marketplace r4KK4n/skill-souffleur
```

Claude Code asks whether to add the marketplace; answer `y`. It then asks for a scope: choose user to cover every project, or project for one repository. Souffleur starts with no configuration. Until you add one, the status line reads `souffleur: not set up, run /souffleur init`, and nothing else changes in your session.

`/plugin` exists only in the terminal interface. In a Remote Control session from the desktop or mobile app it is not available ("Plugins aren't available in this environment"). Install from a shell on the machine that runs Claude Code instead:

```
claude plugin marketplace add r4KK4n/skill-souffleur
claude plugin install skill-souffleur@skill-souffleur --scope user
```

New sessions load it. A running session picks it up after `/reload-plugins` or a restart. To update later, run `claude plugin marketplace update skill-souffleur` and `claude plugin update skill-souffleur@skill-souffleur`, then restart.

## Quick start

Create `~/.claude/souffleur.json`, or let `/souffleur init` write it for you:

```json
{
  "mode": "observe",
  "skills": {
    "terse:terse-mode": { "always": true },
    "writing-guide": { "need": "prose" },
    "ui-checklist": { "need": "ui" }
  },
  "needs": {
    "prose": "Writing text people read: docs, specs, plans, issues.",
    "ui": "Designing or building something a user sees."
  }
}
```

A skill with `"always": true` is needed from the first turn. A skill with `"need"` is needed once a prompt matches that need's description. After a compaction or a resume, Souffleur asks the model to load the skills it needs again. A project can add its own `.claude/souffleur.json`, but it cannot change your entries or your mode. The full format, including gates and duties, is in [docs/design.md](docs/design.md#configuration).

## Commands

- `/souffleur` or `/souffleur status` shows the mode, one row per skill with its state, the active needs, open duties, and the calls that `observe` mode would have denied.
- `/souffleur need <name>` turns a need on for this session, even when no prompt matched it.
- `/souffleur drop <name>` turns a need off again.
- `/souffleur pause` switches every check off for this session.
- `/souffleur init` helps you move over from your own hooks. See [Coming from your own hooks](#coming-from-your-own-hooks).

## Modes

`observe` is the default. Souffleur keeps the ledger, asks the model to reload skills and reports through `/souffleur`, but it never denies a tool call. Calls it would have denied are listed under "Would have denied", so you can see what `enforce` would do before you turn it on.

`enforce` lets gates and duties deny a tool call until the skill it names is loaded. Only your user file `~/.claude/souffleur.json` can set it, with `"mode": "enforce"`. A project file that sets a mode gets an error and is ignored, so a cloned repository can neither switch gates on nor off.

## Coming from your own hooks

If you already keep skills alive with a `SessionStart` or `UserPromptSubmit` hook, or with a standing line in `CLAUDE.md`, running Souffleur next to them doubles every reminder. Souffleur changes none of your files on install. `/souffleur init` goes through them with you, one question at a time:

1. It reads the hooks in `~/.claude/settings.json`, your user and project `CLAUDE.md`, and the memory index of the current project. It also lists the installed skills.
2. A small model proposes skill entries for the config. You answer `Add`, `Skip` or `Stop` for each.
3. For each hook that names a known skill or looks like a skill reload script, you answer `Turn off`, `Keep` or `Show me what to do`.

`Turn off` first copies `settings.json` to `settings.json.bak-souffleur-<date>-<time>`, then removes only that one hook entry. Existing keys in `souffleur.json` stay as they are. `init` never edits a hook script, `CLAUDE.md` or a memory file. It lists passages that name a skill with file and line, and you decide what to do with them.

Where no dialog can answer, for example under `claude -p`, `init` prints the proposals, the config entries as JSON and the steps, and changes nothing.

## What Souffleur reads, stores and costs

- It reads `~/.claude/souffleur.json`, the project's `.claude/souffleur.json` and, only during `/souffleur init`, your `settings.json`, `CLAUDE.md` files and the current project's memory index.
- It writes `~/.claude/souffleur.json` and `settings.json` only after you confirm a change in `/souffleur init`, with a backup of `settings.json` first.
- It keeps the ledger per session in Claude Code's plugin store on your machine. Nothing is sent anywhere except through Claude Code's own model calls.
- Detecting needs costs one small-model call per configured need on each prompt you type, about 0.8 seconds, with a 1.5 second limit after which the prompt goes on without a verdict. A restored skill adds its full text to the context again.

## Limits

- Subagents are not gated. When the session hands work to a subagent while a need is active, the brief has to name the skills the subagent should load, or say `skills: none`.
- Souffleur checks that a skill is loaded and that a duty left its trace. It does not judge how well the model followed a skill.
- A restore request after a compaction in the middle of a long turn rides on the next tool result. Models may treat such notes as untrusted and skip them; in `enforce` the gate still catches the next gated step.
- A skill that does not load after two requests is marked `unavailable` and is neither requested nor gated again in that session.

## Troubleshooting

- The status line says `souffleur: degraded, see /souffleur`: Souffleur could not read its config or an event changed shape after a Claude Code update. `/souffleur` lists what failed.
- No status line at all: your app may not show mod status lines. Use `/souffleur`.
- Please report problems with your Claude Code version (`claude --version`) through the [issue tracker](https://github.com/r4KK4n/skill-souffleur/issues).

## Switching off

- `/souffleur pause` switches every check off for the current session.
- `/plugin uninstall skill-souffleur` removes the mod. Your `~/.claude/souffleur.json` stays where it is, and the backup of `settings.json` stays too.

## Roadmap

- [x] Research and tests on Claude Code 2.1.322 and 2.1.332 ([background](docs/background.md))
- [x] Design document ([docs/design.md](docs/design.md))
- [x] Implementation plan
- [x] Ledger of loaded, truncated and dropped skills
- [x] Restore missing skills after compaction and resume
- [x] Detect from the prompt which skills a task needs
- [x] Block a step until its skills are loaded
- [x] `/souffleur status` command and status line
- [ ] Rules and notes: learned from skills, slips and the user, confirmed in a dialog
- [ ] Install guide and `/souffleur init` to move over from your own hooks
- [ ] First release, installable with `/plugin install`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security problems go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Provided as is, without warranty. Review the code before you install it.
