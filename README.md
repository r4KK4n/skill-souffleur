# skill-souffleur

Keeps Claude Code skills loaded and in use for the whole session, including after the context is compacted or the session is resumed.

In a theatre, the souffleur sits out of sight at the edge of the stage and gives an actor the line they forgot, at the moment they need it. Souffleur does the same for skills: when compaction drops a skill the current task needs, it brings the skill back.

> **Status:** early design. Nothing is installable yet. See the [roadmap](#roadmap) for what is done and what comes next.

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
- [ ] First release, installable with `/plugin install`

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security problems go through [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Provided as is, without warranty. Review the code before you install it.
