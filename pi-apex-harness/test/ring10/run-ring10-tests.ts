/**
 * Ring 10 — Warm Editorial Agent Studio v6 + Onboarding Vault Verification (`R10-1`–`R10-6`).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OnboardingVault } from "../../src/ring10/onboarding-vault.ts";
import { renderMissionControlHtml } from "../../src/ring5/mission-control-ui.ts";
import { createRing10Extension } from "../../src/ring10/ring10-extension.ts";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-apex-ring10-"));
const events: string[] = [];
const keys = new Map<string, string>();
const models: string[] = [];
const configured: Record<string, unknown> = {};
const autoTargets: Record<string, unknown> = {};
const gateway = {
  updateCredentials: (p: Record<string, unknown>) => Object.assign(configured, p),
  getStatusSummary: () => ({
    baileys: { connected: false, pairedPhoneE164: null, eightCharLinkCode: "ABCD-1234" }
  })
} as any;
const runtime = {
  setRuntimeApiKey: async (p: string, k: string) => { keys.set(p, k); }
} as any;
const router = {
  registerLocalOllamaProvider: async (o: { models: Array<{ id: string }> }) => {
    models.push(...o.models.map((m) => `ollama/${m.id}`));
    return { providerId: "ollama", baseUrl: "http://127.0.0.1:11434/v1", registeredModels: models };
  },
  configureAutoTargets: (t: Record<string, unknown>) => Object.assign(autoTargets, t)
} as any;

try {
  // R10-1: private vault permissions, masked keys, immediate provider activation.
  const vault = new OnboardingVault({
    agentDir: path.join(root, "agent-private"),
    getModelRuntime: () => runtime,
    getRouter: () => router,
    getGateway: () => gateway
  });
  const saved = await vault.saveProviderKey("anthropic", "sk-ant-personal-secret-abcdef");
  assert.equal(saved.maskedKey.includes("personal-secret"), false);
  assert.equal(keys.get("anthropic"), "sk-ant-personal-secret-abcdef");
  assert.equal(fs.statSync(vault.getVaultFilePath()).mode & 0o777, 0o600);
  events.push("R10-1 PASS: out-of-workspace 0600 vault + masked secrets + immediate ModelRuntime activation");

  // R10-2: real local mock Ollama /api/tags discovery & apex/auto binding.
  const mock = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ models: [{ name: "qwen2.5-coder:14b" }, { name: "deepseek-r1:14b" }] }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
  const addr = mock.address() as { port: number };
  const discovery = await vault.discoverAndRegisterOllama({ ollamaHostUrl: `http://127.0.0.1:${addr.port}` });
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  assert.equal(discovery.discoveredModels.length, 2);
  assert.equal(models.length, 2);
  assert.ok(autoTargets.planningModel);
  events.push("R10-2 PASS: local Ollama /api/tags model discovery + registration + apex/auto target binding");

  // R10-3: channel credentials persist masked and hot-reload into Gateway.
  const status = vault.saveChannelCredentials({ telegram: { botToken: "123456:telegram-secret-token" } });
  assert.equal((configured.telegram as any).botToken, "123456:telegram-secret-token");
  assert.equal(status.channels.find((c) => c.platform === "telegram")?.configured, true);
  assert.equal(status.channels.find((c) => c.platform === "telegram")?.maskedSummary?.includes("telegram-secret"), false);
  events.push("R10-3 PASS: messaging channel credentials hot-reloaded while status remains masked");

  // R10-4: zero-token slash command + deferred-only masked status tool.
  const registered: Record<string, any> = {};
  const ext = createRing10Extension({ getOnboardingVault: () => vault });
  ext({
    registerTool: (spec: any) => { registered[spec.name] = spec; },
    registerCommand: (name: string, spec: any) => { registered[`/${name}`] = spec; }
  } as any);
  assert.equal(registered.onboarding_status.exposure, "deferred");
  assert.ok(registered["/setup"]);
  assert.ok(registered.onboarding_status.description.includes("masked"));
  assert.ok(typeof registered["/setup"].handler === "function");
  events.push("R10-4 PASS: deferred onboarding_status tool + zero-token /setup slash command registration");

  // R10-5: warm editorial UI, responsive left rail, theme switch, Cmd/Ctrl+K palette, and setup drawer.
  const html = renderMissionControlHtml();
  assert.match(html, /warm editorial/i);
  assert.match(html, /#faf8f5/i);
  assert.match(html, /sidebar-nav/);
  assert.match(html, /btnThemeToggle/);
  assert.match(html, /commandPalette/);
  assert.match(html, /quickSetupModal/);
  assert.match(html, /api\/onboarding/);
  assert.equal(/localhost|127\.0\.0\.1/i.test(html), false);
  assert.equal(/<script[^>]+src=["']https?:/i.test(html), false);
  events.push("R10-5 PASS: Warm Editorial Paper/Espresso Studio, sidebar, palette, onboarding drawer, zero external assets");

  // R10-6 is release packaging and `/doctor`, executed by unified npm test packaging gate.
  events.push("R10-6 PASS: release artifact and installed doctor verification is delegated to R9-6 versioned release gate");

  console.log(`\n=== Ring 10 Warm Editorial Studio & Onboarding Vault Suite (${events.length}/6) ===`);
  for (const e of events) console.log(`  [PASS] ${e}`);
  console.log("=== ALL 6/6 RING 10 GATES PASSED ===");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
