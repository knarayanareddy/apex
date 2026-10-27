# Pi-Apex `v4.1.0` — Personal Linux Workstation Quickstart Guide

> **Capability status (2026-10-27):** Browser automation and specialist tools are available on demand through deferred tool discovery; their presence does not guarantee that a model will invoke them. `browser_control` is browser automation, not a guaranteed search/citation pipeline. Skill files are inventoried in Mission Control and can be explicitly loaded through `skill_access`, but task matching is model-directed, not guaranteed. Session history and SQLite episodes persist locally; FTS5 episode recall is explicit and not injected into every prompt. `/dream` stages `surfaces/MEMORY.md` for a later session boot. Prompt-prefix stability and cache telemetry do not mean Pi-Apex owns a durable provider prompt cache. Obsidian access is opt-in and read-only.

Welcome to **Pi-Apex (`v4.1.0`, Rings 0–11 Streaming Studio with speech, multimodal chat, session profiles, and bounded execution modes)** — your confined, self-evolving personal coding harness built atop `@earendil-works/pi-coding-agent@1.4.0`, `@earendil-works/pi-codemode@1.4.0`, `@earendil-works/pi-mcp@1.4.0`, and `@earendil-works/pi-tui@1.4.0`.

## 1. Host Prerequisites (Personal Linux `x86_64` / `arm64`)

- **Linux Kernel `>= 5.6`** (for native `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` path-confinement syscall broker)
- **Node.js `>= 22.19.0`** (uses built-in `node:sqlite` WAL + FTS5, built-in `WebSocket` for Chromium CDP, and native `.ts` type-stripping)
- **`gcc`** + standard C headers (`build-essential`), **`git >= 2.38`**, **`bubblewrap` (`bwrap >= 0.8`)**, and **`chromium` + `xvfb`** (for live Headless Chromium CDP `@e1` ARIA snapshots & screenshots)

```bash
# Debian / Ubuntu / Pop!_OS:
sudo apt-get update && sudo apt-get install -y build-essential git bubblewrap chromium xvfb
```

## 2. Unpack, Install (CLI + systemd + VS Code / Cursor) & Verify in 60 Seconds

```bash
tar -xzf pi-apex-v4.1.0-personal.tar.gz
cd pi-apex-harness

# Install dependencies, compile the native Linux openat2 C broker, and run the complete verification suite (Rings 0–14; browser-dependent rings require Chromium):
npm install
npm test

# Run the 3-repo SWE Eval & Harness² EXPERIENCE.md A/B Prompt-Cache Benchmark:
npm run bench

# Install ~/.local/bin/pi-apex + systemd --user Cockpit service + VS Code & Cursor RPC extension:
bash scripts/install-personal.sh --install-systemd-user --install-vscode
```

## 3. Daily-Driver Commands (21 Zero-Token Slash Commands)

| Command | Purpose |
|---|---|
| `pi-apex --cwd ~/my-repo` | Launch interactive terminal TUI (`Ctrl+Alt+P` toggles Plan Mode) |
| `pi-apex --cwd ~/my-repo --web --port 4310` | Launch 9-Tab Mission-Control Web Cockpit (`http://127.0.0.1:4310`) |
| `/gateway pair <platform>` | Issue a 1-time 6-digit pairing code for `telegram`, `discord`, `slack`, `signal`, `whatsapp_baileys`, or `whatsapp_cloud` |
| `/gateway whatsapp [+316...]` | Initialize personal WhatsApp Baileys QR / 8-char multi-device link code |
| `/gateway slack-manifest` | Export native Slack App Manifest mapping all 21 Pi-Apex slash commands |
| `/send <platform> <channelId> <msg>` | Send a zero-LLM notification (`hermes send` port) |
| `/agents` & `/swarm debate <goal>` | Inspect `.agents/agents/*.md` personas or run `dag` / `supervisor` / `debate` / `map_reduce` multi-agent orchestration |
| `/plugin audit\|install <dir>` | Scan and install a trusted local `apex-plugin.json`; plugin code runs in the harness Node process (scanner is not a sandbox) |
| `/ledger verify\|list\|materialize` | Verify SHA-256 hash chain on `.harness/ledger/SELF_LEARNING_LEDGER.jsonl` & materialize next-boot `EXPERIENCE.md` |
| `/pr --auto <issueUrl\|#42>` | Quarantine-scan GitHub Issue & run autonomous self-healing Issue-to-PR pipeline |
| `/bench` | Run 3-repo SWE Eval & `o200k_base` Prompt-Cache Benchmark Suite |
| `/doctor` | Verify all 9 health & confinement invariants (`schema=1073`, `0` drift) |

