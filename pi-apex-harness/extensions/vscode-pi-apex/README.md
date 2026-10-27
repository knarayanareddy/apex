# `vscode-pi-apex` (`v4.1.0`) — VS Code & Cursor RPC Extension for Pi-Apex

Thin, zero-build-step VS Code & Cursor extension bridging your active editor selection, 1-indexed line ranges, and live IDE LSP diagnostics directly into `pi-apex --mode rpc` with **`0` static prompt-prefix drift** and automatic `.env`/`.pem`/`.key` secret redaction.

## Quick Install (VS Code & Cursor)

```bash
# Automatically symlink into ~/.vscode/extensions and ~/.cursor/extensions:
bash scripts/install-personal.sh --install-vscode
```

## Keybindings & Commands

| Command | Shortcut | Description |
|---|---|---|
| `Pi-Apex: Ask Agent About Selection & Diagnostics` | `Ctrl+Shift+A` / `Cmd+Shift+A` | Sends `<ide_active_editor>` selection + LSP errors/warnings at the user message tail (`0` prefix drift). |
| `Pi-Apex: Toggle Plan Mode (/plan)` | `Ctrl+Alt+P` / `Cmd+Alt+P` | Toggles read-only Plan Mode & Trust Artifact synthesis. |
| `Pi-Apex: Run BugBot & Codex Three-Dot Review (/review)` | `Ctrl+Alt+R` / `Cmd+Alt+R` | Audits uncommitted or branch diffs against `REVIEW_RULES.md`. |
| `Pi-Apex: Run Self-Healing Autonomous Issue-to-PR (/pr)` | `Ctrl+Alt+G` / `Cmd+Alt+G` | Runs `/pr --auto <issueUrlOrTitle>` with `skills-guard-v10` quarantine & bounded BugBot/`bwrap` CI self-healing. |
| `Pi-Apex: Handoff Active Selection (/handoff)` | Command Palette | Spawns a clean `parentSession`-linked child `.jsonl` thread. |
| `Pi-Apex: Open Mission-Control Cockpit Panel` | Status Bar Click | Opens the live 8-tab Mission-Control Cockpit side-by-side inside VS Code / Cursor. |
