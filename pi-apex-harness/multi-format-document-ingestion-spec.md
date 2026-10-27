# Specification: bounded multi-format document ingestion and export

**Status:** Implementation integrated through Ring 13; full regression, tool-level path checks, browser E2E, and external-office interoperability remain open release gates.  
**Research:** [`research/multi-format-ingestion-harness-review-2026-10-27.md`](research/multi-format-ingestion-harness-review-2026-10-27.md)  
**Date:** 2026-10-27

## 1. Goal

Add first-class, tested local ingestion for PDF, DOCX, PPTX, XLSX, HTML, Markdown and plain text, plus a separate structured export path for PDF, DOCX, PPTX, XLSX, HTML, Markdown and plain text. Preserve Pi-Apex's personal/local security model, defer parsers from the active model schema, make extracted content explicitly untrusted, and preserve source provenance and uncertainty.

Research candidate: pin `officeparser@8.3.0` exactly behind an internal adapter after audit; add `pdf-lib@1.17.1` only for its native PDF generator, avoiding a Puppeteer/headless-browser dependency. officeParser 8.3.0 has five direct dependencies (`fflate`, `file-type`, `pdfjs-dist`, `tesseract.js`, `@xmldom/xmldom`) and is a new release on the review date. Its own security policy warns of parser attack surface, single-maintainer best-effort security, and a need for external isolation/resource limits. Therefore no file is parsed in the main server process; OCR is explicitly disabled; no parser fallback may fetch a CDN; PDF generation uses the native engine. If package smoke, dependency/license audit, or the restricted-process tests fail, stop and amend the adapter/dependency choice before shipping; do not silently fall back to an unconfined parser.

## 2. Scope and non-goals

### Included

- One explicit document attachment in Mission Control chat; preview filename/type/size, then pass extracted text/structure and source locations into the prompted turn.
- Deferred `document_read` for a named relative file under the current workspace, for CLI/RPC and agent-directed access. It never crawls folders.
- One internal `DocumentIngestionService`/adapter interface used by both paths.
- A provenance-bearing, bounded internal document representation; extraction status/warnings/truncation are explicit.
- Deferred `document_export` for simple structured reports (title, headings, paragraphs, bullets, tables) into the selected output format. Export writes only through validated workspace paths and the durable writer, with the existing interaction approval path.
- Core export formats: PDF, DOCX, PPTX, XLSX, HTML, Markdown and TXT. Format fidelity is explicitly bounded: this generates new simple artifacts; it is not a full Office editor or fidelity-preserving round trip.
- Exact-version OSS attribution, lockfile, dependency/license inventory and a standalone release/test record.

### Not included

- OCR, image-only/scanned PDF text recognition, video, e-mail/archive crawling, database ingestion, remote URL/file downloading, external relationships resolution, macro execution, embedded-object execution, or automatic folder indexing.
- Silent provider-side file forwarding: files are extracted locally and resulting context is sent only as part of the user's normal prompt to the currently selected model. UI must disclose that document text enters the model request.
- Full-fidelity conversion preserving all layouts/styles, comments, tracked changes, formulas, charts, macros, arbitrary images, attachments, hyperlinks, or embedded media. Formula cells are never evaluated; workbook formula text/cached values are labeled as such.
- DOC/PPT/XLS legacy formats, ODF and EPUB in this phase.
- Unbounded multi-file batches or background indexing.

## 3. Format behavior contract

| Input | Extracted representation | Known limits and truthful warnings |
|---|---|---|
| PDF | Text/heading/table/list items with 1-based page provenance and page-level text availability | No OCR by default. If a page has no text layer, report it as unreadable/scanned-looking; never claim complete extraction. Encrypted/password-protected PDF is a clear refusal in v1. |
| DOCX | Ordered headings/paragraphs/tables and source locator (paragraph/table/row/cell where supported) | Do not execute macros or external relationships; omit or mark embedded media. Surface parser limitations. |
| PPTX | Ordered slide titles, text, tables, notes if safely exposed, and 1-based slide provenance | Do not load external media/relationships. Mark missing/unsupported chart/image content. |
| XLSX | Workbook/sheet names, bounded cell ranges and values; preserve cell coordinates; formula and cached value kept distinct | Never calculate formulas or fetch external links. Cap sheet/cell count and rendered text. |
| HTML | Local markup converted to readable text/heading/table structure | Strip script/style/template/noscript; do not execute JS, load CSS, fetch URLs or dereference external resources. Preserve local source locator where available. |
| Markdown/TXT | Text and headings with line/section provenance | UTF-8 only in v1; invalid binary/text mismatch is refused. |

