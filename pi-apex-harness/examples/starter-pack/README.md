# Pi-Apex starter pack: skills, agents, plugin, and MCP

This pack is local and deterministic. It includes three readable workflow skills, two custom agent personas, one auditable plugin example, and one local stdio MCP server. It requires no additional npm packages and contains no API keys or network calls. Configure a provider key separately in Mission Control before testing model-mediated workflows.

## Skills

Files in `.agents/skills/` are canonical workspace skills. In Mission Control's Skills Library, refresh and inspect **test-driven-change**, **api-contract-review**, and **provider-smoke-test**. To use one with an agent, ask it to list available skills with `skill_access`, then explicitly load the selected skill. Skill bodies are scanned and delivered as untrusted reference content; scripts are never run.

## Agents

The personas live under `.agents/agents/` and are discovered by the existing `/agents` command / agent registry:

- `test-coach` is a read-only verification role (read + bash, isolated-worktree role policy).
- `api-reviewer` is read-only (read tool only).

For example, try `/agents` to verify discovery, then use the multi-agent orchestration UI/command with the persona selected. The personas guide the configured model; they do not guarantee correct results. Role tool restrictions and worktree gates still apply.

## Plugin

In Mission Control, open **Plugins / Advanced extensions**. The starter plugin is pre-staged in the local plugin inventory as **disabled / not loaded**. Review its manifest and scan verdict, then explicitly choose **Enable** to load it; disable or remove it afterward if desired. To repeat the install flow, use this source folder with **Audit & Install**:

```text
/home/user/pi-apex-harness/examples/starter-pack/plugins/dev-helper
```

The plugin exposes `text_metrics` and `format_json` tools. It is intentionally deterministic and has no filesystem/network/process access. Installation is an explicit operator action. Important: the current plugin host imports plugin code into the host process; static audit is not a runtime sandbox. Only install this included source if you accept that existing trust model. You can disable/remove it from the Plugin UI afterward.

## MCP

In Mission Control's Models & MCP panel, connect a local stdio server with:

- Name: `local-dev-helper`
- Command: `node` (or the absolute path returned by `process.execPath`)
- Args: `/home/user/pi-apex-harness/examples/starter-pack/mcp/local-dev-helper.mjs`

The server exposes the same `text_metrics` and `format_json` functions. A copyable config example is in `examples/starter-pack/mcp/mcpServers.example.json`; do not copy it into active workspace config unless you intentionally want the trusted-workspace startup behavior. It uses newline-delimited JSON-RPC over stdio and Node built-ins only; it performs no network, filesystem, or credential access. The harness launches stdio MCP with a clean environment, scans tool descriptions, and keeps tools behind its deferred MCP hub. Disconnect when finished. Do not put API keys into MCP environment fields.

## Verify the pack without a provider key

Run:

```bash
npx --yes node@22 --experimental-strip-types test/starter-pack/run-starter-pack-tests.ts
```

This validates file discovery, clean skill scans, persona registration, plugin audit/invocation in a temporary host, and MCP tool listing/calls. It does not call an LLM or prove any connected provider credential works. You need your own configured provider key for an actual chat/tool-use test.
