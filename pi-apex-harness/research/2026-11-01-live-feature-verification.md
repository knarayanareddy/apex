# Live feature verification — 2026-11-01

**Status: partial; testing is ongoing.** Tested source commit
`00c75667b99753931ad4fb837d89c86c3a402d28` in an isolated macOS scratch copy
with synthetic data and OpenRouter's `nvidia/nemotron-3-ultra-550b-a55b:free`.
No credential is included in this report.

| Check | Observed | Scope |
| --- | --- | --- |
| CLI provider response | Pass | Actual Apex CLI returned the expected marker; no tools invoked. |
| Model-directed file read | Pass | Ring 0 exposed only `read`; model called it and returned synthetic file content. |
| Pinned memory and conversational context | Pass | A synthetic memory-surface fact reached the model; a later turn recalled a synthetic fact from an earlier turn. |
| Episode memory | Pass | A synthetic SQLite episode was seeded in one process, then retrieved after harness restart by a model call to `memory_recall`. |
| Obsidian | Pass | A model call to `obsidian_vault` read a synthetic Markdown note from a dedicated test vault. |
| MCP, ACP, plugins and remaining features | Pending | No live result is claimed here. |

For the read, memory and Obsidian tests, the harness was explicitly restricted
to the named tool and its prefix was re-locked before the test. The memory and
Obsidian tools were exposed directly for this controlled test, rather than via
their normal deferred Codemode discovery path. These results do not qualify the
unrestricted agent, an operator's actual vault, process containment, or
private-state isolation.

The three context turns took 1,033 ms, 943 ms and 827 ms end-to-end; their first
text arrived at 1,006 ms, 885 ms and 765 ms. Memory recall took 3,101 ms and the
Obsidian read took 5,207 ms end-to-end. These are individual observations, not
latency percentiles. The recorded final responses reported zero cost.

Separately, [Linux qualification run 41334921485](https://github.com/knarayanareddy/apex/actions/runs/41334921485)
passed both required Ubuntu lanes on the tested commit. A green run does not
resolve the intermittent browser startup issue or the open isolation blockers.
