import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SkillLibrary } from "../../src/ring3/skill-library.ts";
import { scanSkillBundle } from "../../src/ring3/skills-guard-quarantine.ts";
import { MultiAgentOrchestrator } from "../../src/ring9/multi-agent-orchestrator.ts";
import { ExternalPluginHost } from "../../src/ring9/external-plugin-host.ts";
import { ConfinedMcpHub } from "../../src/ring6/mcp-confined-hub.ts";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-starter-pack-"));
const counts = { skills: 0, personas: 0, pluginTools: 0, mcpTools: 0 };
let mcp: ConfinedMcpHub | undefined;
try {
  const library = new SkillLibrary({ workspaceRoot: repo, listLedger: () => [] });
  const entries = library.list().filter((entry) => entry.sourceKind === "canonical" && entry.pathLabel.startsWith(".agents/skills/"));
  for (const slug of ["test-driven-change", "api-contract-review", "provider-smoke-test"]) {
    const entry = entries.find((item) => item.name === slug);
    assert.ok(entry, `discover ${slug}`);
    assert.equal(entry.status, "active");
    const bundle = library.read(entry.id, ["SKILL.md"]);
    const scan = scanSkillBundle({ skillName: slug, files: Object.fromEntries(bundle.files.map((file) => [file.path, file.content])), source: "starter-pack-test", trustLevel: "community" });
    assert.equal(scan.verdict, "safe", `${slug} must be clean: ${JSON.stringify(scan.findings)}`);
    counts.skills++;
  }

  const orchestrator = new MultiAgentOrchestrator({ workspaceRoot: repo, getSubagentPool: () => { throw new Error("not needed for persona listing"); } });
  const personas = orchestrator.listPersonas();
  const coach = personas.find((item) => item.name === "test-coach");
  const reviewer = personas.find((item) => item.name === "api-reviewer");
  assert.ok(coach && reviewer);
  assert.equal(coach.role, "verify"); assert.deepEqual(coach.tools, ["read", "bash"]);
  assert.equal(reviewer.role, "review"); assert.deepEqual(reviewer.tools, ["read"]);
  counts.personas = 2;

  const plugin = new ExternalPluginHost({ workspaceRoot: temporary });
  const pluginSource = path.join(repo, "examples/starter-pack/plugins/dev-helper");
  const audit = plugin.auditPluginDirectory(pluginSource);
  assert.equal(audit.allowed, true, JSON.stringify(audit.findings));
  const installed = await plugin.installAndLoadPlugin(pluginSource);
  assert.equal(installed.id, "starter-dev-helper");
  const sampleText = "One two\n\nThree.";
  const metrics = await plugin.invokePluginTool(installed.id, "text_metrics", { text: sampleText });
  assert.deepEqual(metrics.output, { characters: Array.from(sampleText).length, words: 3, nonEmptyLines: 2, paragraphs: 2 });
  const formatted = await plugin.invokePluginTool(installed.id, "format_json", { json: JSON.stringify({ ok: true, n: 2 }) });
  assert.deepEqual(JSON.parse((formatted.output as { formatted: string }).formatted), { ok: true, n: 2 });
  counts.pluginTools = 2;

  mcp = new ConfinedMcpHub({ workspaceRoot: temporary, workspaceTrusted: true });
  const serverPath = path.join(repo, "examples/starter-pack/mcp/local-dev-helper.mjs");
  const connected = await mcp.connectStdioServer({ name: "local-dev-helper", command: process.execPath, args: [serverPath], cwd: repo });
  assert.equal(connected.transportKind, "stdio");
  assert.equal(connected.safeTools, 2); assert.equal(connected.poisonedTools, 0);
  const available = mcp.listTools({ serverName: "local-dev-helper" });
  assert.deepEqual(available.map((tool) => tool.name).sort(), ["format_json", "text_metrics"]);
  const result = await mcp.callTool({ serverName: "local-dev-helper", toolName: "text_metrics", args: { text: sampleText } });
  assert.equal(result.isError, false);
  assert.match(result.content.filter((part) => part.type === "text").map((part) => part.text).join(""), /"words":3/);
  counts.mcpTools = 2;
  console.log(`Starter pack checks passed: ${JSON.stringify(counts)}`);
} finally {
  await mcp?.closeAll().catch(() => {});
  fs.rmSync(temporary, { recursive: true, force: true });
}
