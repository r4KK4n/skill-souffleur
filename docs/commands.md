# Commands

Every `/souffleur` command. `/souffleur init` and `/souffleur migrate` are described after the list.

- `/souffleur` or `/souffleur status` shows the mode, one row per skill with its state, the active needs, open duties, and the calls that `observe` mode would have denied.
- `/souffleur need <name>` turns a need on for this session, even when no prompt matched it. A need a prompt started ends by itself after 20 prompts in a row that did not match it (prompts of three words or fewer do not count); a need set this way ends only with `drop`.
- `/souffleur drop <name>` turns a need off again.
- `/souffleur update` installs the newest release now (folder install only; see [updates.md](updates.md#update-notice-and-automatic-update)).
- `/souffleur block <name>` and `/souffleur unblock <name>` turn a skill, note or rule of your standard off or on in this project only; other projects keep it. `/souffleur project` shows what applies here in a few lines: what is blocked, what is only for this project, what `notIn` or `where` turns off, and how many standard skills, notes and rules apply. The blocks live in the `projects` key of `~/.claude/souffleur.json`, keyed by the project's main folder (`"projects": { "/work/app": { "block": ["writing-guide"] } }`); the first change in a run saves `souffleur.json.bak-<time>` beside it.
- Per-project blocks. The top level of `~/.claude/souffleur.json` is the standard for every project. To change it for one repository only, add a block under `projects`, keyed by the repository's main folder:

  ```json
  { "projects": { "/work/app": { "block": ["writing-guide"], "skills": { "app-lint": { "always": true } }, "ignored": ["old-helper"] } } }
  ```

  `block` turns standard skills, notes or rules off there; `skills`, `needs`, `notes` and `rules` add entries for that project only; `ignored` lists project skills you do not want to be asked about. A project file in the repository cannot hold `projects`. Souffleur writes to a block only after your answer: `/souffleur block` and `unblock`, the one question about a project's own skills (`Ignore all here` fills `ignored`), and `/souffleur init`, which offers `This project only` or `Everywhere` for a skill that only this project has. Before the first write of a session it saves `souffleur.json.bak-<time>` beside the file.
- `/souffleur pause` switches Souffleur off for this session: no restore requests, no need detection (so no classifier calls), no turn-end questions, no reading of skill texts, and no gate, duty, rule or brief denial. The ledger keeps tracking loads and compactions. `/souffleur resume` undoes it. A pause belongs to the running session and is not carried over when you resume a session.
- `/souffleur init` asks, skill by skill, how Souffleur should keep each one and writes your answers to `~/.claude/souffleur.json`. See [Setting up your skills](#setting-up-your-skills).
- `/souffleur migrate` goes through your old reload hooks and offers to turn them off. See [Coming from your own hooks](#coming-from-your-own-hooks).
- `/souffleur rule <text>` turns your words into a rule or a note and asks before it keeps anything. See [Rules and notes](config.md#rules-and-notes).
- `/souffleur review` asks about every waiting proposal, one dialog each. Without a dialog it lists them.
- `/souffleur accept <id> [here|project]` keeps a waiting proposal in text mode, everywhere or for this project only. `/souffleur decline <id>` declines one. `rule`, `review`, `accept` and `decline` act only when you type them; a plugin or the model cannot run them.

## Setting up your skills

`/souffleur init` can run at any time: after install, when you add a skill, or when one behaves differently. It asks about the skills in your user file first, then the skills one of your hooks reloads, then up to ten more that a small model picks from the descriptions of all installed skills. A skill that only a project file configures is listed and not asked, because `init` writes the user file. Skills of one plugin that have no setting yet come first, as one question per plugin: `All when the task needs it`, `Don't watch any`, `Ask one by one` or `Decide later`. Every other skill gets its own dialog:

- `From the start`: the skill is needed from the first turn, and Souffleur asks for it after every compaction.
- `Loaded by its own plugin at start (rare)`: a plugin puts the text in at session start itself, for example with a `SessionStart` hook, so Souffleur counts it as loaded and asks for it only after a compaction or a clear. Offered only for plugin skills (`plugin:skill`) whose setting it is or for which it is recommended. Pick it for a plugin that merely lists its skills and the status will say loaded when it is not; `init` warns when the plugin has no such hook.
- `When the task needs it`: the skill is needed once a prompt matches a short description. The dialog shows the proposed description, and text you type under "Other" replaces it.
- `Don't watch`: no entry. A skill with a hand-written gate or duty keeps its entry, and `init` says so.
- `Decide later`: nothing is written for the skill, and the next `/souffleur init` asks again.

Each answer is written as it comes, with every other key in the file left as it was, and the running session uses the new entries at once. A skill your config names but this session does not list shows as `not installed here` and is never requested. Closing a dialog stops `init` (`Decide later` skips only that skill; a dialog for a skill kept as injected has no `Decide later`, so dismissing it stops `init`) and keeps the answers you gave. The closing summary names the installed skills that are not watched and points to `/souffleur migrate` when your settings hold hooks that may do the same job.

## Coming from your own hooks

If you already keep skills alive with a `SessionStart` or `UserPromptSubmit` hook, or with a standing line in `CLAUDE.md`, running Souffleur next to them doubles every reminder. Souffleur changes none of your files on install. `/souffleur migrate` starts with a short explanation of what it does and then asks one question per hook:

1. It reads the hooks in `~/.claude/settings.json`, your user and project `CLAUDE.md`, and the memory index of the current project.
2. A hook is listed when its command or matcher names a configured skill. A hook that points at an installed skill only by its script file name, or that runs a script with `preload`, `reload` or `inject` in its name, is listed too, even when the skill is gone; the dialog marks these as guesses.
3. For each hook you answer `Turn off`, `Keep` or `Show me what to do`.

`Turn off` first copies `settings.json` to `settings.json.bak-souffleur-<date>-<time>` (it never overwrites an older copy), then removes only that one hook entry, and stops if the file changed in the meantime. `Show me what to do` changes nothing and adds the manual steps to the closing report. `migrate` never edits a hook script, `CLAUDE.md` or a memory file. It lists passages that name a configured skill and read like a loading or reminding instruction, with file and line, and you decide what to do with them.

Where no dialog can answer, for example under `claude -p`, both commands print what they would ask, the config entries as JSON and the steps, and change nothing.