For every input, returned material is wrapped/labeled as **untrusted document content**. Secret scrubber is applied before model context. Source paths/names are relative or basename-only; never reveal arbitrary host absolute paths to the model. Extraction metadata includes detected format, parser version, pages/slides/sheets processed, truncation, warnings, and source locators. If the parser cannot provide a locator, mark it unavailable rather than inventing one.

## 4. Resource and security limits

- Maximum compressed input: 25 MiB; one attached document per prompt.
- Maximum extracted text passed into one prompt: 100,000 characters. Deferred `document_read` returns a default excerpt of at most 12,000 characters with explicit continuation/page/slide/sheet selectors; a caller cannot exceed the hard cap.
- Hard structural caps: PDF 250 pages; PPTX 200 slides; XLSX 25 sheets and 100,000 non-empty cells total; HTML 5 MiB source. Any stricter parser/package cap also applies.
- OOXML expansion: enforce central-directory entry count, per-entry bytes, aggregate expanded bytes and compression-ratio caps before parsing, and pass corresponding library decompression limits when supported. Reject ZIP traversal names, duplicates, encrypted archives, malformed central directory and unsupported relationships. No extraction to arbitrary paths.
- Parser execution: separate child process using bwrap with a clean environment, network and PID namespace disabled, exact input read-only, parser dependencies read-only, only a private temp directory writable, and no bind of home or unrelated workspace files. Apply a hard wall-clock deadline, memory/CPU limits where supported, kill the entire parser process group on timeout, bound stdout/stderr, and clean temp files on success/error/cancel. If the confinement primitives cannot be established, fail closed and report the document feature unavailable; no in-process fallback.
- Validate file extension and actual signature/container contents; do not trust MIME supplied by the browser. Enforce body/request bounds before buffering. Input files are never persisted beyond private temporary processing unless the user explicitly writes an output artifact.
- HTML export escapes untrusted text and emits no scripts, event attributes, remote resources, or untrusted raw HTML. Office exports are generated only from the safe structured document schema, never by copying active content from the source file.
- Workspace reads use `openat2` beneath the pinned workspace descriptor; export targets use the existing path guard and descriptor-relative durable writer. Reject absolute/traversing paths, symlinks, secret/control-plane paths, and overwriting non-regular objects. Call `beforeAction("write", ...)` before export; hard denies remain non-overridable.
- Content is ephemeral except for ordinary session transcript behavior and an explicitly saved output file. No extracted text/AST is added to SQLite, cache, global memory, logs or telemetry.

## 5. User-facing interface

- Mission Control picker accepts only `.pdf,.docx,.pptx,.xlsx,.html,.htm,.md,.txt`. Drag/drop follows the same rules. Show filename, detected type, size and pending/removed state; do not upload until the user sends the prompt.
- Server reparses and validates the actual bytes at send time; browser preview is not trusted. Add one document payload field to the prompt API, not a general arbitrary multipart/file-write endpoint.
- When a document is attached, append a clearly delimited untrusted document payload with source locator and extraction warning metadata to the user's prompt. Enforce selected model input capability only for images; document text is ordinary text context.
- `document_read` is deferred/on-demand, takes a relative workspace path plus optional safe locator/page range, and returns bounded excerpts. Listing/guessing other workspace files is not part of this tool.
- `document_export` is deferred/on-demand and accepts `format`, a safe relative output path and a bounded structured content object. Reject unsupported fields, unsafe paths and invalid shape. Return the written path, format, byte count, SHA-256 and truthful caveats. Use the approved durable write path and approval callback; no direct unchecked `fs.writeFile`.
- Tool schemas remain deferred; verify active-schema count, static prefix hash, and all existing Ring 0–12 invariants remain unchanged.

## Implementation and verification status (2026-10-27)

