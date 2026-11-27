# Configuration

The reference for `~/.claude/souffleur.json` (the user file) and a project's `.claude/souffleur.json`. The [README](../README.md) has the quick start. For how the parts work together, see [design.md](design.md).

## Where the user file lives

The user file sits in your Claude folder: `~/.claude` (`%USERPROFILE%\.claude` on Windows, where `HOME` is not set), or the folder named by `CLAUDE_CONFIG_DIR` when that is set. Souffleur reads `CLAUDE.md`, the memory index and `plugins/installed_plugins.json` there, writes its own `souffleur.json` and backups there, and writes `settings.json` only through `/souffleur migrate` after your answer. `CLAUDE_CONFIG_DIR` counts only as an absolute folder (not the root); a relative, blank or root value is ignored and `~/.claude` is used. Plugin ownership checks look in both the configured folder and `~/.claude/plugins`.

If you set `CLAUDE_CONFIG_DIR` after you already had a file in `~/.claude`, and `<CLAUDE_CONFIG_DIR>/souffleur.json` does not exist, Souffleur keeps using `~/.claude/souffleur.json` so your setup does not disappear. `/souffleur` then shows once per session: `Config: using ~/.claude/souffleur.json; CLAUDE_CONFIG_DIR is <dir>. Move the file there to follow it.` Souffleur never moves or copies the file itself. Once `<CLAUDE_CONFIG_DIR>/souffleur.json` exists, it wins and the old file is ignored.

## Skills and needs

A skill entry says when Souffleur needs it. A need is a kind of work, named by you, that a skill serves (for example `prose` for writing). A gate holds back a step, such as a file write, until the skill is loaded. A duty requires evidence after a step, such as a detector run. The classifier is the small model that Claude Code runs for Souffleur. Each prompt sends it at most 2,000 characters (the first 1,500 and the last 500), and it is not called, after three failures in a row, for the next 10 prompts.

An example file (`/souffleur init` writes the entries for you):

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

Each need names who receives the output its skills shape, in `for`:

- `chat`: your replies in the session.
- `readers`: texts other people read.
- `users`: what users of a product see.
- `work`: how the agent works, nobody reads it.

More on needs and audiences:

- `what` is the description of 1 to 200 characters that the classifier uses for `work` needs. A `readers` or `users` need starts from what the prompt produces (a text for others, a screen) or from tool evidence, and its `what` is not matched.
- A need with `for: "chat"` starts only with `/souffleur need` and gets a config warning. The name `none` is reserved and dropped.
- The old form, a plain string, still works and counts as `work`. An object need with an invalid or missing `for` counts as `work` and reports an error.
- An always-on skill carries `for` itself; `for` on any other skill is an error and ignored.
- A skill in the user file can list `"notIn": ["/path/to/repo"]`: in those project roots it is excluded. `notIn` is compared without trailing slashes and is only read from the user file. A skill excluded this way is not requested or gated there, and `/souffleur` shows it as `excluded in this project`.
- The request to load skills names each skill with its audience, so a writing skill for docs does not change your replies in the chat.
- `/souffleur` lists under "Audience not set:" a need written as a plain string (`<need>: no audience set; add "for" to it in ~/.claude/souffleur.json`) and an always-on skill without `for` (`<skill>: always on without "for"; add "for": "chat" if it shapes your replies in this chat`).

An always-on skill with `"for": "chat"` can add `"reply": { "maxChars": 800, "headings": 0 }` (`maxChars` 200 to 20000, `headings` 0 to 20, both optional). After each answer in the main session Souffleur measures the reply without code blocks and counts heading lines. When a reply is over a limit, the next prompt carries one reminder line (at most once per five prompts), and `/souffleur` shows `<skill>: <v> of <t> replies over the limit`. Both modes only remind; nothing is denied. Only one chat skill can carry `reply`, and it needs `maxChars` or `headings`. Replies to typed commands, aborted turns and replies that are mostly code are not checked.

A skill with `"always": true` is needed from the first turn. A skill with `"need"` is needed once its need starts:

- A `work` need starts when a prompt starts that kind of work.
- A `readers` or `users` need starts when a prompt asks for a text or a screen, or when a matching tool call (a gated path, `gh issue`, `gh pr`) shows one is being made.

After a compaction or a resume, Souffleur asks the model to load the `chat`, `work` and always-on skills again. `readers` and `users` needs wait, together with their notes, until the next prompt or tool call that asks for their deliverable; `/souffleur` shows them as waiting since compaction.

A project can add its own `.claude/souffleur.json`, but it cannot change your entries or your mode.

