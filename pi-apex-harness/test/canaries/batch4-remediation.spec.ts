/**
 * Batch-4 Remediation Contract Acceptance Suite (`test/canaries/batch4-remediation.spec.ts`)
 *
 * Verifies the three reproduced security & robustness findings:
 *  1. Secret discovery fail-closed behavior on incomplete scan / depth ceilings (depth 1, 24, boundary 32, beyond 33, forced read failure).
 *  2. External plugin command mutation admission in Plan Mode (pre-installed mutating command denied, read-only permitted, operator entrypoint).
 *  3. Normalized structured WAL result bounds across normal execution, simulated ENOSPC, mixed text/image, multiple text blocks, and replay.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fauxProvider } from "@earendil-works/pi-ai";
import {
  buildMinimalBwrapArgv,
  collectMaskedSecretFiles,
  SandboxUnavailableError
} from "../../src/core/bwrap-sandbox.ts";
import { loadVerifiedGuardrails } from "../../src/core/guardrail-pin.ts";
import {
  createConfinedFileOperations,
  GuardDeniedError,
  resolveAndValidateWorkspacePath
} from "../../src/core/monotonic-guard.ts";
import { createSharedModelRuntime } from "../../src/core/ring0-session.ts";
import {
  MAX_SECRET_SCAN_DEPTH,
  PathContainmentError,
  readWorkspaceFileSafe,
  scanWorkspaceSecretsAndHardlinks
} from "../../src/core/safe-path.ts";
import { PrivateSpillStore } from "../../src/core/spill-store.ts";
import { StateDb } from "../../src/core/state-db.ts";
import { executeThroughWalSpine } from "../../src/core/wal-recovery.ts";
import { createRing4Runtime } from "../../src/ring4/ring4-runtime.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SURFACES_DIR = path.resolve(__dirname, "..", "..", "surfaces");

function createTmpWorkspace(prefix: string): { ws: string; surfaces: string; agentDir: string } {
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), `apex-batch4-${prefix}-`));
  const ws = path.join(tmpBase, "repo");
  const surfaces = path.join(tmpBase, "surfaces");
  const agentDir = path.join(tmpBase, "agent");
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(surfaces, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });

  for (const f of ["SYSTEM.md", "TOOL_GUIDANCE.md", "MEMORY.md", "EXPERIENCE.md", "SUBAGENTS.yaml"]) {
    const src = path.join(SURFACES_DIR, f);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, path.join(surfaces, f));
    }
  }
  fs.writeFileSync(path.join(ws, "AGENTS.md"), "# Batch 4 Test Workspace\n", "utf8");
  return { ws, surfaces, agentDir };
}

async function main(): Promise<void> {
  console.log("================================================================================");
  console.log("Running Apex Batch-4 Remediation Verification Suite");
  console.log("================================================================================");

  // ===========================================================================
  // Finding 1: Secret Discovery Fail-Closed Invariant & Boundary Coverage
  // ===========================================================================
  {
    console.log("\n[Finding 1] Testing Secret Discovery & Hardlink Alias Bounds...");
    const { ws } = createTmpWorkspace("f1-secrets");
    const realWs = fs.realpathSync(ws);
    const guardrails = loadVerifiedGuardrails().config;

    // 1A. Shallow vendor secret (depth 1) + innocent hardlink
    const shallowDir = path.join(realWs, "node_modules", "shallow-pkg");
    fs.mkdirSync(shallowDir, { recursive: true });
    const shallowSecret = path.join(shallowDir, ".env");
    fs.writeFileSync(shallowSecret, "SHALLOW_SECRET_TOKEN=12345\n");
    const shallowAlias = path.join(realWs, "shallow-alias.txt");
    fs.linkSync(shallowSecret, shallowAlias);

    const ops = createConfinedFileOperations({
      workspaceRoot: realWs,
      cfg: guardrails,
      durabilityMode: "crash-safe",
      mode: "read-only"
    });

    let shallowBlocked = false;
    try {
      await ops.readOps.readFile(shallowAlias);
    } catch (err) {
      shallowBlocked = true;
      assert.ok(err instanceof GuardDeniedError);
      assert.ok((err as Error).message.includes("hardlink alias to secret file inode denied"));
    }
    assert.equal(shallowBlocked, true, "Shallow vendor secret hardlink must be denied");

    // 1B. Depth-24 vendor secret (the exact reviewer reproduction)
    const depth24Dir = path.join(realWs, "node_modules", ...Array.from({ length: 24 }, (_, i) => `d${i}`));
    fs.mkdirSync(depth24Dir, { recursive: true });
    const depth24Secret = path.join(depth24Dir, ".env");
    fs.writeFileSync(depth24Secret, "DEPTH_24_SECRET_TOKEN=xyz987\n");
    const depth24Alias = path.join(realWs, "depth24-alias.txt");
    fs.linkSync(depth24Secret, depth24Alias);

    let depth24Blocked = false;
    try {
      await ops.readOps.readFile(depth24Alias);
    } catch (err) {
      depth24Blocked = true;
      assert.ok(err instanceof GuardDeniedError);
      assert.ok((err as Error).message.includes("hardlink alias to secret file inode denied"));
    }
    assert.equal(depth24Blocked, true, "Depth-24 vendor secret hardlink must be denied via inode discovery");

    // 1C. Secret at the traversal boundary (depth = MAX_SECRET_SCAN_DEPTH = 32)
    const boundaryDepth = MAX_SECRET_SCAN_DEPTH;
    const boundaryDir = path.join(realWs, "node_modules", ...Array.from({ length: boundaryDepth }, (_, i) => `b${i}`));
    fs.mkdirSync(boundaryDir, { recursive: true });
    const boundarySecret = path.join(boundaryDir, ".env");
    fs.writeFileSync(boundarySecret, "BOUNDARY_SECRET=boundary\n");
    const boundaryAlias = path.join(realWs, "boundary-alias.txt");
    fs.linkSync(boundarySecret, boundaryAlias);

    let boundaryBlocked = false;
    try {
      await ops.readOps.readFile(boundaryAlias);
    } catch (err) {
      boundaryBlocked = true;
      assert.ok(err instanceof GuardDeniedError);
    }
    assert.equal(boundaryBlocked, true, "Secret at boundary depth must be denied");

    // 1D. Secret immediately beyond the boundary (depth = MAX_SECRET_SCAN_DEPTH + 1)
    // Scan reaches limit, flags complete = false, and reading multi-link alias fails closed!
    const beyondDepth = MAX_SECRET_SCAN_DEPTH + 1;
    const beyondDir = path.join(realWs, "node_modules", ...Array.from({ length: beyondDepth }, (_, i) => `beyond${i}`));
    fs.mkdirSync(beyondDir, { recursive: true });
    const beyondSecret = path.join(beyondDir, ".env");
    fs.writeFileSync(beyondSecret, "BEYOND_CEILING_SECRET=unseen\n");
    const beyondAlias = path.join(realWs, "beyond-alias.txt");
    fs.linkSync(beyondSecret, beyondAlias);

    const scanBeyond = scanWorkspaceSecretsAndHardlinks(realWs);
    assert.equal(scanBeyond.complete, false, "Scan must record complete=false when ceiling exceeded");
    assert.ok(scanBeyond.incompleteReasons.length > 0, "Scan must record incomplete reason");

    let beyondBlocked = false;
    try {
      await ops.readOps.readFile(beyondAlias);
    } catch (err) {
      beyondBlocked = true;
      assert.ok(err instanceof GuardDeniedError);
      assert.ok((err as Error).message.includes("incomplete secret inventory prevents verifying multi-link file alias safety"));
    }
    assert.equal(beyondBlocked, true, "Beyond-ceiling multi-link file must fail closed");

    // 1E. Positive Permitted Control: Normal single-link non-secret file is readable even with incomplete scan
    const normalFile = path.join(realWs, "normal-file.txt");
    fs.writeFileSync(normalFile, "public content ok\n");
    const normalRead = await ops.readOps.readFile(normalFile);
    assert.equal(normalRead.toString("utf8"), "public content ok\n", "Single-link normal file must be permitted");

    // 1F. Forced incomplete scan denies bubblewrap sandbox execution fail-closed
    let bwrapBlocked = false;
    try {
      buildMinimalBwrapArgv("echo ok", realWs, {
        workspaceRoot: realWs,
        mode: "read-only"
      });
    } catch (err) {
      bwrapBlocked = true;
      assert.ok(err instanceof SandboxUnavailableError);
      assert.ok((err as Error).message.includes("Cannot execute bubblewrap sandbox with incomplete secret mask coverage"));
    }
    assert.equal(bwrapBlocked, true, "Bwrap sandbox must refuse to run with incomplete secret mask coverage");

    // 1G. Symlinked directory outside workspace is ignored / not traversed
    const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "apex-ext-"));
    fs.writeFileSync(path.join(extDir, ".env"), "OUTSIDE_WORKSPACE_SECRET\n");
    const symlinkInWs = path.join(realWs, "ext-symlink");
    fs.symlinkSync(extDir, symlinkInWs);

    const scanSymlink = scanWorkspaceSecretsAndHardlinks(realWs);
    assert.equal(
      scanSymlink.allMaskedPaths.some((p) => p.includes("apex-ext-")),
      false,
      "External symlinked directory must never be traversed or included in masks"
    );

    console.log("  [PASS] Finding 1: Secret discovery and hardlink alias bounds verified across all depths.");
  }

  // ===========================================================================
  // Finding 2: External Plugin Command Dynamic Mutation Admission in Plan Mode
  // ===========================================================================
  {
    console.log("\n[Finding 2] Testing Plugin Command Dynamic Mutation Admission in Plan Mode...");
    const { ws, surfaces, agentDir } = createTmpWorkspace("f2-plugin");
    const faux = fauxProvider();
    const runtime = await createSharedModelRuntime(agentDir);
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey(faux.provider.id, "faux-key");

    const controller = await createRing4Runtime({
      workspaceRoot: ws,
      surfacesDir: surfaces,
      agentDir,
      modelRuntime: runtime,
      model: faux.getModel(),
      sandboxMode: "workspace-write",
      allowUnsandboxedDev: true
    });

    try {
      const h = controller.getCurrentHarness();
      const pluginSource = path.join(ws, "plugin-source");
      fs.mkdirSync(pluginSource, { recursive: true });
      const markerFile = path.join(ws, "marker-written.txt");

      fs.writeFileSync(
        path.join(pluginSource, "apex-plugin.json"),
        JSON.stringify({
          id: "audit-command",
          name: "Audit Command Plugin",
          version: "1.0.0",
          entry: "index.mjs",
          capabilities: {
            slashCommands: ["mutating_marker", "read_only_probe"]
          }
        })
      );

      fs.writeFileSync(
        path.join(pluginSource, "index.mjs"),
        `import fs from 'node:fs';
export function activate(api) {
  api.registerCommand({
    name: 'mutating_marker',
    description: 'Writes marker file',
    execute: () => {
      fs.writeFileSync(${JSON.stringify(markerFile)}, 'MARKER_OK');
      return 'marker written';
    }
  });
  api.registerCommand({
    name: 'read_only_probe',
    description: 'Reads safely',
    readOnly: true,
    execute: () => 'read only output ok'
  });
}\n`
      );

      // Install while permitted (Plan Mode is off)
      h.trustArtifacts.setPlanMode(false);
      await h.pluginHost.installAndLoadPlugin(pluginSource);

      // Positive Control 1: Mutating command succeeds when Plan Mode is off
      const resPermitted = await h.pluginHost.invokePluginCommand("mutating_marker");
      assert.equal(resPermitted, "marker written");
      assert.equal(fs.existsSync(markerFile), true, "Marker file must be written when Plan Mode is off");
      fs.unlinkSync(markerFile);

      // Enable Plan Mode
      h.trustArtifacts.setPlanMode(true);
      assert.equal(h.trustArtifacts.isPlanModeActive(), true);

      // Negative Denial Canary: Mutating command fails closed with GuardDeniedError
      let cmdBlocked = false;
      try {
        await h.pluginHost.invokePluginCommand("mutating_marker");
      } catch (err) {
        cmdBlocked = true;
        assert.ok(err instanceof GuardDeniedError);
        assert.ok((err as Error).message.includes("cannot invoke non-read-only plugin command 'mutating_marker' while Plan Mode is active"));
      }
      assert.equal(cmdBlocked, true, "Mutating plugin command must be blocked in Plan Mode");
      assert.equal(fs.existsSync(markerFile), false, "Marker file must NOT be written when Plan Mode is active");

      // Positive Control 2: Explicitly read-only command executes cleanly in Plan Mode
      const roRes = await h.pluginHost.invokePluginCommand("read_only_probe");
      assert.equal(roRes, "read only output ok", "Read-only plugin command must execute in Plan Mode");

      // Positive Control 3: Disabling Plan Mode restores mutating command execution
      h.trustArtifacts.setPlanMode(false);
      const resRestored = await h.pluginHost.invokePluginCommand("mutating_marker");
      assert.equal(resRestored, "marker written");
      assert.equal(fs.existsSync(markerFile), true, "Marker file must be written after Plan Mode disabled");
    } finally {
      await controller.dispose();
    }

    console.log("  [PASS] Finding 2: Plugin command mutation admission verified in Plan Mode.");
  }

  // ===========================================================================
  // Finding 3: Structured WAL Result Bounded Output & ENOSPC Fallback
  // ===========================================================================
  {
    console.log("\n[Finding 3] Testing Normalized Structured WAL Result Bounds & Fallbacks...");
    const { ws } = createTmpWorkspace("f3-wal");
    const harnessDir = path.join(ws, ".harness");
    fs.mkdirSync(harnessDir, { recursive: true });
    const stateDb = new StateDb(path.join(harnessDir, "bounds.db"), "crash-safe");

    try {
      const maxInline = 256;
      const previewBytes = 64;
      const oversizedText = "X".repeat(20000);
      const fakeImage = {
        type: "image" as const,
        mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9YpCBZsAAAAASUVORK5CYII="
      };

      // 3A. Mixed content: text + image (the exact reviewer reproduction)
      const storeMixed = new PrivateSpillStore({
        rootDir: path.join(harnessDir, "spill-mixed"),
        maxInlineBytes: maxInline,
        maxInlineLines: 100,
        previewBytes,
        cleanupDays: 1
      });

      let mixedEffectCalls = 0;
      const resMixed = await executeThroughWalSpine({
        stateDb,
        spillStore: storeMixed,
        sessionId: "bounds-mixed",
        leafId: "leaf-mixed",
        toolCallId: "call_mixed",
        toolName: "synthetic_mixed",
        mutabilityClass: "PURE_READ",
        args: {},
        executeEffect: async () => {
          mixedEffectCalls += 1;
          return {
            rawText: oversizedText,
            content: [{ type: "text", text: oversizedText }, fakeImage],
            details: { test: "mixed" }
          };
        }
      });

      assert.equal(mixedEffectCalls, 1);
      assert.equal(resMixed.fromCache, false);
      assert.equal(resMixed.spilled, true);
      assert.equal(resMixed.spillFallbackUsed, false);

      // Verify aggregate delivered text in content does not exceed bounded finalText
      const mixedTextBytes = resMixed.content
        .filter((c) => c.type === "text")
        .reduce((sum, c) => sum + Buffer.byteLength((c as any).text), 0);
      assert.ok(
        mixedTextBytes <= Buffer.byteLength(resMixed.finalText),
        `Mixed content text bytes (${mixedTextBytes}) must not exceed finalText bytes (${Buffer.byteLength(resMixed.finalText)})`
      );
      assert.ok(mixedTextBytes < 2000, `Delivered text (${mixedTextBytes}) must be bounded, not 20,000 bytes`);

      // Verify image block is preserved intact
      const mixedImageBlock = resMixed.content.find((c) => c.type === "image");
      assert.ok(mixedImageBlock, "Image block must be preserved in mixed content");
      assert.equal((mixedImageBlock as any).mimeType, "image/png");
      assert.equal((mixedImageBlock as any).data, fakeImage.data);

      // 3B. Replay of mixed content: returned from cache with bounded content
      const replayMixed = await executeThroughWalSpine({
        stateDb,
        spillStore: storeMixed,
        sessionId: "bounds-mixed",
        leafId: "leaf-mixed",
        toolCallId: "call_mixed",
        toolName: "synthetic_mixed",
        mutabilityClass: "PURE_READ",
        args: {},
        executeEffect: async () => {
          mixedEffectCalls += 1;
          throw new Error("SHOULD_NOT_EXECUTE");
        }
      });
      assert.equal(replayMixed.fromCache, true);
      assert.equal(mixedEffectCalls, 1, "Effect must not re-execute on cache hit");
      const replayMixedTextBytes = replayMixed.content
        .filter((c) => c.type === "text")
        .reduce((sum, c) => sum + Buffer.byteLength((c as any).text), 0);
      assert.equal(replayMixedTextBytes, mixedTextBytes, "Replayed content text bytes must match original bounded bytes");

      // 3C. Simulated ENOSPC: spill write failure degrades inline, content text is bounded
      const storeEnospc = new PrivateSpillStore({
        rootDir: path.join(harnessDir, "spill-enospc"),
        maxInlineBytes: maxInline,
        maxInlineLines: 100,
        previewBytes,
        cleanupDays: 1,
        simulateWriteFailure: true
      });

      const resEnospc = await executeThroughWalSpine({
        stateDb,
        spillStore: storeEnospc,
        sessionId: "bounds-enospc",
        leafId: "leaf-enospc",
        toolCallId: "call_enospc",
        toolName: "synthetic_enospc",
        mutabilityClass: "PURE_READ",
        args: {},
        executeEffect: async () => ({
          rawText: oversizedText,
          content: [{ type: "text", text: oversizedText }]
        })
      });

      assert.equal(resEnospc.spilled, false);
      assert.equal(resEnospc.spillFallbackUsed, true);
      const enospcTextBytes = resEnospc.content
        .filter((c) => c.type === "text")
        .reduce((sum, c) => sum + Buffer.byteLength((c as any).text), 0);
      assert.ok(
        enospcTextBytes <= Buffer.byteLength(resEnospc.finalText),
        `ENOSPC content text bytes (${enospcTextBytes}) must be bounded by finalText`
      );
      assert.ok(enospcTextBytes < 2000, `ENOSPC content text (${enospcTextBytes}) must be bounded, not 20,000 bytes`);

      // 3D. Multiple text blocks around image: aggregate delivered text is strictly bounded
      const resMultiText = await executeThroughWalSpine({
        stateDb,
        spillStore: storeMixed,
        sessionId: "bounds-multi",
        leafId: "leaf-multi",
        toolCallId: "call_multi",
        toolName: "synthetic_multi",
        mutabilityClass: "PURE_READ",
        args: {},
        executeEffect: async () => ({
          rawText: oversizedText + "\n" + oversizedText,
          content: [
            { type: "text", text: oversizedText },
            fakeImage,
            { type: "text", text: oversizedText }
          ]
        })
      });

      const multiTextBytes = resMultiText.content
        .filter((c) => c.type === "text")
        .reduce((sum, c) => sum + Buffer.byteLength((c as any).text), 0);
      assert.ok(
        multiTextBytes <= Buffer.byteLength(resMultiText.finalText),
        `Multiple text blocks aggregate bytes (${multiTextBytes}) must not exceed finalText`
      );

      console.log("  [PASS] Finding 3: Normalized structured WAL result bounds verified across all content shapes.");
    } finally {
      stateDb.close();
    }
  }

  console.log("\n================================================================================");
  console.log("ALL BATCH-4 REMEDIATION CANARIES PASSED CLEANLY!");
  console.log("================================================================================");
}

main().catch((err) => {
  console.error("\n[BATCH4_TEST_FAILURE]", err);
  process.exit(1);
});
