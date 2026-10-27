# Recommendations implementation release record

**Date:** 2026-10-27  
**Implementation specification:** [`recommendations-implementation-spec.md`](../recommendations-implementation-spec.md)  
**Assessment:** [`pi-apex-capability-and-upstream-assessment-2026-10-27.md`](pi-apex-capability-and-upstream-assessment-2026-10-27.md)

## Outcome

Phases A–F are implemented and the full local regression suite passed. This record describes tests against temporary fixtures, fake providers, and local services where noted. It does **not** claim arbitrary real models will follow browsing/skill guidance, does not claim live cloud-provider authentication was tested, and does not certify the operator's real Obsidian vault.

## Implemented

- **A — accurate claims:** Quickstart, architecture/spec notes and integration docs distinguish automatic, explicit, deferred and simulated behavior. Cache-hit telemetry is not described as an application-owned persistent prompt cache. T3 Code remains comparison-only absent source-level reuse evidence.
- **B — progressive skill loading:** `skill_access` lists compact metadata without bodies and explicitly reads a selected, active, canonical workspace skill. Files are re-enumerated and opened beneath a rooted descriptor; content is freshly threat-scanned after reading, secret-scrubbed, returned as untrusted JSON, and audited by hash without persisting the body. Stale/quarantined/archived/external skills are not loadable; scripts are never executed. Deferred schema/prefix remains unchanged.
- **C — browser guidance:** concise boot guidance says to discover/use `browser_control` for explicit research/current-fact requests when possible and disclose inability to browse. A deterministic faux-provider fixture chooses browser tooling for a browse request; a separate stable/local fixture chooses not to browse. This verifies the tool path and test fixture behavior only—not an intent classifier or real-model compliance. No universal search or citation guarantee is made.
- **D — Obsidian:** `--obsidian-vault <dir>` is optional and disabled by default. The opt-in tool is local, read-only, Markdown-only and bounded; native descriptor-relative opens reject root/note symlinks and traversal. Hidden/config paths, non-Markdown files, writes and network access are excluded; supported secrets are scrubbed; note text is labeled untrusted. API/UI status reports enabled/disabled and read-only/Markdown-only without revealing the absolute vault path.
- **E — episode recall:** `memory_recall` explicitly queries bounded, same-workspace SQLite FTS5 episode summaries and returns historical, untrusted evidence. It is not automatic injection and remains distinct from `/dream` next-boot `MEMORY.md` consolidation.
- **F — verification:** focused tests and complete regression run completed; implementation spec updated to reflect the shipped privacy boundary and verified status.

## Verification record

Final full-suite command (exit code 0):

```sh
PI_APEX_CHROMIUM_BIN=/home/user/.cache/ms-playwright/chromium-1248/chrome-linux64/chrome \
  npx -y -p node@22 -c 'npm test'
```

This ran native bridge build, TypeScript typecheck, Tier A, Tier B, and Rings 1–12. The run passed, including the Chromium-backed UI/browser tests, with the existing active schema/prefix invariants unchanged (`1,073` schema tokens in the reported checks). Focused `typecheck`, Ring 2, Ring 3, Ring 4, and Ring 5 runs also passed after the relevant changes. Ring 5 verifies the default-disabled Obsidian status in the Settings UI/API. Ring 3 covers deferred dispatch, skill metadata/body separation, explicit supporting-text selection, malicious skill rejection, historical recall, and Obsidian list/search/read plus traversal/symlink/hidden/non-Markdown/no-vault cases.

The first full-suite attempt stopped at Ring 7 because Chromium existed in the local Playwright cache but was not on `PATH`; setting `PI_APEX_CHROMIUM_BIN` to the cached executable resolved the environment issue, and both Ring 7 alone and the subsequent complete suite passed. This was an environment discovery, not a source-code failure.

## Manual/live checklist

| Check | Expected | Actual |
|---|---|---|
| Default Obsidian state in Settings/API | Clearly disabled; no absolute path exposed | Passed in Ring 5 UI/API assertions |
| Explicit vault CLI configuration | Relative path resolves against final workspace; empty path rejected | Passed in Ring 4 parser tests |
| Vault read boundary | List/search/read only bounded Markdown, relative provenance, no traversal/symlink/hidden/non-Markdown access | Passed in Ring 3 using temporary fixtures; no user vault used |
| Skill progressive disclosure | List omits bodies; explicit selected read freshly scans; unsafe/stale/noncanonical skill denied | Passed in Ring 3/Codemode with temporary skills and adversarial content |
| Episode recall | Explicit bounded same-workspace FTS5 results; no ordinary-turn injection | Passed in Ring 3 with temporary SQLite episodes |
| Browse behavior | Explicit research fixture can invoke browser; stable/local fixture can abstain; no real-model guarantee | Scripted faux-provider fixtures passed in Ring 2; no live model evaluation |
| Mission Control visual inspection of changed disclosure | Confirm text is legible and fits Settings layout | Automated UI text/API assertions passed; a separate human visual review was not performed |

## Live/provider checks not performed

- No real cloud model/API key was used to evaluate whether a production model chooses to browse or load a skill. Test providers are deterministic/faux; model-directed invocation remains non-guaranteed.
- No operator-owned Obsidian vault was configured or inspected. Tests used isolated temporary directories. The flag is opt-in and no vault contents are indexed or persisted by setup.
- No live web search/citation pipeline was tested or added; browser control is not presented as guaranteed search or citations.

## Security and scope notes

- No supplied credential was copied to tests, commands, docs, or files.
- Turbo/approval behavior, Ring 0–11 invariants, sandboxing and hard guardrails were not weakened.
- `openat2`/descriptor-relative access constrains filesystem reads, while returned note/skill text remains untrusted model input. Secret scrubbing reduces disclosure risk; it is not a substitute for treating content as untrusted.
- The workspace is not a Git repository in this environment, so this record does not include a commit hash or claim a clean Git status.
