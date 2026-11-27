# skill-souffleur

Keeps Claude Code skills loaded and in use for the whole session, including after the context is compacted or the session is resumed.

In a theatre, the souffleur sits out of sight at the edge of the stage and gives an actor the line they forgot, at the moment they need it. Souffleur does the same for skills: when compaction drops a skill the current task needs, it brings the skill back.

> **Status:** version 0.2.4, released as tag `v0.2.4` (see [Install](#install) and the [roadmap](#roadmap)).
>
> **Early access.** Souffleur is a Claude Code mod: TypeScript that runs inside Claude Code through its mod API, shipped and installed as a plugin. Anthropic still changes that API between releases, so an update of Claude Code can break Souffleur until it is adapted. It is provided as is, with no guarantee of fixes or dates. [docs/compatibility.md](docs/compatibility.md) lists the versions each behaviour was checked on.

## The problem

Claude Code loads a skill's instructions into the context when the skill is invoked. Long sessions compact that context, and the skill text does not reliably come back. Tested on Claude Code 2.1.322 with a 43 KB skill:

- In a running session, compaction re-attaches the skill cut off at 20,000 characters. The model no longer sees the rest.
- When a session is resumed and then compacted, the skill is not re-attached at all.
- Claude Code re-attaches at most 5,000 tokens per skill and 25,000 tokens across all skills. Skills that do not fit the budget are dropped.
- Invoking the skill again restores the full text.

The skill list itself comes back after compaction since Claude Code 2.1.304. What gets lost is the content of skills you already used. The model then keeps working without rules it followed an hour earlier, and nothing tells you. Related upstream reports: [#94564](https://github.com/anthropics/claude-code/issues/94564), [#82144](https://github.com/anthropics/claude-code/issues/82144), [#74990](https://github.com/anthropics/claude-code/issues/74990).

## What Souffleur does

- Keeps a ledger of the skills a session has loaded, and notices when compaction or a resume drops or truncates one.
- Decides from what you are working on which skills the current task needs, and asks the model to load the missing ones by invoking them again.
- Holds back a step, such as writing a file, until the skills that step needs are loaded (in `enforce` mode).
- Shows which skills are active in the session, since when, and why.

You choose the skills and the rules in a configuration file. Souffleur never pastes a full skill text into every prompt.

Souffleur is a Claude Code mod, an in-process plugin. For why, including test results on Claude Code 2.1.322, see [docs/background.md](docs/background.md).

## How it works in a session

You work as usual. Souffleur stays quiet while nothing is missing. You notice it in three places:

- When the task needs a skill that is not loaded, or a compaction has cut one, Souffleur adds a short note to your prompt asking the model to invoke that skill first. The model loads it before it answers.
- The status line shows a summary such as `14:02 · observe · 3 loaded, 1 restoring · ~$0.03`. It starts with the local time (24 hours) of the last activity Souffleur saw in the session: your prompt, a tool call or the end of a turn in the main session, or the session start. When Claude Code dies, the client keeps the last line, so a time that does not move shows a session that is gone. The last part is the estimated cost of the small-model calls Souffleur made in this session, at list price; it is left out while nothing was spent. `/souffleur` also shows the calls, tokens and cost for this session and in total. If your app does not show it, `/souffleur` gives the same summary as a table.
- In `enforce` mode, a step that needs a missing skill is refused once with the reason, and the model loads the skill and tries again.
- An open duty (a step that must be followed by evidence, such as a detector run) is mentioned once in the prompt context when it opens. `/souffleur` lists it for as long as it stays open.

A good way to start: install it, run `/souffleur init`, keep `observe` for a few sessions, and look at `/souffleur` after a compaction. If the ledger matches what you saw, switch to `enforce`.

Instructions you give in the chat still win. If you tell the model not to invoke any skill, it follows you and only mentions Souffleur's request.

## Why your own reload hooks are no longer needed

Hooks that re-inject a skill at session start or remind the model on every prompt run blind: they do not know whether the skill text is still there, so they repeat it when nothing is missing and cannot tell when compaction cut it in the middle of a turn. Souffleur sees each skill load and each compaction as it happens and asks for a skill again only when it is missing or cut. Keeping both doubles every reminder and leaves your rules in two places, which is why `/souffleur init` offers to turn the old hooks off.

## Install

Souffleur needs Claude Code 2.1.332 or later. Type this at the prompt of a terminal session:

```
/plugin install skill-souffleur --marketplace r4KK4n/skill-souffleur
```

Claude Code asks whether to add the marketplace; answer `y`. It then asks for a scope: choose user to cover every project, or project for one repository. Souffleur starts with no configuration. Until you add one, the status line reads `not set up, run /souffleur init`. Souffleur then watches no skill, asks the model to load nothing and denies nothing. It still adds one sentence to the system prompt, registers the `/souffleur` command and the `souffleur_propose` tool, and keeps its session copy in the plugin store.

`/plugin` exists only in the terminal interface. In a Remote Control session from the desktop or mobile app it is not available ("Plugins aren't available in this environment"). Install from a shell on the machine that runs Claude Code instead:

```
claude plugin marketplace add r4KK4n/skill-souffleur
claude plugin install skill-souffleur@skill-souffleur --scope user
```

New sessions load it. A running session picks it up after `/reload-plugins` or a restart.

### Update

```
claude plugin marketplace update skill-souffleur
claude plugin update skill-souffleur@skill-souffleur
```

Restart Claude Code afterwards. Every change that users notice raises the plugin version, so the update finds it. If Claude Code is newer than the version Souffleur was checked on, `/souffleur` says so in one line.

### Updates without a restart

An installed plugin reaches a running session only after `/reload-plugins` or a restart, and `/reload-plugins` is not available in Remote Control sessions. Claude Code also loads a plugin from a folder under `~/.claude/skills/` and watches that folder, so a running session reloads Souffleur when its files change (checked on 2.1.332, see [docs/compatibility.md](docs/compatibility.md)). Install it there from a release tag instead of the marketplace:

```
claude plugin uninstall skill-souffleur@skill-souffleur
git clone --branch v0.2.4 https://github.com/r4KK4n/skill-souffleur ~/.claude/skills/skill-souffleur
```

Update to a newer release:

```
cd ~/.claude/skills/skill-souffleur && git fetch --tags && git checkout <tag>
```

Every running session picks up the new version, usually within half a minute. Use release tags only, never `main`: a release with a fault would reach every running session at once. To go back, check out the previous tag. A session that was already running when the folder was created does not see it; start that one once more.

### Update notice and automatic update

Souffleur looks up the newest release tag once a day, in the background, and shows one line at the next session start: `Souffleur 0.2.4 is out (you run 0.2.3). /souffleur update installs it.` (`/plugin update installs it.` for the marketplace install). Only tags shaped `vX.Y.Z` count, and only a newer one than the version you run. The look-up never delays a session start, and a failed one stays silent and is tried again after a day. `/souffleur` shows the version, the newest release, when it was checked and the setting.

The setting `update` in `~/.claude/souffleur.json` (user file only):

- `"notify"` (default): the line above.
- `"auto"`: at session start, after the first line, Souffleur installs a newer release when its tag is signed by your key. It says `Souffleur updated to 0.2.4 (tag signed by your key).` A tag that is unsigned or signed by another key is not installed.
- `"off"`: no look-up and no line.

```json
{
  "update": "auto",
  "updateSigner": "ssh-ed25519 AAAA... you@example"
}
```

`updateSigner` is the public SSH key line (one line, starting with `ssh-`, `ecdsa-` or `sk-`) of the key that signs your releases. It is also user file only. Without it, `auto` shows the notify line plus `Set updateSigner to let auto install it.` and installs nothing.

`/souffleur update` installs the newest release now. With `updateSigner` set it verifies the tag first and refuses one that does not verify. Without `updateSigner` it installs the tag unsigned, because you asked, and the answer says `(unsigned; you asked for it)`. Running sessions pick the new version up at their next turn.

Both ways change only a folder install. They leave the folder alone, and say why, when it has uncommitted changes or when its checkout is not exactly a `vX.Y.Z` tag (for example your own commits or a branch). In a marketplace install, `/souffleur update` answers `run /plugin update`.

How release tags are signed: the maintainer of a release signs the tag with an SSH key, and you list the matching public key as `updateSigner`.

```
git config gpg.format ssh
git config user.signingkey ~/.ssh/<key>.pub
git tag -s v0.2.4 -m "release 0.2.4"
git verify-tag v0.2.4
```

Set these in the repository, not globally. For the check, `git verify-tag` needs an `allowed_signers` file; Souffleur writes one into its own data folder, with the line `souffleur namespaces="git" <updateSigner>`, each time it verifies.

Use one install method, not both. While the marketplace plugin is installed, Claude Code does not load the folder at all: the installed plugin keeps the name `skill-souffleur`. The folder install keeps its own stored data. Copy the old store file if you want to keep it: in `~/.claude/plugins/store/`, the marketplace install writes `skill-souffleur_skill-souffleur-<hash>.json` and the folder install `skill-souffleur_skills-dir-<hash>.json`. Without the copy, skill texts are read again once, earlier proposals can come back (decline them again with `/souffleur decline <id>`), and a session resumed after the switch starts with an empty ledger.

## Quick start

Create `~/.claude/souffleur.json`, or let `/souffleur init` write it for you:

```json
{
  "mode": "observe",
  "skills": {
    "terse:terse-mode": { "always": true, "for": "chat", "reply": { "maxChars": 800, "headings": 0 } },
    "writing-guide": { "need": "prose" },
    "ui-checklist": { "need": "ui" }
  },
  "needs": {
    "prose": { "for": "readers", "what": "Writing text people read: docs, specs, plans, issues." },
    "ui": { "for": "users", "what": "Designing or building something a user sees." }
  }
}
```

Each need names who receives the output its skills shape, in `for`: `chat` (your replies in the session), `readers` (texts other people read), `users` (what users of a product see) or `work` (how the agent works, nobody reads it). `what` is the description of 1 to 200 characters that the classifier uses for `work` needs; a `readers` or `users` need starts from what the prompt produces (a text for others, a screen) or from tool evidence, and its `what` is not matched. A need with `for: "chat"` starts only with `/souffleur need` and gets a config warning. The name `none` is reserved and dropped. The old form, a plain string, still works and counts as `work`. An always-on skill carries `for` itself; `for` on any other skill is an error and ignored. An object need with an invalid or missing `for` counts as `work` and reports an error. A skill in the user file can list `"notIn": ["/path/to/repo"]`: in those project roots it is excluded. `notIn` is compared without trailing slashes and is only read from the user file. The request to load skills names each skill with its audience, so a writing skill for docs does not change your replies in the chat; a skill excluded by `notIn` is not requested or gated there, and `/souffleur` shows it as `excluded in this project`. `/souffleur` lists under "Audience not set:" a need written as a plain string (`<need>: no audience set; add "for" to it in ~/.claude/souffleur.json`) and an always-on skill without `for` (`<skill>: always on without "for"; add "for": "chat" if it shapes your replies in this chat`).

An always-on skill with `"for": "chat"` can add `"reply": { "maxChars": 800, "headings": 0 }` (`maxChars` 200 to 20000, `headings` 0 to 20, both optional). After each answer in the main session Souffleur measures the reply without code blocks and counts heading lines. When a reply is over a limit, the next prompt carries one reminder line (at most once per five prompts), and `/souffleur` shows `<skill>: <v> of <t> replies over the limit`. Both modes only remind; nothing is denied. Only one chat skill can carry `reply`, and it needs `maxChars` or `headings`. Replies to typed commands, aborted turns and replies that are mostly code are not checked.

A skill with `"always": true` is needed from the first turn. A skill with `"need"` is needed once its need starts: a `work` need when a prompt starts that kind of work, a `readers` or `users` need when a prompt asks for a text or a screen, or when a matching tool call (a gated path, `gh issue`, `gh pr`) shows one is being made. After a compaction or a resume, Souffleur asks the model to load the `chat`, `work` and always-on skills again. `readers` and `users` needs wait, together with their notes, until the next prompt or tool call that asks for their deliverable; `/souffleur` shows them as waiting since compaction. A project can add its own `.claude/souffleur.json`, but it cannot change your entries or your mode. Its skills and needs are report only until you list the project root in `trustProjects` in your user file: for any other project Souffleur neither asks the model to load them nor names them in the system prompt, and they cannot deny a call. `/souffleur` still lists them. A project file may define 20 skills and 10 needs at most; more get an error that names the cap. Roots in `trustProjects` are compared without trailing slashes.

If you edit a config file by hand, new entries apply after `/souffleur` (it reads both files again) or in a new session. The full format, including gates and duties, is in [docs/design.md](docs/design.md#configuration). A gate cannot name the `Skill` tool, because it would block loading its own skill.

## Commands

- `/souffleur` or `/souffleur status` shows the mode, one row per skill with its state, the active needs, open duties, and the calls that `observe` mode would have denied.
- `/souffleur need <name>` turns a need on for this session, even when no prompt matched it. A need a prompt started ends by itself after 20 prompts in a row that did not match it (prompts of three words or fewer do not count); a need set this way ends only with `drop`.
- `/souffleur drop <name>` turns a need off again.
- `/souffleur update` installs the newest release now (folder install only; see [Update notice and automatic update](#update-notice-and-automatic-update)).
- `/souffleur block <name>` and `/souffleur unblock <name>` turn a skill, note or rule of your standard off or on in this project only; other projects keep it. `/souffleur project` shows what applies here in a few lines: what is blocked, what is only for this project, what `notIn` or `where` turns off, and how many standard skills, notes and rules apply. The blocks live in the `projects` key of `~/.claude/souffleur.json`, keyed by the project's main folder (`"projects": { "/work/app": { "block": ["writing-guide"] } }`); the first change in a run saves `souffleur.json.bak-<time>` beside it.
- Per-project blocks. The top level of `~/.claude/souffleur.json` is the standard for every project. To change it for one repository only, add a block under `projects`, keyed by the repository's main folder:

  ```json
  { "projects": { "/work/app": { "block": ["writing-guide"], "skills": { "app-lint": { "always": true } }, "ignored": ["old-helper"] } } }
  ```

  `block` turns standard skills, notes or rules off there; `skills`, `needs`, `notes` and `rules` add entries for that project only; `ignored` lists project skills you do not want to be asked about. A project file in the repository cannot hold `projects`. Souffleur writes to a block only after your answer: `/souffleur block` and `unblock`, the one question about a project's own skills (`Ignore all here` fills `ignored`), and `/souffleur init`, which offers `This project only` or `Everywhere` for a skill that only this project has. Before the first write of a session it saves `souffleur.json.bak-<time>` beside the file.
- `/souffleur pause` switches Souffleur off for this session: no restore requests, no need detection (so no classifier calls), no turn-end questions, no reading of skill texts, and no gate, duty, rule or brief denial. The ledger keeps tracking loads and compactions. `/souffleur resume` undoes it. A pause belongs to the running session and is not carried over when you resume a session.
- `/souffleur init` asks, skill by skill, how Souffleur should keep each one and writes your answers to `~/.claude/souffleur.json`. See [Setting up your skills](#setting-up-your-skills).
- `/souffleur migrate` goes through your old reload hooks and offers to turn them off. See [Coming from your own hooks](#coming-from-your-own-hooks).
- `/souffleur rule <text>` turns your words into a rule or a note and asks before it keeps anything. See [Rules and notes](#rules-and-notes).
- `/souffleur review` asks about every waiting proposal, one dialog each. Without a dialog it lists them.
- `/souffleur accept <id> [here|project]` keeps a waiting proposal in text mode, everywhere or for this project only. `/souffleur decline <id>` declines one. `rule`, `review`, `accept` and `decline` act only when you type them; a plugin or the model cannot run them.

## Modes

`observe` is the default. Souffleur keeps the ledger, asks the model to reload skills and reports through `/souffleur`, but it never denies a tool call. Calls it would have denied are listed under "Would have denied", so you can see what `enforce` would do before you turn it on.

`enforce` lets gates and duties deny a tool call until the skill it names is loaded. Only your user file `~/.claude/souffleur.json` can set it, with `"mode": "enforce"`. A project file that sets a mode gets an error and is ignored, so a cloned repository can neither switch gates on nor off.

## Notices

Souffleur writes short lines that start with `Souffleur:` into the transcript, so you see what it did in the desktop and mobile apps too: a summary at session start, what a compaction cut and when the skills are back, and a problem once until it clears. The model does not see them. `"notices": false` in your user file turns them off; a project file cannot change it.

## Rules and notes

Some instructions have a trace Souffleur can see, and others are standing wishes. Souffleur keeps both in the user file, next to the skills, and asks you before it keeps anything.

A rule has one of three shapes. `before` with `skill` means a matching call waits until that skill is loaded. `before` with `field` means a matching call must carry that argument, for example a `model` on every `Agent` call. `after` with `evidence` means a matching call opens the rule, and a later call that matches the evidence closes it. In `observe` a broken rule is listed under "Would have denied". In `enforce` a skill rule denies every matching call until the skill is loaded (the call that loads the skill is never denied), while a field rule and an after rule deny once and let the retry pass, so a wrong rule cannot trap a session. `/souffleur pause` switches rules off with everything else. A note is never checked. Notes without a `need` go into the system prompt section (2,000 characters at most), notes with a `need` go into the prompt context when that need first matches and again after each compaction.

```json
{
  "rules": [
    { "id": "agent-names-model", "before": { "tools": ["Agent"] }, "field": "model", "source": "slip" },
    { "id": "test-after-edit", "after": { "tools": ["Edit"], "paths": ["src/**"] }, "evidence": { "tool": "Bash", "command": "npm test" }, "source": "user" }
  ],
  "notes": [
    { "id": "reply-language", "text": "Reply to the user in German, briefly.", "source": "user" }
  ]
}
```

Only the user file may hold `rules` and `notes`. A project file that has them gets an error for those keys, because a cloned repository must not deny calls or write into your system prompt. `where` limits an entry to one project and names the main repository root, so a rule made in one worktree holds in the others.

Proposals come from the model and from you. The model calls the tool `souffleur_propose` only for a standing instruction of yours that holds beyond the current task (a note), or when something went wrong that a checkable rule would have caught (a rule); never for facts about one task, issue or file, and a note never comes from a slip. `/souffleur rule <text>` does the same for your own words. A proposal waits in a queue of at most 20. At the end of a turn in a session with a person at the prompt, Souffleur asks about the first one, with `Yes, everywhere`, `Yes, this project only` and `No`. Text typed under "Other" goes to the model with your next prompt as a request to revise the proposal. A declined proposal is remembered and not proposed again. The queue belongs to the session. Where no dialog opens (or nobody answers it within two minutes), Souffleur shows the first waiting proposal as a notice in the transcript instead. Reply `accept` (`annehmen`) to add it everywhere, or `decline` (`ablehnen`); the reply counts only as your very next prompt and only when it is the whole text. `/souffleur accept <id> here` stays for one project. Under `claude -p` nothing can be answered by a reply: proposals stay queued for `/souffleur review` and `/souffleur accept <id>`, and the notice names that command. The model may make five proposals per session, and a subagent may make none. Once you decline a proposal or dismiss its dialog, the model proposes nothing more in that session. An unanswered or unshowable offer does not stop it: a dialog that cannot open or times out, a reply notice that your next prompt ends, and an accept leave proposals open. The stop survives a reload and a resume, a new session or `/clear` starts without it, and `/souffleur rule <text>` and `/souffleur review` keep working. Rule strings are one line without control characters, with at most 20 list items. Souffleur writes an entry to `~/.claude/souffleur.json` only after your yes, reads the file fresh first, stops when it cannot read it, and keeps every other key.

`/souffleur migrate` also queues the standing instructions it finds in your `CLAUDE.md` files and memory index as note proposals, with or without a dialog. The question names the file and line, and offers `Yes, this project only` first for a passage from the project's own files. The report says how many passages were skipped and why. 

Souffleur also reads your skills. This needs your user file and a session with a person at the prompt, and it stops under `/souffleur pause`. When the main session loads a skill whose file Souffleur has not seen, a small model looks for obligations the skill states about itself, such as "always run `npm test` after editing files under `src/`", and queues up to three as proposals named `skill:<name>`. The question starts with "Read from a skill's text, not verified:" and names the skill, the plugin or the project skill it came from. A skill version counts as read once its proposals were answered (yes, no, or a request to change one). If the session ends or `/clear` runs before that, the version is read again the next time the skill loads, at most three times in all. At most five skill texts are read per session (`/clear` starts a new session with five more); at most six skill proposals wait at once, and your own proposals come first. Skills from a project or an MCP server are read only when the project is in `trustProjects`. Skills a subagent loads are skipped, but a background subagent that loads a skill while the main session loads nothing can be read as the main session, because the load event does not say who loaded it. Each read sends the skill file, up to 60,000 characters, to the small model with a limit of 30 seconds, so to switch this off set `"learn": { "skills": false }` in `~/.claude/souffleur.json`. Nothing is written without your yes.

## Setting up your skills

`/souffleur init` can run at any time: after install, when you add a skill, or when one behaves differently. It asks about the skills in your user file first, then the skills one of your hooks reloads, then up to ten more that a small model picks from the descriptions of all installed skills. A skill that only a project file configures is listed and not asked, because `init` writes the user file. You answer one dialog per skill:

- `From the start`: the skill is needed from the first turn, and Souffleur asks for it after every compaction.
- `Loaded by its own plugin at start (rare)`: a plugin puts the text in at session start itself, for example with a `SessionStart` hook, so Souffleur counts it as loaded and asks for it only after a compaction or a clear. Offered last, for plugin skills (`plugin:skill`) only. Pick it for a plugin that merely lists its skills and the status will say loaded when it is not; `init` warns when the plugin has no such hook.
- `When the task needs it`: the skill is needed once a prompt matches a short description. The dialog shows the proposed description, and text you type under "Other" replaces it.
- `Don't watch`: no entry. A skill with a hand-written gate or duty keeps its entry, and `init` says so.

Each answer is written as it comes, with every other key in the file left as it was, and the running session uses the new entries at once. A skill your config names but this session does not list shows as `not installed here` and is never requested. Closing a dialog stops `init` and keeps the answers you gave. The closing summary names the installed skills that are not watched and points to `/souffleur migrate` when your settings hold hooks that may do the same job.

## Coming from your own hooks

If you already keep skills alive with a `SessionStart` or `UserPromptSubmit` hook, or with a standing line in `CLAUDE.md`, running Souffleur next to them doubles every reminder. Souffleur changes none of your files on install. `/souffleur migrate` starts with a short explanation of what it does and then asks one question per hook:

1. It reads the hooks in `~/.claude/settings.json`, your user and project `CLAUDE.md`, and the memory index of the current project.
2. A hook is listed when its command or matcher names a configured skill. A hook that points at an installed skill only by its script file name, or that runs a script with `preload`, `reload` or `inject` in its name, is listed too, even when the skill is gone; the dialog marks these as guesses.
3. For each hook you answer `Turn off`, `Keep` or `Show me what to do`.

`Turn off` first copies `settings.json` to `settings.json.bak-souffleur-<date>-<time>` (it never overwrites an older copy), then removes only that one hook entry, and stops if the file changed in the meantime. `Show me what to do` changes nothing and adds the manual steps to the closing report. `migrate` never edits a hook script, `CLAUDE.md` or a memory file. It lists passages that name a configured skill and read like a loading or reminding instruction, with file and line, and you decide what to do with them.

Where no dialog can answer, for example under `claude -p`, both commands print what they would ask, the config entries as JSON and the steps, and change nothing.

## What Souffleur reads, stores and costs

Reads:

- `~/.claude/souffleur.json` and the project's `.claude/souffleur.json`, at session start and on every `/souffleur` command.
- The text of each skill the main session loads, for learning (see [Rules and notes](#rules-and-notes)): the skill file at its path, up to 60,000 characters, sent to the small model. This needs your user file and stops under `/souffleur pause` or `"learn": { "skills": false }`.
- Only during `/souffleur init` and `/souffleur migrate`: your `~/.claude/settings.json`, your user and project `CLAUDE.md` files, the files those import with `@path` (one level), and the current project's memory index. `init` also reads `~/.claude/plugins/installed_plugins.json` and the `hooks/hooks.json` and `.claude-plugin/plugin.json` of an installed plugin, to find out whether a plugin skill is loaded by a `SessionStart` hook.

Writes:

- `/souffleur init` writes `~/.claude/souffleur.json` after each of your answers, and so does a yes to a rule or note proposal. `/souffleur migrate` writes `settings.json` only after you answer `Turn off`, with a backup copy first.

Stores, in Claude Code's plugin store on your machine:

- `session:<id>`: the ledger, active needs, open duties, waiting proposals and errors of one session, stamped with the time it was stored. At session start Souffleur removes `session:*` entries that were not stored for 30 days.
- `souffleur:declined`: the hashes of the last 200 proposals you declined, so they are not proposed again.
- `souffleur:skill-hash:<hash>`: one small entry per skill version that was read, with its state (done, offered or failed). These stay.

Nothing is sent anywhere except through Claude Code's own model calls.

Costs:

- Detecting needs costs two small-model calls on each prompt you type, run in parallel: call A asks what the prompt will produce (budget 2.5 seconds, a `chat-reply` starts nothing) and call B picks a `work` need, awaited only for code work (budget 4 seconds). A call that runs out of time means no new need for that prompt. Needs from a project file that is not trusted are not classified.
- `/souffleur` shows the small-model calls, their tokens and an estimated cost at list price; the figure is an estimate, not a bill.
- Reading a skill costs one small-model call of up to 30 seconds in the background, at most five per session.
- A restored skill adds its full text to the context again. The restore request and the notes of one prompt stay under 10,000 characters together; skills that do not fit stay `absent` or `stale` in `/souffleur` and are asked for on a later prompt.

## Limits

- Subagents are not gated. When the session hands work to a subagent while a need is active or an always-on skill that is not `for: chat` applies, the brief has to name the skills the subagent should load, or say `skills: none`.
- Souffleur checks that a skill is loaded and that a duty left its trace. It does not judge how well the model followed a skill.
- A restore request after a compaction in the middle of a long turn rides on the next tool result. Models may treat such notes as untrusted and skip them; in `enforce` the gate still catches the next gated step.
- A skill that does not load after two requests is marked `unavailable` and is neither requested nor gated again in that session.
- The dialogs of `/souffleur init`, `/souffleur migrate` and the turn-end question were tested with the test kit and in the desktop app's dialog. `init`, `migrate` and the proposal dialogs have not yet run end to end in a live session; that first live run is pending. Where no dialog can open, the commands print what they would ask and change nothing.

## Troubleshooting

- The status line says `degraded, see /souffleur`: Souffleur could not read its config, an event changed shape after a Claude Code update, or the small model failed three times in a row (for need detection or for reading skills). `/souffleur` lists what failed, and one good call clears a model error. Other errors clear once the step that failed works again.
- No status line at all: your app may not show mod status lines. Use `/souffleur`.
- Please report problems with your Claude Code version (`claude --version`) through the [issue tracker](https://github.com/r4KK4n/skill-souffleur/issues).

## Switching off

- `/souffleur pause` switches Souffleur off for the current session, and `/souffleur resume` switches it on again.
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
- [x] Rules and notes: from slips and the user's own words, confirmed in a dialog
- [x] Learn rules from the text of the user's skills
- [x] `/souffleur init` per skill and `/souffleur migrate` for old hooks
- [x] Install guide
- [x] Skill audiences (`for`, `notIn`)
- [x] Needs by deliverable
- [x] Reply check
- [x] Short notices in the transcript for start, compaction and problems
- [x] Release tags `v0.1.0` to `v0.2.4`
- [x] Updates that reach running sessions (install from a folder)
- [x] Update notice and signed automatic update

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security problems go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Provided as is, without warranty. Review the code before you install it.