- **Dependency gate:** Exact pins `officeparser@8.3.0` and `pdf-lib@1.17.1` are in the lockfile; Ring 13 resolves only the transitive runtime dependency closure for the sandbox, mounting those package directories read-only rather than exposing the entire application `node_modules`. `npm audit --omit=dev` reports **0 vulnerabilities**. Dependency sub-tree license inventory and external attribution record still need a final, explicit review before release; package metadata and upstream project/security-policy references are in the research report above.
- **Reader/worker:** Implemented for all seven input formats, with bounded extraction, locators/warnings, signature checks, hostile OOXML ZIP preflight, HTML inertness, secret scrub, and untrusted-content wrappers. Bubblewrap is resolved only from fixed system paths and must be a root-owned, non-group/world-writable executable in a root-owned, non-writable parent. No in-process parser fallback. The sandbox mounts the Node runtime and parser dependency closure read-only, private `/tmp`, no workspace/home, clean environment, PID/network namespaces, and CPU/file/process/open-file limits.
- **Memory limitation disclosed:** Worker V8 heap is capped at 512 MiB; PDF.js is configured for a separate 1 GiB process cap. An OS `RLIMIT_AS` cap was removed after Node 22/undici WebAssembly allocations failed under a finite address-space cap; do **not** describe this as a verified RSS or total-memory ceiling. Wall-clock/process termination and other rlimits are tested. Consider cgroup-level memory enforcement as a follow-up before untrusted multi-tenant use; this feature is intended for the personal local harness.
- **UI and server:** Single-document picker/preview, supported-extension filtering, disclosure, send-time parsing and text attachment are implemented. Chromium-driven UI/route tests remain blocked because Headless Chromium is unavailable in this environment; visual sign-off is not claimed.
- **Exporter:** Separate strict structured-content generation exists for all seven outputs, routed through the approved path guard and power-loss-safe writer. Ring 13 generated each format and reopened it with the isolated reader. This is package round-trip coverage, not a LibreOffice/other-vendor interoperability claim.
- **Latest Ring 13:** **38 assertions passed** with system Bubblewrap 0.12.0, including every supported format, provenance, sandbox confinement, hostile content, ZIP edge cases, cancellation/timeout and generation round-trips. `npm run typecheck` and `npm audit --omit=dev` pass (0 vulnerabilities). Tier A/B and Rings 1–3, 5–6, 10, 12–13 passed in the broad run. Ring 4 remains failed/unresolved: a child `bin/pi-apex -p "/doctor"` returned `spawnSync.status === null` with empty stdout/stderr under its 25-second timeout; cause not established. Rings 7–9 and 11 are blocked by unavailable Headless Chromium. See `test/ring13/run-ring13-tests.ts` for executable coverage.

## 6. Implementation phases

### Phase 0 — parser/dependency gate

- Pin exact `officeparser@8.3.0` (MIT) and, for the native PDF writer, `pdf-lib@1.17.1` (MIT) only after inspecting its security policy, lockfile dependency tree/licenses and build artifacts. The `npm audit --omit=dev` pass currently reports zero vulnerabilities; the initial production-tree license inventory reports the app itself `UNLICENSED` and otherwise permissive common licenses, but the final added-package sub-tree attribution list still needs recording. No auto-install, dynamic latest, network fallback or `npx` execution at runtime.
- Explicitly configure `ocr: false`, bounded `decompressionLimits`, PDF `separateProcess: true` with a low `processMemoryMb` and text/operator/time caps, and `pdfConfig.engine: "native"` for PDF export. Do not permit CDN/remote worker fallback. The outer child process is still required because most parser paths cannot be interrupted by the package AbortSignal.
- Build smoke fixtures for each requested input/output format; verify AST/provenance shape and round-trip readability. Confirm API supports externally killable parsing and per-input/decompression limits.
- Prove bwrap child can see only needed runtime, installed parser code and the one temporary input; test no network and no unrelated workspace/home access. If any assertion fails, stop and revise this spec before product integration.

### Phase 1 — normalized reader and worker

- Define strict internal schema and format adapter; implement signature checks, limits, secret scrubbing, untrusted labels, structured errors and path provenance.
- Add safe `document_read` through deferred dispatcher and test from actual Codemode tool search/invocation.

