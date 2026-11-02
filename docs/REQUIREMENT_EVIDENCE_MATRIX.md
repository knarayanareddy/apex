# Apex Requirement-to-Evidence Matrix (R01)

**Snapshot Date:** 2026-11-02  
**Baseline Git Commit:** `a3936e6` (with R02 delivery truthfulness & R13 schema reconciliation)  
**Tracked Against:** `tasks/plan.md` §1–§5, `tasks/todo.md`, `pi-apex-harness/package.json`, and `pi-apex-harness/research/2026-11-01-live-feature-verification.md`.

---

## 1. Matrix Overview & Status Taxonomy

Each requirement is mapped to its owner, primary entry point, test fixture, target execution platform, and status:
- **Verified:** Fully covered by automated, deterministic, passing tests in the codebase.
- **Partial:** Implemented with verified synthetic/offline test controls, but live endpoint qualification, concurrent race coverage, or OS boundary validation remains open.
- **Untested:** Specification or stub exists, but automated verification is missing or blocked.
- **Excluded:** Explicitly excluded from core harness release scope (e.g. requires operator authorization or external protocol selection).

---

## 2. Requirement-to-Evidence Matrix

| Category | Requirement & Scope | Owner | Entry Point | Test Fixture / Canary | Platform | Status | Evidence & Bound Commit / PR |
|---|---|---|---|---|---|:---:|---|
| **CLI** | Offline Print Mode `/doctor` Audit | Maintainer | `bin/pi-apex -p "/doctor"` | `test/ring4/run-ring4-tests.ts` (R4-4) | macOS / Linux | **Verified** | Pass: 9/9 invariants healthy, `schema=1053`, `0` drift |
| **CLI** | Structured NDJSON Stream Mode | Maintainer | `bin/pi-apex --mode json -p "<cmd>"` | `test/ring4/run-ring4-tests.ts` (R4-4) | macOS / Linux | **Verified** | Pass: NDJSON emitted per event |
| **CLI** | Zero-Token Slash Commands (22 commands) | Maintainer | `ExtensionAPI.registerCommand` | `test/ring4` through `test/ring9` | macOS / Linux | **Verified** | Pass: `+0` schema tokens (`1053 === 1053`), `0` mid-session prefix drift |
| **CLI** | Live LLM CLI Provider Turn | Operator | `bin/pi-apex "prompt"` | `research/2026-11-01-live-feature-verification.md` | macOS scratch | **Partial** | OpenRouter `nvidia/nemotron-3-ultra-550b-a55b:free` responded; restricted tools |
| **UI** | Cockpit Server (`0.0.0.0` / `127.0.0.1`) | UI Maintainer | `MissionControlServer` | `test/ring5/run-ring5-tests.ts` (R5-1) | macOS / Linux | **Verified** | Pass: Zero `localhost`/CDN literals; reverse-proxy headers validated |
| **UI** | Pairing-File Authentication & Single-Use Bootstrap | Security Maintainer | `POST /api/auth/bootstrap` | `test/canaries/batchC-cockpit-proxy.spec.ts` (C1) | macOS / Linux | **Verified** | Pass: Mode `0600`, out-of-workspace agent dir, CSRF & Origin checks |
| **UI** | SSE Real-Time Event Stream (`toJsonEvent`) | UI Maintainer | `GET /api/events` | `test/ring5/run-ring5-tests.ts` (R5-2) | macOS / Linux | **Verified** | Pass: $O(1)$ delta streaming of transcript, artifacts, tools |
| **UI** | Headless Chromium 156 CDP Automation & Tabs | UI Maintainer | `ChromiumCdpSession` | `test/ring7`, `test/ring8`, `test/ring9` | macOS / Linux | **Verified** | Pass: All 6/6 Ring 7 gates pass; `--no-proxy-server` eliminates macOS `Page.navigate` proxy stall; `ChromiumCdpSession` records `BrowserStartupPhases` (endpoint, target, ws, handshake); dual-path `DevToolsActivePort` + stderr discovery under 12s deadline |
| **RPC** | Headless JSON-RPC Mode | Runtime Maintainer | `bin/pi-apex --mode rpc` | `test/ring4/run-ring4-tests.ts` (R4-5) | macOS / Linux | **Verified** | Pass: `RpcClient` getState, getCommands, prompt |
| **RPC** | VS Code / Cursor IDE RPC Extension | Runtime Maintainer | `IdeRpcBridge` | `test/ring8/run-ring8-tests.ts` (R8-3) | macOS / Linux | **Verified** | Pass: Manifest compiled, 15 slash commands, `.env` redaction, callbacks |
| **RPC** | ACP (Agent Client Protocol) Interoperability | Operator | N/A (CLI mode parser) | N/A | Excluded | **Excluded** | CLI accepts `text`, `json`, `rpc`. ACP is not supported; needs operator decision |
| **Tools** | Core 5 Direct Tools (`read`, `bash`, `edit`, `write`, `codemode`) | Runtime Maintainer | `createRing0Harness` | `test/canaries/security-canaries.spec.ts` | macOS / Linux | **Verified** | Pass: Schema pinned to 1,053 tokens; direct schema cap $\le 1,240$ |
| **Tools** | Control-Plane Shell Isolation (`.harness` masking) | Platform Maintainer | `bwrap` / sandbox runner | `test/canaries/control-plane-shell.spec.ts` | Linux (qualified) | **Verified** | Linux `bwrap` masks `.harness`; `isInodeInDirectory` rejects post-scan hardlink aliases |
| **Tools** | Read-Tool Spill Session Scoping | Runtime Maintainer | `read` tool handler | `test/canaries/batchF-benchmarks-spill.spec.ts` (F3) | macOS / Linux | **Verified** | Pass: Foreign-session spills rejected with `PathContainmentError` |
| **Tools** | Tool Admission Default-Deny Authority (R03 & R04) | Maintainer | `ToolAdmissionController` | `test/canaries/batchH-tool-admission.spec.ts` | macOS / Linux | **Verified** | Pass: Authoritative default-deny enforced even without explicit allowlist; principal, workspace containment, session binding, depth $\le 1$ bounding, turn & duration limits, and `ABORTED_CLEAN` in WAL; all H1–H7 pass |
| **Process** | Process Ownership & Termination Boundary (R07) | Platform Maintainer | `linux-process-containment.spec.ts` | `test/canaries/linux-process-containment.spec.ts` | Linux (qualified) | **Verified** | Pass: Fixed Gate 2 Python `select` supervisor import; qualified natural leader exit, control pipe cancellation, parent death (`--die-with-parent`), and grandchild reparenting using `SO_PEERCRED` without arbitrary signals |
| **Process** | Fail-Closed Dispatch for Shell/PTY/Cron/LSP/MCP (R08 & R09) | Runtime Maintainer | Dispatchers | `test/canaries/security-canaries.spec.ts` | Linux / macOS | **Verified** | Pass: Denied fail-closed with `SandboxUnavailableError` unless explicit `allowUnsandboxedDev` override supplied; MCP stdio and LSP wrapped in `bwrap` with `--unshare-pid` and `--die-with-parent`; `cleanup_unverified` preserved as macOS blocker |
| **Memory** | SQLite WAL `episodes_fts` (FTS5) & Durability | Runtime Maintainer | `StateDb` | `test/ring1/run-ring1-tests.ts`, `test:tier-a` | macOS / Linux | **Verified** | Pass: Crash-safe WAL, parent directory fsync, zero data loss; preflight verified before database or spill creation |
| **Memory** | Dreaming Episode Consolidation | Runtime Maintainer | `/dream` slash command | `test/ring4/run-ring4-tests.ts` (R4-2) | macOS / Linux | **Verified** | Pass: Memory surface compacted within 300 token budget; applies next boot |
| **Memory** | Context Retention & Episode Recall (R14) | Feature Maintainer | Ring 3 / `memory_recall` | `test/canaries/batchI-context-memory-obsidian.spec.ts` | macOS / Linux | **Verified** | Pass: Multi-turn history (6 msgs) & token accounting with 0 prefix drift, boot-pinned MEMORY.md (<=300 tokens) & dreaming consolidation, FTS5 BM25 search with secret scrubbing, restart continuity across persistent .harness |
| **Vault** | Onboarding Vault (`apex-vault.json`) | Security Maintainer | `OnboardingVault` | `test/ring10/run-ring10-tests.ts` (R10-1) | macOS / Linux | **Verified** | Pass: Mode `0600`, out-of-workspace agent dir, credential masking |
| **Vault** | Hot-Reload Messaging Credentials | Runtime Maintainer | `OnboardingVault.saveChannelCredentials` | `test/ring10/run-ring10-tests.ts` (R10-3) | macOS / Linux | **Verified** | Pass: Immediate runtime activation without restart |
| **Vault** | Synthetic Obsidian Vault Extraction (R14) | Runtime Maintainer | `ObsidianVaultReader` | `test/canaries/batchI-context-memory-obsidian.spec.ts` | macOS / Linux | **Verified** | Pass: Default disabled (+0 schema tokens), opt-in list/search/read with secret scrubbing, symlink/hidden exclusion, fail-closed traversal/non-md rejections |
| **State** | Production State Migration Cutover (R06) | Operator | `scripts/operator-migration-workflow.ts` | `test/canaries/batchE-private-state-migration.spec.ts` | Linux / macOS | **Untested** | Safe rehearsal & dry-run CLI provided; live production cutover blocked pending operator mount topology validation & explicit authorization |
| **MCP** | Synthetic InMemory & Stdio Gating (R15) | Integration Maintainer | `McpHub` | `test/canaries/batchJ-mcp-plugin-deferred.spec.ts` | macOS / Linux | **Verified** | Pass: InMemoryTransportPair lifecycle, Layer 3 poisoning defense (skills-guard-v10), secret-scrubbed output, strict 1,053 schema tokens, Stdio SandboxUnavailableError gating, clean env sanitization, graceful closeAll teardown |
| **MCP** | MCP Spill Session Scoping & Cancellation | Integration Maintainer | `McpHub` spill writer | `test/ring6/mcp-spill-session.spec.ts` | macOS / Linux | **Verified** | Pass: Initiating session captured; in-flight switch preserves session bounds |
| **MCP** | Live External MCP Transports | Integration Maintainer | Stdio / SSE / HTTP | N/A | macOS / Linux | **Untested** | Live external transports untested; synthetic in-memory tested |
| **Plugin** | External Plugin Lifecycle & Sandboxing (R15) | Runtime Maintainer | `ExternalPluginHost` | `test/canaries/batchJ-mcp-plugin-deferred.spec.ts` | macOS / Linux | **Verified** | Pass: Static manifest & capability audit, undeclared child_process/eval rejection, install, tool invocation, disable, re-enable, +0 schema tokens (`1053 === 1053`). Note: in-process `import()` executes in host V8 without OS-level boundary isolation |
| **Messaging** | Omni-Channel Gateway (6 Platforms) | Integration Maintainer | `OmniChannelGateway` | `test/ring9/run-ring9-tests.ts` (R9-1) | macOS / Linux | **Verified** | Pass: WhatsApp Baileys, WhatsApp Cloud, Telegram, Discord, Slack, Signal |
| **Messaging** | Truthful Outbound Delivery Status (R02) | Maintainer | `messaging-gateway.ts` | `test/canaries/batchG-delivery-truth.spec.ts` | macOS / Linux | **Verified** | Pass: 12 synthetic mock HTTP controls strictly distinguishing confirmed vs queued vs failed vs unavailable vs unknown; Slack HTTP 200 {ok:false} fails, Baileys offline queues, live socket confirms, network timeouts abort safely |
| **Release** | CI Runtime Matrix & Packaging (R19 & R20) | Release Maintainer | `scripts/package-release.sh`, `install-personal.sh` | CI matrix + `test/canaries/package-safety.spec.ts` | Linux (Ubuntu 22/24) / macOS | **Verified** | Pass: 2-lane Linux CI matrix (Ubuntu 22.04 & 24.04), reproducible archive, missing-input and overwrite refusal, isolated prefix install, `/doctor` audit passes with schema=1053, npm audit clean (0 high/critical) |
| **Release** | Release Artifact Installation & Doctor | Maintainer | `install-personal.sh` | Ring release gates (R5-6, R6-6, R7-6, R8-6, R9-6) | macOS / Linux | **Verified** | Pass: Installed wrapper passes `/doctor` with `schema=1053` |
| **Release** | Physical Power-Loss Durability | Platform Maintainer | Physical host test | N/A | Linux | **Untested** | Software restart & WAL crash recovery verified; physical power-loss evidence requires dedicated lab run |

---

## 3. Discrepancy & Gap Analysis

1. **Synthetic vs Live Boundaries:**
   - Rings 0–14 automated tests use deterministic `fauxProvider` or local mock servers (mock Ollama, mock GitHub, mock WhatsApp, synthetic MCP server).
   - Live endpoint verification was conducted on 2026-11-01 on macOS with OpenRouter, showing partial passes for MCP (formatting) and an invalid test-only guard flag. Full live qualification remains pending R03–R09 qualification.
2. **Platform Confinement Boundary:**
   - Linux: Confinement relies on `openat2` + `O_NOFOLLOW` + `bwrap`. Two Ubuntu CI lanes (22.04 & 24.04) execute Tier B integration tests.
   - macOS Darwin: Kernel namespaces are absent; unconfined development bash logs `[APEX_CONFINEMENT_WARNING]`. Production enforcement requires ADR 0002 qualified execution boundary.
3. **Browser Startup & Navigation Deadlines:**
   - Linux CI has experienced intermittent cold-cache Chromium startup delays (`folio_wait_bit_common`).
   - macOS has experienced CDP command timeouts on `Page.navigate` during heavy serial test execution. Both are isolated and tracked under R12.
