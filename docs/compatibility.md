# Compatibility

Souffleur depends on Claude Code's mod API, which is early access and changes between releases. This page lists the behaviour Souffleur relies on and the version each item was verified on. The evidence is in [background.md](background.md).

| Behaviour | Verified on |
|---|---|
| `skill.prompt` fires for the Skill tool and for a typed `/name`, with the plugin skill key `<plugin>:<skill>` | 2.1.332 |
| `skill.prompt` does not fire for the re-attachment after compaction | 2.1.332 |
| `session.compact` runs a hook before and after; `/compact` reports trigger `manual` | 2.1.332 |
| A `context` entry added in `prompt.submit` makes the model invoke the named skills first | 2.1.332 |
| `prompt.compose` sections survive `/compact` | 2.1.322 |
| `$.session.id()` is stable across resume; `/clear` starts a new id without `session.start` | 2.1.332 |
| `$.state` is empty after a resume; `$.store` keeps values across sessions | 2.1.332 |
| `tool.call` carries tool arguments flat on the event and `agentId` for subagent calls | 2.1.332 |
| A hooks module outside `hooks/` can import sibling `.ts` files | 2.1.332 |