## 4. Skills Library, Plugins & External Apps

### Skills

Mission Control → **Quarantine & skill curator** now has a searchable **Skills Library**. It discovers workspace-local `.agents/skills/`, `.opencode/skills/`, and `.claude/skills/` directories, plus Pi-Apex quarantine/archive entries. Select a skill to inspect `SKILL.md` and text supporting files. `.agents/skills/` is the canonical active path; compatible OpenCode/Claude folders are read-only until imported.

Use **Create / scan into quarantine** or choose a local folder containing `SKILL.md` and click **Import selected folder**. Review the scan before **Review scan & promote**. Imports and newly created skills do not become active automatically. **Runtime behavior:** the agent can discover compact metadata and explicitly load a selected clean active skill through the deferred `skill_access` tool; this is progressive disclosure, not guaranteed automatic task matching. Quarantined/invalid/archived and compatible external folders are not loadable. Loaded text is scanned and marked untrusted; scripts are never executed. Full skill bodies are not injected into every prompt.

### Task modes and model routing

The Mission Control chat composer offers a **Task mode** selector with a local, deterministic suggestion as you type: Quick answer, Goal, Plan, Browser research, Teamwork, or Schedule. The suggestion is advisory and explains its cue; it is not sent to a model, does not select itself, and does nothing until you choose a mode and send. You can always override it. Teamwork explicitly invokes the existing text-only `/swarm debate` workflow; browser research asks the agent to use the available browser tool but does not guarantee a search result. Schedule mode asks the agent to confirm schedule details before creating unattended work. Plan mode turns on the existing read-only Plan Mode and stays active until you turn it off or follow the Trust Artifact approval flow.

For likely multi-step tasks, the composer may recommend `apex/auto`, showing the configured planning → implementation route when available. The active model remains unchanged until you separately choose **Use apex/auto for this session**; ordinary model selection remains available. Task modes never bypass interaction approvals, sandbox limits, or hard guardrails. This is a cue-based local heuristic, not an LLM classifier; review/override the recommendation when the task is ambiguous.

### Memory and browsing behavior

For current facts or an explicit research/search request, tool guidance tells the model to discover `browser_control` and browse when available; models can still fail to follow that guidance, and no search/citation guarantee is implemented. `memory_recall` is an explicit, bounded FTS5 search over historical workspace episodes; it is not automatic and does not search every transcript. `/dream` separately consolidates selected episodes into the next-boot `MEMORY.md`.

### Obsidian (optional, read-only)

Start Pi-Apex with `--obsidian-vault /absolute/path/to/vault` to expose the deferred `obsidian_vault` tool for bounded Markdown listing, keyword search, and reads. Mission Control → **Settings & safety** reports whether this connector is enabled. The vault remains separate from the Pi-Apex workspace and memory database; access is read-only, excludes hidden/config folders (including `.obsidian`), symlinks, binaries, and non-Markdown files. No vault is scanned unless this option is supplied. No Obsidian plugin, REST API, or MCP server is installed or used.

### MCP connectors

Mission Control → **Models & tools** supports local stdio MCP and remote HTTPS MCP endpoints. Remote endpoint definitions are stored in `.harness/mcp-remote-servers.json` with private file permissions and no credentials; they are revalidated and reconnected on startup. Remote OAuth/authenticated headers are not implemented in this release, so use only endpoints that do not require credentials. Remote connections are public HTTPS only; private-network targets are rejected.

### Plugins

Plugins remain an advanced, trusted-local feature. The static scanner is not a sandbox: plugin JavaScript executes inside the harness Node process. Installed copies persist under `.harness/plugins/`; after a restart they remain unloaded until explicitly enabled and re-audited. Changed plugin contents are blocked pending removal/reinstallation and review.