### Phase 2 — chat attachment

- Add picker/drop and preview state; server-side byte/signature validation; local isolated parse; prompt attachment composition and transcript behavior.
- Add real Chromium integration tests for selection, removal, limits, malformed MIME/signature mismatch, successful supported format send, transcript disclosure and cleanup.

### Phase 3 — export generators

- Implement the bounded shared document content schema and separate output adapters for PDF/DOCX/PPTX/XLSX/HTML/Markdown/TXT.
- Write through guardrails, user-approval hook, durable write and path restrictions. No direct arbitrary filesystem mutation.
- Validate signatures/ZIP packages; reparse outputs with the adapter; verify fields/tables/sheets/slides/pages and HTML sanitization. Use LibreOffice if explicitly present for optional interoperability tests, but deterministic core tests must not depend on it.

### Phase 4 — docs, compatibility and full regression

- Document supported formats, limits, extraction caveats, local-vs-provider data handling and exporter fidelity.
- Add Ring 13 tests and `npm test` integration. Test Rings 0–12 and existing Tier A/B. Add release record with expected/actual cases, dependency inventory, limitation list, and any failed tests.

## 7. Acceptance criteria

- All declared input formats parse only supported fixtures with correct per-page/slide/sheet/cell provenance; all unsupported, encrypted, malformed, oversized, signature-mismatched and zip-bomb fixtures fail closed with bounded safe errors.
- Scanned PDF is explicitly marked no-text/partial; no OCR or complete-coverage claim.
- Hostile HTML and OOXML prompt injections are labeled untrusted; scripts/macros/external relationships never execute or fetch.
- Resource-limit, timeout, cancellation and cleanup tests prove the parser child is killed and temp files removed; network/home/out-of-scope workspace access is blocked in bwrap tests.
- Attachment UI/server E2E validates at least one fixture per format and rejects four adversarial cases per format family. Tool-level path reads and exports are contained; approval is required according to Ring 11 mode matrix, Turbo only skips confirmation and does not bypass hard guardrails.
- Each output format creates a valid file signature/package that can be parsed/reopened by the expected adapter and retains the safe content (including spreadsheet values, slide ordering, document headings/tables). HTML contains no script or remote resource. Spreadsheet formulas are text/cached values only and are not calculated.
- Existing Ring 0–12 regression invariants, zero active schema/prefix drift, approvals, WAL/durable-write, `openat2`, secret scrub, and sandbox boundaries all pass.
- No credentials, original document bytes, or extracted content are put in fixtures/logs/docs; all security fixtures are synthetic.

## 8. Required manual/live checks

- Open the updated Settings/chat UI in real Chromium and review attachment layout and errors; don't claim visual sign-off from DOM assertions alone.
- Use at least one real, non-sensitive PDF, DOCX, PPTX and XLSX from common office producers; compare extraction against source content and record visual/structural limitations. No sensitive personal files are required for CI.
- Verify outputs in at least one standard office reader (LibreOffice when available) and a PDF reader; if unavailable, mark real-reader interoperability unverified rather than silently passing based on package self-roundtrip only.
- Real provider calls are optional, but report whether tests were fake/local or live. Do not put any API key in fixture or command history.

## 9. Open release gates

- Complete the dependency/license inventory and add truthful OSS attribution; do not claim source reuse where only a dependency is used.
- Add/test `document_read` and `document_export` through the actual deferred tool dispatcher, including secret/control-plane/symlink path denials, exact approval behavior, locator selectors, and no-content behavior for an empty selected sheet/slide/page.
- Diagnose Ring 4's child-process timeout and rerun it; complete all remaining regression suites, then run Ring 7–9/11 browser coverage once a compatible Headless Chromium is available.
- Review attachment layout and error states in real Chromium; visual sign-off is pending.
- Where available, run output interoperability against LibreOffice or another independent office reader and inspect one non-sensitive sample from common producers; otherwise explicitly leave these checks unverified.
- Reassess total memory enforcement. V8 heap limits plus process resource limits are present; no OS-wide RSS/address-space ceiling is claimed because the tested `RLIMIT_AS` setting broke Node 22 runtime allocations.
