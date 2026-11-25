# Compatibility

Souffleur depends on Claude Code's mod API, which is early access and changes between releases. This page lists the behaviour Souffleur relies on and the version each item was verified on. The evidence is in [background.md](background.md).

| Behaviour | Verified on |
|---|---|
| `skill.prompt` fires for the Skill tool and for a typed `/name`, with the plugin skill key `<plugin>:<skill>` | 2.1.332 |
| `skill.prompt` does not fire for the re-attachment after compaction | 2.1.332 |
| `session.compact` runs a hook before and after; `/compact` reports trigger `manual` | 2.1.332 |
| A `context` entry added in `prompt.submit` makes the model invoke the named skills first (no fixture) | 2.1.332 |
| `prompt.compose` sections survive `/compact` | 2.1.322 |
| `$.session.id()` is stable across resume; `/clear` starts a new id without `session.start` | 2.1.332 |
| `$.state` is empty after a resume; `$.store` keeps values across sessions (no fixture) | 2.1.332 |
| `tool.call` carries tool arguments flat on the event and `agentId` for subagent calls | 2.1.332 |
| A hooks module outside `hooks/` can import sibling `.ts` files (no fixture) | 2.1.332 |
| After `/compact` in the same process, the engine re-attaches the skill with the note "Do NOT re-execute these skills". A plain request to load them again is ignored; a request that names that note and says it does not apply is followed | 2.1.332 |
| A `prompt.submit` `context` entry reaches the model as a hook note on the user's turn, also on the first prompt after `/compact` | 2.1.332 |
| `$.ui.status(text)` shows in headless stream-json output as a `ui_status` system message | 2.1.332 |
| `$.command.register` makes `/souffleur` reach a `command.run` hook with `command: "souffleur"` | 2.1.332 |
| `$.fs.exists` and `$.fs.read` read `~/.claude/souffleur.json` and `<project>/.claude/souffleur.json`; `$.env.get("HOME")` gives the home folder | 2.1.332 |
| `claude plugin test` cannot set `origin`, `command` or `isMeta` on a `prompt.submit` call, and a `session.compact` call carries no `messages`, so the adapter tests treat a prompt without `origin` as typed | 2.1.332 |
| `$.tool.register` adds `mcp__<plugin>__<name>`, served by a `tool.run` hook, and the main model calls it (no fixture) | 2.1.332 |
| `$.model.complete` with `haiku` reads a 43 KB text in about 2 s (no fixture) | 2.1.332 |
| Automatic compaction fires `session.compact` with trigger `auto` (no fixture) | 2.1.332 |
| A `context` entry on a tool result reaches the model, which may still disregard it as untrusted (no fixture) | 2.1.332 |
