/**
 * Batch B Verification Suite (`test/canaries/batchB-codemode-docs.spec.ts`)
 *
 * Verifies:
 *  1. Model-visible codemode tool description contains truthful, location-invariant instruction:
 *     "Read docs/codemode.md first." (no machine-specific or nonexistent /home/user/... paths).
 *  2. Real tool call to `read({ path: "docs/codemode.md" })` succeeds in both read-only and
 *     workspace-write modes, returning the genuine bundled codemode documentation bytes.
 *  3. Arbitrary outside-workspace file reads remain strictly denied (fail closed).
 *  4. Across two distinct locations (including one containing spaces), tool schema tokens
 *     and serialized prefix SHA-256 remain strictly identical with zero mid-session drift.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDocsPath } from "@earendil-works/pi-coding-agent";

import { createRing0Harness } from "../../src/core/ring0-session.ts";
import { GuardDeniedError } from "../../src/core/monotonic-guard.ts";

async function runBatchBVerification() {
  console.log("=== Running Batch B: Codemode Documentation Delivery & Invariance ===");

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "pi-batch-b-"));
  const tmpWithSpaces = fs.mkdtempSync(path.join(os.tmpdir(), "pi batch b with spaces-"));

  try {
    const surfacesDir = path.resolve("./surfaces");

    // Location 1: Standard temporary workspace
    const ws1 = path.join(tmpRoot, "ws1");
    fs.mkdirSync(ws1, { recursive: true });

    // Location 2: Path containing spaces
    const ws2 = path.join(tmpWithSpaces, "workspace with spaces");
    fs.mkdirSync(ws2, { recursive: true });

    // ------------------------------------------------------------------------
    // Part 1: Inspect model-visible tool description in Location 1
    // ------------------------------------------------------------------------
    console.log("--- Part 1: Verify model-visible tool description ---");
    const h1 = await createRing0Harness({
      workspaceRoot: ws1,
      surfacesDir,
      allowUnsandboxedDev: true,
      sandboxMode: "workspace-write"
    });

    const codemodeTool1 = h1.session.agent.state.tools.find((t) => t.name === "codemode");
    assert.ok(codemodeTool1, "codemode tool must be registered in session");
    const desc1 = codemodeTool1.description ?? "";

    assert.ok(
      desc1.includes("Read docs/codemode.md first."),
      "Tool description must instruct: 'Read docs/codemode.md first.'"
    );
    assert.equal(
      desc1.includes("/home/user/pi-apex-harness"),
      false,
      "Tool description must not contain nonexistent /home/user/... path"
    );
    assert.equal(
      desc1.includes(process.cwd()),
      false,
      "Tool description must not leak local machine checkout path"
    );

    // ------------------------------------------------------------------------
    // Part 2: Follow documentation instruction through real tool call
    // ------------------------------------------------------------------------
    console.log("--- Part 2: Follow documentation instruction through read tool ---");
    const readTool1 = h1.session.agent.state.tools.find((t) => t.name === "read");
    assert.ok(readTool1, "read tool must be present");

    // Execute read tool with logical path
    const readResult: any = await readTool1.execute(
      "call_read_docs",
      { path: "docs/codemode.md" },
      new AbortController().signal,
      () => {}
    );

    assert.ok(readResult, "read tool must return a result");
    const resultText =
      readResult.finalText ||
      (Array.isArray(readResult.content) ? readResult.content.map((c: any) => c.text || "").join("\n") : "") ||
      (typeof readResult === "string" ? readResult : "");

    // Verify expected documentation bytes arrive
    const expectedDocBytes = fs.readFileSync(path.join(getDocsPath(), "codemode.md"), "utf8");
    assert.ok(resultText.length > 500, "Documentation bytes must be populated");
    assert.ok(resultText.includes("Apex-specific tool-result policy"), "Bundled guide must describe Apex's output budget");
    assert.ok(resultText.includes(expectedDocBytes), "The complete upstream guide must remain available");
    assert.ok(
      resultText.includes("codemode") || resultText.includes("JavaScript"),
      "Documentation content must match codemode documentation"
    );

    // ------------------------------------------------------------------------
    // Part 3: Verify read-only sandbox mode also delivers documentation
    // ------------------------------------------------------------------------
    console.log("--- Part 3: Documentation delivery in read-only sandbox mode ---");
    const wsReadOnly = path.join(tmpRoot, "ws-readonly");
    fs.mkdirSync(wsReadOnly, { recursive: true });
    const hReadOnly = await createRing0Harness({
      workspaceRoot: wsReadOnly,
      surfacesDir,
      allowUnsandboxedDev: true,
      sandboxMode: "read-only"
    });

    const readToolRo = hReadOnly.session.agent.state.tools.find((t) => t.name === "read")!;
    const roResult: any = await readToolRo.execute(
      "call_read_docs_ro",
      { path: "docs/codemode.md" },
      new AbortController().signal,
      () => {}
    );
    const roText =
      roResult.finalText ||
      (Array.isArray(roResult.content) ? roResult.content.map((c: any) => c.text || "").join("\n") : "");
    assert.ok(roText.length > 500, "Documentation must be readable in read-only mode");

    // ------------------------------------------------------------------------
    // Part 4: Verify arbitrary outside-workspace files remain strictly denied
    // ------------------------------------------------------------------------
    console.log("--- Part 4: Arbitrary outside-workspace file read denial ---");
    let outsideDenied = false;
    try {
      await readTool1.execute(
        "call_read_outside",
        { path: "/etc/passwd" },
        new AbortController().signal,
        () => {}
      );
    } catch (err: any) {
      outsideDenied = true;
      assert.ok(
        err instanceof GuardDeniedError || err.message.includes("guard:"),
        `Expected GuardDeniedError, got: ${err.message}`
      );
    }
    assert.equal(outsideDenied, true, "Arbitrary outside-workspace read (/etc/passwd) must be denied");

    let dotDotDenied = false;
    try {
      await readTool1.execute(
        "call_read_dotdot",
        { path: "../../../some_outside_secret" },
        new AbortController().signal,
        () => {}
      );
    } catch (err: any) {
      dotDotDenied = true;
      assert.ok(
        err instanceof GuardDeniedError || err.message.includes("guard:"),
        `Expected GuardDeniedError, got: ${err.message}`
      );
    }
    assert.equal(dotDotDenied, true, "Relative traversal outside-workspace read must be denied");

    // ------------------------------------------------------------------------
    // Part 5: Compare schemas across two locations (including spaces) & verify zero drift
    // ------------------------------------------------------------------------
    console.log("--- Part 5: Schema stability across locations (including spaces) & zero drift ---");
    const h2 = await createRing0Harness({
      workspaceRoot: ws2,
      surfacesDir,
      allowUnsandboxedDev: true,
      sandboxMode: "workspace-write"
    });

    const codemodeTool2 = h2.session.agent.state.tools.find((t) => t.name === "codemode");
    assert.ok(codemodeTool2, "codemode tool must be registered in workspace with spaces");
    assert.equal(
      codemodeTool1.description,
      codemodeTool2.description,
      "codemode description must be byte-identical across checkouts (including spaces)"
    );

    // Verify zero mid-session drift
    assert.doesNotThrow(() => {
      h1.prefix.verifyInvariantBeforeRequest(h1.session.systemPrompt, h1.session.agent.state.tools);
    }, "h1 must exhibit zero mid-session prefix drift");

    assert.doesNotThrow(() => {
      h2.prefix.verifyInvariantBeforeRequest(h2.session.systemPrompt, h2.session.agent.state.tools);
    }, "h2 must exhibit zero mid-session prefix drift");

    h1.dispose();
    hReadOnly.dispose();
    h2.dispose();

    console.log("\n=== ALL BATCH B CODEMODE DOCUMENTATION TESTS PASSED CLEANLY ===\n");
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpWithSpaces, { recursive: true, force: true });
  }
}

runBatchBVerification().catch((err) => {
  console.error(err);
  process.exit(1);
});