- Its skills and needs are report only until you list the project root in `trustProjects` in your user file. For any other project Souffleur neither asks the model to load them nor names them in the system prompt, and they cannot deny a call. `/souffleur` still lists them.
- A project file may define 20 skills and 10 needs at most; more get an error that names the cap.
- Roots in `trustProjects` are compared without trailing slashes.

If you edit a config file by hand, new entries apply after `/souffleur` (it reads both files again) or in a new session. The full format, including gates and duties, is in [design.md](design.md#configuration). A gate cannot name the `Skill` tool, because it would block loading its own skill.

## Modes

`observe` is the default. Souffleur keeps the ledger, asks the model to reload skills and reports through `/souffleur`, but it never denies a tool call. Calls it would have denied are listed under "Would have denied", so you can see what `enforce` would do before you turn it on.

`enforce` lets gates and duties deny a tool call until the skill it names is loaded. Only your user file `~/.claude/souffleur.json` can set it, with `"mode": "enforce"`. A project file that sets a mode gets an error and is ignored, so a cloned repository can neither switch gates on nor off.

### What enforce does not cover

`enforce` is advisory. A gate sees only the tool calls it names, so these writes pass a `Write` gate:

- A `Bash` command that writes a file, such as a redirect (`echo x > file`) or `sed -i`.
- A file tool that comes from an MCP server, because its tool name is not `Write` or `Edit`.
- Any write a subagent makes, because subagents are not gated. The brief check asks the main session to name the skills a subagent should load, and nothing checks that the subagent does.

Gates and duties also release a stuck skill after three denials in a turn, and a field rule or an `after` rule denies once and lets the retry pass. If a rule has to hold against all of these, `enforce` is the wrong tool for it. See [design.md](design.md#gates-and-duties) for how denials work.

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

Proposals come from the model and from you.

- The model calls the tool `souffleur_propose` only for a standing instruction of yours that holds beyond the current task (a note), or when something went wrong that a checkable rule would have caught (a rule). It never proposes facts about one task, issue or file, and a note never comes from a slip. `/souffleur rule <text>` does the same for your own words.
- A proposal waits in a queue of at most 20. The queue belongs to the session.
- At the end of a turn in a session with a person at the prompt, Souffleur asks about the first one, with `Yes, everywhere`, `Yes, this project only` and `No`. Text typed under "Other" goes to the model with your next prompt as a request to revise the proposal. A declined proposal is remembered and not proposed again.
- Where no dialog opens (or nobody answers it within two minutes), Souffleur shows the first waiting proposal as a notice in the transcript instead. Reply `accept` to add it everywhere, or `decline` (the German words `annehmen` and `ablehnen` work too). The reply counts only as your very next prompt and only when it is the whole text. `/souffleur accept <id> here` keeps it for one project.
- Under `claude -p` nothing can be answered by a reply. Proposals stay queued for `/souffleur review` and `/souffleur accept <id>`, and the notice names that command.
- The model may make five proposals per session, and a subagent may make none. Once you decline a proposal or dismiss its dialog, the model proposes nothing more in that session. An unanswered or unshowable offer does not stop it: a dialog that cannot open or times out, a reply notice that your next prompt ends, and an accept leave proposals open. The stop survives a reload and a resume. A new session or `/clear` starts without it, and `/souffleur rule <text>` and `/souffleur review` keep working.
- Rule strings are one line without control characters, with at most 20 list items. Souffleur writes an entry to `~/.claude/souffleur.json` only after your yes, reads the file fresh first, stops when it cannot read it, and keeps every other key.

`/souffleur migrate` also queues the standing instructions it finds in your `CLAUDE.md` files and memory index as note proposals, with or without a dialog. The question names the file and line, and offers `Yes, this project only` first for a passage from the project's own files. The report says how many passages were skipped and why.

Souffleur also reads your skills. This needs your user file and a session with a person at the prompt, and it stops under `/souffleur pause`.

- When the main session loads a skill whose file Souffleur has not seen, a small model looks for obligations the skill states about itself, such as "always run `npm test` after editing files under `src/`", and queues up to three as proposals named `skill:<name>`.
- The question starts with "Read from a skill's text, not verified:" and names the skill, the plugin or the project skill it came from.
- A skill version counts as read once its proposals were answered (yes, no, or a request to change one). If the session ends or `/clear` runs before that, the version is read again the next time the skill loads, at most three times in all.
- At most five skill texts are read per session (`/clear` starts a new session with five more). At most six skill proposals wait at once, and your own proposals come first.
- Skills from a project or an MCP server are read only when the project is in `trustProjects`. Skills that an agent loads are skipped.
- Each read sends the skill file, up to 60,000 characters, to the small model with a limit of 30 seconds. To switch this off, set `"learn": { "skills": false }` in `~/.claude/souffleur.json`.

Nothing is written without your yes.
