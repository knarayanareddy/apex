/**
 * Ring 5 — Self-Contained Mission-Control Operator Cockpit UI (`src/ring5/mission-control-ui.ts`).
 *
 * PREVIEW & CONFINEMENT GUARANTEES:
 *  - Zero external CDN scripts, stylesheets, or fonts (renders instantaneously offline or in sandboxed previews).
 *  - Strictly relative API & SSE URLs (`./api/...` and `new EventSource("./api/events")`) — zero `localhost`
 *    or `127.0.0.1` literals so reverse-proxied browser previews (`https://{port}-{sandboxId}.e2b.app`)
 *    and local desktop browsers work identically.
 */

import { TASK_MODE_RULES } from "./task-mode-routing.ts";

let _validatedInlineScript = false;

export function renderMissionControlHtml(): string {
  const taskModeRulesJson = JSON.stringify(TASK_MODE_RULES.map((rule) => ({ mode: rule.mode, pattern: rule.pattern.source, flags: rule.pattern.flags, reason: rule.reason })));
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pi-Apex Studio — Personal Agent Workspace (v4.1.0)</title>
  <style>
    :root {
      --bg: #0b0f17;
      --panel: #121826;
      --panel-alt: #182033;
      --border: #25314d;
      --text: #e6edf7;
      --muted: #8b9bb4;
      --accent: #38bdf8;
      --accent-dim: rgba(56, 189, 248, 0.14);
      --ok: #22c55e;
      --ok-dim: rgba(34, 197, 94, 0.14);
      --warn: #f59e0b;
      --warn-dim: rgba(245, 158, 11, 0.15);
      --danger: #ef4444;
      --danger-dim: rgba(239, 68, 68, 0.16);
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font-family: var(--sans);
      font-size: 13.5px;
      line-height: 1.45;
    }
    header {
      background: linear-gradient(180deg, #131b2e 0%, #0e1422 100%);
      border-bottom: 1px solid var(--border);
      padding: 14px 20px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .brand-dot {
      width: 11px;
      height: 11px;
      border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 10px var(--ok);
    }
    .brand h1 {
      margin: 0;
      font-size: 16px;
      font-weight: 650;
      letter-spacing: -0.01em;
    }
    .brand span {
      color: var(--muted);
      font-size: 12px;
      font-family: var(--mono);
    }
    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
    }
    .badge {
      font-family: var(--mono);
      font-size: 11.5px;
      padding: 4px 9px;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: var(--panel);
      color: var(--text);
    }
    .badge.ok { border-color: rgba(34,197,94,0.45); background: var(--ok-dim); color: #86efac; }
    .badge.warn { border-color: rgba(245,158,11,0.45); background: var(--warn-dim); color: #fcd34d; }
    .badge.danger { border-color: rgba(239,68,68,0.45); background: var(--danger-dim); color: #fca5a5; }
    .badge.accent { border-color: rgba(56,189,248,0.45); background: var(--accent-dim); color: #7dd3fc; }
    .toolbar {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }
    button {
      background: var(--panel-alt);
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 6px 11px;
      font-size: 12.5px;
      font-weight: 550;
      cursor: pointer;
      transition: border-color 0.15s, background 0.15s;
    }
    button:hover { border-color: var(--accent); background: #1e2942; }
    button.primary { background: #0284c7; border-color: #38bdf8; color: #fff; }
    button.primary:hover { background: #0369a1; }
    button.success { background: #15803d; border-color: #22c55e; color: #fff; }
    button.danger { background: #b91c1c; border-color: #ef4444; color: #fff; }
    nav.tabs {
      display: flex;
      gap: 4px;
      padding: 10px 20px 0;
      border-bottom: 1px solid var(--border);
      background: #0e1422;
      overflow-x: auto;
    }
    nav.tabs button {
      border-bottom-left-radius: 0;
      border-bottom-right-radius: 0;
      border-bottom: none;
      background: transparent;
      color: var(--muted);
      padding: 8px 14px;
    }
    nav.tabs button.active {
      background: var(--bg);
      color: var(--accent);
      border-color: var(--border);
      font-weight: 650;
    }
    main {
      padding: 18px 20px 32px;
      max-width: 1440px;
      margin: 0 auto;
    }
    .toast {
      margin-bottom: 14px;
      padding: 10px 14px;
      border-radius: 7px;
      border: 1px solid var(--border);
      background: var(--panel);
      font-family: var(--mono);
      font-size: 12px;
      display: none;
      white-space: pre-wrap;
    }
    .toast.visible { display: block; }
    .toast.error { border-color: var(--danger); background: var(--danger-dim); color: #fecaca; }
    .toast.ok { border-color: var(--ok); background: var(--ok-dim); color: #bbf7d0; }
    .grid-2 {
      display: grid;
      grid-template-columns: 1fr 1.35fr;
      gap: 16px;
    }
    .grid-equal {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    @media (max-width: 960px) {
      .grid-2, .grid-equal { grid-template-columns: 1fr; }
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 9px;
      padding: 14px 16px;
    }
    .card h2 {
      margin: 0 0 10px;
      font-size: 14px;
      font-weight: 650;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .muted { color: var(--muted); font-size: 12px; }
    .mono { font-family: var(--mono); }
    .list-item {
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 7px;
      background: var(--panel-alt);
      margin-bottom: 8px;
      cursor: pointer;
    }
    .list-item:hover, .list-item.selected {
      border-color: var(--accent);
    }
    .code-lines {
      background: #090d15;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 10px;
      font-family: var(--mono);
      font-size: 12px;
      max-height: 300px;
      overflow: auto;
    }
    .code-line {
      display: flex;
      gap: 10px;
      padding: 2px 6px;
      border-radius: 4px;
    }
    .code-line:hover { background: rgba(56, 189, 248, 0.1); }
    .line-num {
      color: var(--muted);
      min-width: 28px;
      text-align: right;
      user-select: none;
    }
    input, textarea, select {
      width: 100%;
      background: #090d15;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 9px;
      font-family: var(--sans);
      font-size: 12.5px;
      margin-top: 4px;
      margin-bottom: 8px;
    }
    textarea { font-family: var(--mono); min-height: 76px; resize: vertical; }
    .row { display: flex; gap: 8px; align-items: center; }
    pre.surface-box {
      background: #090d15;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 11px;
      font-family: var(--mono);
      font-size: 12px;
      white-space: pre-wrap;
      max-height: 290px;
      overflow: auto;
      margin: 6px 0 0;
    }
    .tab-pane { display: none; }
    .tab-pane.active { display: block; }
    .meter {
      height: 7px;
      background: #090d15;
      border-radius: 999px;
      overflow: hidden;
      border: 1px solid var(--border);
      margin-top: 6px;
    }
    .meter > div {
      height: 100%;
      background: linear-gradient(90deg, #22c55e, #38bdf8);
    }

    #tab-chat > .grid-equal { grid-template-columns:minmax(0,1.3fr) minmax(260px,.7fr); align-items:start; }
    .diff-disclosure, .media-tools { border:1px solid var(--border); border-radius:9px; padding:7px 10px; background:rgba(255,255,255,.45); }
    .diff-disclosure > summary, .media-tools > summary { cursor:pointer; color:var(--muted); font-size:12px; }
    .media-tools-content { display:flex; flex-wrap:wrap; gap:7px; align-items:center; padding-top:8px; }
    .media-tools-content label { display:flex; gap:6px; align-items:center; }
    .media-tools-content input[type="checkbox"] { margin:0; }
    .task-setup-disclosure { margin:6px 0 12px; border:1px solid var(--border); border-radius:11px; background:rgba(255,255,255,.55); }
    .task-setup-disclosure > summary { list-style:none; display:flex; align-items:center; gap:10px; cursor:pointer; min-height:42px; padding:8px 12px; color:var(--text); font-weight:600; }
    .task-setup-disclosure > summary::-webkit-details-marker { display:none; }
    .task-setup-disclosure > summary::after { content:"＋"; margin-left:auto; color:var(--muted); }
    .task-setup-disclosure[open] > summary::after { content:"−"; }
    .task-setup-summary { display:block; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11.5px; color:var(--muted); font-weight:450; }
    .task-setup-help { margin:0 12px 12px; }
    .task-routing-panel { margin:8px 0 12px; padding:10px 12px; border:1px solid var(--border); border-radius:10px; background:rgba(255,255,255,.42); }
    .task-routing-panel p { line-height:1.45; }
    :is(button, summary, input, select, textarea):focus-visible { outline:3px solid rgba(184,87,60,.42); outline-offset:2px; }
    .system-status { position:relative; }
    .system-status > summary { list-style:none; cursor:pointer; border:1px solid var(--border); border-radius:999px; padding:7px 11px; color:var(--muted); background:#fff; font-size:12px; }
    .system-status > summary::-webkit-details-marker, .nav-section > summary::-webkit-details-marker { display:none; }
    .system-status[open] .badges { position:absolute; right:0; top:42px; z-index:10; width:min(420px,88vw); padding:12px; border:1px solid var(--border); border-radius:12px; background:var(--bg); box-shadow:0 12px 34px rgba(28,25,23,.14); display:flex; flex-wrap:wrap; }
    .status-dot { color:var(--ok); margin-left:4px; }
    .attention-button { color:#8a471f; background:#fbf0dd; border-color:#ecd2a7; }
    .attention-button:hover { background:#f8e7c7; border-color:#d8b478; }
    .attention-button[hidden] { display:none; }
    /* Ring 10 — warm editorial Studio shell: zero external assets / fonts. */
    :root {
      --bg: #faf8f5; --panel: #fff; --panel-alt: #f7f4ef; --border: #e7e2da;
      --text: #292521; --muted: #777067; --accent: #b8573c; --accent-dim: #f8e9e2;
      --ok: #397454; --ok-dim: #e9f2eb; --warn: #a86622; --warn-dim: #fbf0dd;
      --danger: #b83b33; --danger-dim: #fae9e7;
      --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    body { background: var(--bg); color: var(--text); font-size: 14px; line-height: 1.55;
      display: grid; grid-template-columns: 248px minmax(0, 1fr); grid-template-rows: auto 1fr; min-height: 100vh; }
    header { grid-column: 1 / -1; position: sticky; top: 0; z-index: 5; padding: 13px 24px;
      background: rgba(250,248,245,.94); backdrop-filter: blur(14px); border-bottom: 1px solid var(--border); }
    .brand h1 { font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; font-size: 22px; font-weight: 600; letter-spacing: -.03em; }
    .brand-dot { background: var(--ok); box-shadow: 0 0 0 4px var(--ok-dim); width: 9px; height: 9px; }
    .brand span { font-family: var(--sans); font-size: 12px; max-width: 330px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; display:block; }
    .badges { gap: 6px; }
    .badge { font-family: var(--sans); background: #fff; border-color: var(--border); color: var(--muted); font-size: 11px; }
    .badge.ok { color: #326b4a; background: #eaf3ec; border-color: #cddfd1; }
    .badge.accent { color: #a14b32; background: #f8e9e2; border-color: #edd1c5; }
    button { color: var(--text); background: #fff; border: 1px solid var(--border); border-radius: 9px; padding: 8px 12px;
      font-weight: 560; transition: .16s ease; }
    button:hover { border-color: #c9a99c; background: #fcf7f4; transform: translateY(-1px); }
    button.primary { color: #fff; background: #b8573c; border-color: #b8573c; }
    button.primary:hover { background:#a84b33; }
    button.success { background: #397454; border-color: #397454; }
    nav.tabs { grid-column: 1; grid-row: 2; display: block; position: sticky; top: 78px; height: calc(100vh - 78px); overflow-y:auto;
      padding: 24px 14px; background: #f3efe9; border-right: 1px solid var(--border); border-bottom: 0; }
    nav.tabs .nav-section { margin:0 0 10px; padding:0 0 9px; border-bottom:1px solid rgba(231,226,218,.8); }
    nav.tabs .nav-section > summary { list-style:none; cursor:pointer; margin:0 10px 6px; padding:8px 10px; color:#938a7e; font:650 10px var(--sans); letter-spacing:.13em; text-transform:uppercase; }
    nav.tabs .nav-section > summary::after { content:"＋"; float:right; color:#aaa197; }
    nav.tabs .nav-section[open] > summary::after { content:"−"; }
    nav.tabs button { display:flex; width:100%; align-items:center; text-align:left; border:0; border-radius:9px; margin:3px 0; padding:9px 11px; color:#625c54; font-size:12.5px; background:transparent; }
    nav.tabs button.active { background:#fff; color:#9e472f; box-shadow:0 1px 3px rgba(40,30,20,.07); font-weight:650; }
    nav.tabs button:hover { background:rgba(255,255,255,.7); transform:none; }
    .toolbar { align-items:center; gap:7px; }
    main { grid-column:2; grid-row:2; width:100%; max-width:1600px; margin:0; padding:28px clamp(18px,3vw,48px) 48px; }
    .tab-pane.active { animation: studioIn .22s ease-out; }
    @keyframes studioIn { from { opacity:.55; transform:translateY(4px) } to { opacity:1; transform:none } }
    .card { background:var(--panel); border-color:var(--border); border-radius:14px; padding:20px; box-shadow:0 2px 10px rgba(28,25,23,.035); }
    .card h2 { font-family:"Iowan Old Style", "Palatino Linotype", Georgia, serif; font-size:17px; font-weight:600; letter-spacing:-.015em; }
    .list-item { background:#fff; border-color:#eee9e1; border-radius:10px; }
    input,textarea,select { background:#fff; color:var(--text); border-color:#e2ddd5; border-radius:9px; padding:10px 12px; font-size:13px; }
    textarea { font-family:var(--sans); }
    pre.surface-box,.code-lines { background:#f7f5f1; color:#403a34; border-color:#e9e4dc; border-radius:10px; }
    .code-line:hover { background:#f5e9e2; }
    .meter { background:#f1eee8; border-color:#e4dfd7; }
    .meter > div { background:linear-gradient(90deg,#7ca787,#c96442); }
    #quickSetupModal,#commandPalette { position:fixed; inset:0; z-index:20; background:rgba(35,30,25,.32); backdrop-filter:blur(5px); display:none; align-items:center; justify-content:center; padding:18px; }
    #quickSetupModal.open,#commandPalette.open { display:flex; }
    .modal-card { width:min(680px,100%); max-height:88vh; overflow:auto; background:var(--bg); border:1px solid var(--border); border-radius:18px; padding:24px; box-shadow:0 24px 80px rgba(28,25,23,.2); }
    .modal-card h2 { font:600 25px "Iowan Old Style", Georgia, serif; margin:0 0 5px; }
    .modal-head { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:18px; }
    .setup-section { border-top:1px solid var(--border); padding-top:16px; margin-top:16px; }
    .setup-section h3 { font:600 16px "Iowan Old Style", Georgia, serif; margin:0 0 3px; }
    #paletteResults button { width:100%; text-align:left; margin:3px 0; }
    @media(max-width:900px) { body { display:block; } #tab-chat > .grid-equal { grid-template-columns:1fr; } header { position:relative; } nav.tabs { position:relative; top:auto; height:auto; display:flex; overflow-x:auto; padding:8px; border-right:0; border-bottom:1px solid var(--border); } nav.tabs .nav-section { min-width:140px; } nav.tabs .nav-section summary { white-space:nowrap; } nav.tabs button { width:100%; white-space:normal; } main { padding:18px 12px 34px; } .badges { display:none; } }
    html[data-theme="dark"] { --bg:#191715; --panel:#211f1c; --panel-alt:#292622; --border:#37332e; --text:#f1ebe3; --muted:#aca398; --accent:#d97757; --accent-dim:#3b2923; --ok:#81b393; --ok-dim:#26382c; --warn:#e0ae69; --warn-dim:#3b3021; --danger:#e17c73; --danger-dim:#3d2523; }
    html[data-theme="dark"] header { background:rgba(25,23,21,.94); }
    html[data-theme="dark"] nav.tabs { background:#141311; }
    html[data-theme="dark"] .system-status > summary { background:#211f1c; color:var(--text); }
    html[data-theme="dark"] .task-setup-disclosure { background:#211f1c; }
    html[data-theme="dark"] .task-routing-panel { background:#211f1c; }
    html[data-theme="dark"] .system-status[open] .badges { background:#211f1c; }
    html[data-theme="dark"] .attention-button { background:#3b3021; color:#e0ae69; border-color:#665338; }
    html[data-theme="dark"] .list-item, html[data-theme="dark"] input, html[data-theme="dark"] textarea, html[data-theme="dark"] select, html[data-theme="dark"] button { background:#211f1c; color:var(--text); }
    html[data-theme="dark"] button.primary { background:#b8573c; color:#fff; }
    html[data-theme="dark"] pre.surface-box, html[data-theme="dark"] .code-lines { background:#181614; color:var(--text); }
    html[data-theme="dark"] .modal-card { background:#211f1c; }
    @media(prefers-reduced-motion:reduce) { *,*::before,*::after { animation-duration:.01ms!important; transition-duration:.01ms!important; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-dot" id="sseDot" title="SSE Live Connection"></div>
      <div>
        <h1>Pi-Apex Studio</h1>
        <span id="workspaceLabel">Your private agent workspace</span>
      </div>
    </div>
    <details class="system-status">
      <summary aria-label="Show system status">Status <span class="status-dot" aria-hidden="true">●</span></summary>
      <div class="badges">
        <span class="badge ok" id="schemaBadge">Schema: 1053 o200k</span>
        <span class="badge accent" id="prefixBadge">Prefix: -- / 2100</span>
        <span class="badge ok" id="guardrailsBadge">GUARDRAILS Pin: Verified</span>
        <span class="badge accent" id="modelCacheBadge">Model: -- | Cache: 0%</span>
        <span class="badge" id="planModeBadge">Mode: --</span>
      </div>
    </details>
    <div class="toolbar">
      <button id="btnAttention" class="attention-button" type="button" hidden aria-label="Needs your attention">Needs your attention</button>
      <button id="btnCommandPalette" title="Command palette (⌘K)">⌘K</button>
      <button class="primary" id="btnNewSession">New task</button>
    </div>
  </header>

  <nav class="tabs sidebar-nav" aria-label="Studio navigation">
    <details class="nav-section" open>
      <summary>Work</summary>
      <button class="active" data-tab="tab-chat" aria-current="page">◉ &nbsp; Chat &amp; changes</button>
      <button data-tab="tab-artifacts">◇ &nbsp; Plans &amp; review</button>
      <button data-tab="tab-ring7">↗ &nbsp; Build &amp; browser</button>
      <button data-tab="tab-ring8">⌘ &nbsp; Issues &amp; IDE</button>
      <button data-tab="tab-rewind">↶ &nbsp; History &amp; rewind</button>
    </details>
    <details class="nav-section">
      <summary>Library</summary>
      <button data-tab="tab-ring9">✳ &nbsp; Agents &amp; channels</button>
      <button data-tab="tab-models-mcp">◌ &nbsp; Models &amp; tools</button>
      <button data-tab="tab-quarantine">◇ &nbsp; Skills library</button>
    </details>
    <details class="nav-section">
      <summary>Settings</summary>
      <button data-tab="tab-settings">⚙ &nbsp; Settings &amp; safety</button>
      <button data-tab="tab-evolution">⌁ &nbsp; Memory &amp; console</button>
    </details>
  </nav>

  <main>
    <div id="toast" class="toast"></div>

    <!-- TAB 0 (v2): LIVE STREAMING CHAT & UNIFIED GIT DIFF VIEWER -->
    <section id="tab-chat" class="tab-pane active">
      <div class="grid-equal">
        <div class="card">
          <h2>
            <span>Conversation</span>
            <span class="muted" id="chatStreamingBadge">idle</span>
          </h2>
          <div id="chatTranscriptBox" style="max-height:360px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;margin-bottom:10px;"></div>
          <pre class="surface-box" id="liveStreamBox" style="display:none;min-height:48px;border-color:#38bdf8;"></pre>
          <div class="row" style="justify-content:space-between;margin:12px 0 4px;">
            <span class="muted">Choose how Pi-Apex approaches this task.</span>
            <button id="btnTogglePlan" type="button">Plan mode</button>
          </div>
          <section id="taskRoutingPanel" class="task-routing-panel" aria-label="Task mode and routing">
            <div class="row" style="align-items:end;flex-wrap:wrap;">
              <label for="taskModeSelect" class="muted" style="flex:1;min-width:200px;">Task mode<select id="taskModeSelect" aria-describedby="taskSuggestionReason">
                <option value="automatic">Normal prompt — no workflow override</option><option value="quick">Quick answer</option><option value="goal">Goal — complete and verify</option><option value="plan">Plan — read-only planning</option><option value="browser">Browser research</option><option value="teamwork">Teamwork — multi-agent</option><option value="schedule">Schedule — prepare, then confirm</option>
              </select></label>
              <button id="btnUseTaskSuggestion" type="button">Use suggestion</button>
            </div>
            <p id="taskSuggestionReason" class="muted" role="status" aria-live="polite" style="margin:0 0 4px;">Type a task to see a local suggestion. Nothing is selected or dispatched automatically.</p>
            <div class="row" style="align-items:end;flex-wrap:wrap;margin-top:6px;">
              <label for="taskModelRouting" class="muted" style="flex:1;min-width:230px;">Model routing<select id="taskModelRouting" aria-describedby="taskModelRoutingHelp">
                <option value="current">Keep selected model</option><option value="auto" disabled>Auto route — configured planning / implementation models</option>
              </select></label>
            </div>
            <p id="taskModelRoutingHelp" class="muted" style="margin:0 0 4px;">Auto routing runs locally after Send, only when explicit planning and implementation targets are available. Ambiguous requests keep your selected model.</p>
            <p id="taskRouteResult" class="muted" role="status" aria-live="polite" style="margin:0 0 4px;">No per-request model route applied.</p>
          </section>
          <details id="taskSetupDisclosure" class="task-setup-disclosure">
            <summary><span>Task setup</span><span id="turnContextBadge" class="task-setup-summary">Model · reasoning · persona · profile · mode</span></summary>
            <div class="row" id="chatInteractionControls" style="flex-wrap:wrap;align-items:end;margin:12px 0 4px;">
              <label class="muted" style="flex:2;min-width:190px;">Model<select id="chatModelSelect"></select></label><button id="btnConnectProvider" type="button">Connect provider</button>
              <label class="muted" style="flex:1;min-width:110px;">Reasoning<select id="chatReasoning"><option>low</option><option selected>medium</option><option>high</option><option>max</option></select><small id="effectiveReasoning" class="muted">Effective: medium</small></label>
              <label class="muted" style="flex:1;min-width:130px;">Persona<select id="chatPersona"><option value="general">General</option><option value="architect">Architect</option><option value="builder">Builder</option><option value="reviewer">Reviewer</option><option value="pair-programmer">Pair programmer</option></select></label>
              <label class="muted" style="flex:1;min-width:130px;">Build profile<select id="chatBuildProfile"><option value="custom">Custom</option><option value="implement">Implement</option><option value="plan">Plan</option><option value="review">Review</option><option value="fast-local">Fast local</option></select></label>
              <label class="muted" style="flex:1;min-width:130px;">Execution mode<select id="chatExecutionMode"><option value="default">Default</option><option value="review">Review every command</option><option value="auto">Auto (policy)</option><option value="turbo">Turbo (fewer approval prompts)</option></select></label>
            </div>
            <p class="muted task-setup-help">Turbo skips confirmation prompts only. Sandbox limits and hard guardrails remain active.</p>
          </details>
          <div id="imageModelNotice" class="muted" role="status" style="display:none;margin-bottom:8px;">Selected model does not advertise image input; choose a multimodal model before attaching images.</div>
          <div id="turboWarning" role="status" class="badge" style="display:none;background:#fef3c7;color:#7c4a03;border-color:#e2a32b;margin-bottom:8px;">⚠ TURBO ACTIVE — skips confirmation prompts only; sandbox and hard guardrails remain on. Expires in 30 minutes.</div>
          <textarea id="chatPromptInput" rows="3" placeholder="Message your agent… attach an image or document, dictate, or type a /slash command."></textarea>
          <div id="imageAttachmentPreview" class="row" style="flex-wrap:wrap;margin:0 0 8px;"></div>
          <div id="documentAttachmentPreview" class="row" style="flex-wrap:wrap;margin:0 0 8px;"></div>
          <p id="documentPrivacyNotice" class="muted" style="margin:0 0 8px;">Document text is extracted locally and sent to the selected model only when you send the prompt. OCR is off; scanned PDFs may be incomplete.</p>
          <input id="imageFilePicker" type="file" accept="image/jpeg,image/png,image/webp" multiple style="display:none;"/><input id="documentFilePicker" type="file" accept=".pdf,.docx,.pptx,.xlsx,.html,.htm,.md,.txt" style="display:none;"/><input id="audioFilePicker" type="file" accept="audio/*" style="display:none;"/>
          <div class="row" style="margin-top:8px;flex-wrap:wrap;">
            <button id="btnAttachImage">＋ Image</button><button id="btnAttachDocument">＋ Document</button>
            <details class="media-tools">
              <summary>Voice &amp; audio</summary>
              <div class="media-tools-content">
                <button id="btnUploadAudio">♫ Upload audio</button><button id="btnRecordAudio">● Record</button><button id="btnCancelRecording">Cancel audio</button><button id="btnTranscribeAudio">Transcribe audio</button><label class="muted"><input type="checkbox" id="autoReadReplies" style="width:auto;"/> Auto-read replies</label>
              </div>
            </details>
            <button class="primary" id="btnSendPrompt">Send</button>
            <button id="btnSteerPrompt">Steer</button>
            <button class="danger" id="btnAbortTurn">Stop</button>
          </div>
          <div class="row" style="margin-top:8px;"><span id="speechStatus" class="muted">Checking speech options…</span><audio id="speechPlayer" controls style="display:none;max-width:100%;"></audio></div>
        </div>

        <div class="card">
          <h2>
            <span>Workspace changes</span>
            <div class="row">
              <button id="btnRefreshDiff">Refresh Diff</button>
              <button class="primary" id="btnRunBugBot">BugBot Diff Review</button>
            </div>
          </h2>
          <div class="muted" id="diffStatusSummary" style="margin-bottom:8px;">Clean working tree.</div>
          <details class="diff-disclosure">
            <summary>Inspect full diff <span class="muted">(git diff HEAD)</span></summary>
            <pre class="surface-box" id="diffViewerBox" style="max-height:410px;overflow:auto;">(no uncommitted diff against HEAD)</pre>
          </details>
        </div>
      </div>
    </section>

    <!-- TAB 1: TRUST ARTIFACTS & INLINE STEER -->
    <section id="tab-artifacts" class="tab-pane">
      <div class="grid-2">
        <div class="card">
          <h2>
            <span>Structured Trust Artifacts</span>
            <span class="muted" id="artifactCount">0 items</span>
          </h2>
          <div id="artifactList"></div>
          <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;" />
          <h2>Propose Plan Artifact</h2>
          <input id="newArtTitle" placeholder="Plan title (e.g. Zero-downtime auth token rotation)" />
          <textarea id="newArtMarkdown" placeholder="Plan:&#10;1. Inspect token validator&#10;2. Add dual-key verification&#10;3. Run tsc --noEmit"></textarea>
          <button class="primary" id="btnCreateArtifact">Create Plan Trust Artifact</button>
        </div>

        <div class="card">
          <h2>
            <span id="selectedArtTitle">Select an Artifact</span>
            <button class="success" id="btnApproveArtifact" style="display:none;">Approve Plan &amp; Unlock Exec</button>
          </h2>
          <div class="muted" id="selectedArtMeta">Click any artifact on the left to inspect numbered lines and send L-anchored steer() feedback.</div>
          <div class="code-lines" id="selectedArtLines" style="margin-top:10px;"></div>

          <div style="margin-top:12px;">
            <h2>Inline Line-Anchored Steer (Ring 2)</h2>
            <div class="row">
              <div style="flex:1;">
                <label class="muted">Start Line</label>
                <input type="number" id="steerStart" min="1" value="1" />
              </div>
              <div style="flex:1;">
                <label class="muted">End Line</label>
                <input type="number" id="steerEnd" min="1" value="2" />
              </div>
            </div>
            <label class="muted">Review Feedback (delivered via session.steer / nextTurn without prefix mutation)</label>
            <input id="steerComment" placeholder="e.g. Ensure fallback rejects expired signatures before DB lookup" />
            <button class="primary" id="btnSendSteer">Send Inline Steer Feedback</button>
          </div>
        </div>
      </div>
    </section>

    <!-- TAB 2: QUARANTINE & SKILL CURATOR -->
    <section id="tab-quarantine" class="tab-pane">
      <div class="grid-2">
        <div class="card">
          <h2>
            <span>Skills Library <span class="muted">Saved, shared, and quarantined skills</span></span>
            <button id="btnRefreshSkillLibrary">Refresh</button>
          </h2>
          <div class="row"><input id="skillLibrarySearch" placeholder="Search skills by name or description" style="flex:1;"/><select id="skillLibraryFilter" style="max-width:170px;"><option value="all">All statuses</option><option value="active">Active</option><option value="stale">Stale</option><option value="quarantined">Quarantine</option><option value="archived">Archived</option><option value="external">Compatible folders</option><option value="invalid">Needs attention</option></select></div>
          <div id="skillLibraryList" style="max-height:330px;overflow:auto;"><div class="muted">Refresh to scan workspace skill folders.</div></div>
          <h3>Skill details</h3><pre class="surface-box" id="skillLibraryDetail" style="max-height:300px;overflow:auto;white-space:pre-wrap;">Select a skill to inspect its SKILL.md and supporting files.</pre>
          <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;"/>
          <h3>Quarantine lifecycle ledger</h3>
          <div class="row"><div id="skillsList" style="flex:1;"></div><button id="btnLifecyclePass">Run lifecycle pass</button></div>
        </div>

        <div class="card">
          <h2>Create or import a skill</h2>
          <div class="muted">New or imported skills are scanned and staged in <code>.skills-quarantine/</code>. Review the scan and explicitly promote before activation. Supporting files are never executed.</div>
          <label class="muted">Import a local skill folder (must contain SKILL.md and optional references/scripts/assets)</label><input id="skillFolderImport" type="file" webkitdirectory multiple />
          <textarea id="distillSkillMd" style="min-height:150px;margin-top:8px;">---
name: safe-db-migration
description: Safe SQLite WAL migration checklist
---
# Safe SQLite Migration
1. Take online page backup via node:sqlite backup() API.
2. Run FTS5 integrity-check before and after schema migration.</textarea>
          <button class="primary" id="btnDistillSkill">Create / scan into quarantine</button>
          <button id="btnImportSkillFolder">Import selected folder</button>
          <pre class="surface-box" id="skillInspectBox">Select a skill on the left to inspect its SKILL.md and skills-guard-v10 scan findings.</pre>
        </div>
      </div>
    </section>

    <!-- TAB 3: GIT REWIND & WAL -->
    <section id="tab-rewind" class="tab-pane">
      <div class="grid-equal">
        <div class="card">
          <h2>
            <span>Captured <code>/tree</code> Git Checkpoints</span>
            <span class="muted" id="currentLeafBadge">leaf: --</span>
          </h2>
          <div class="muted" style="margin-bottom:10px;">Atomic rewind acquires kernel <code>flock(LOCK_EX|LOCK_NB)</code>, stashes dirty trees under <code>refs/pi-apex/safety/*</code>, and restores exact <code>{kind, hash, mode}</code> state.</div>
          <div id="checkpointList"></div>
        </div>

        <div class="card">
          <h2>Ring 0 Post-Effect WAL Ledger (<code>wal_intents</code>)</h2>
          <div class="muted" style="margin-bottom:10px;">Tracks <code>INTENT_LOGGED -> EXECUTING -> EFFECT_COMMITTED -> TRANSCRIPT_APPENDED</code> and halts on <code>OUTCOME_UNKNOWN</code>.</div>
          <div id="walList"></div>
        </div>
      </div>
    </section>

    <!-- TAB 4: DREAMING, HARNESS2 & SLASH CONSOLE -->
    <section id="tab-evolution" class="tab-pane">
      <div class="grid-equal">
        <div class="card">
          <h2>
            <span><code>surfaces/MEMORY.md</code> (Dreaming &lt;= 300 o200k)</span>
            <button class="primary" id="btnRunDream">Run Dreaming Pass</button>
          </h2>
          <div class="muted" id="memoryMeta">Session-pinned at boot; offline Dreaming updates apply on /new with 0 live prefix drift.</div>
          <div class="meter"><div id="memoryMeter" style="width:0%"></div></div>
          <pre class="surface-box" id="memoryBox"></pre>
        </div>

        <div class="card">
          <h2>
            <span><code>surfaces/EXPERIENCE.md</code> (Harness² 4-Gate &lt;= 220 o200k)</span>
            <span class="badge ok">Issue #94 Protected</span>
          </h2>
          <div class="muted" id="expMeta">Contrastive Propose-Probe-Compose confined strictly to EXPERIENCE.md.</div>
          <div class="meter"><div id="expMeter" style="width:0%"></div></div>
          <pre class="surface-box" id="expBox"></pre>
        </div>
      </div>

      <div class="grid-equal" style="margin-top:16px;">
        <div class="card">
          <h2>Operator Slash Command Console (+0 Schema Tokens)</h2>
          <div class="row">
            <input id="slashInput" value="/doctor" placeholder="/doctor, /plan status, /review uncommitted, /quarantine list, /evolve status" />
            <button class="primary" id="btnRunSlash" style="white-space:nowrap;">Run Command</button>
          </div>
          <pre class="surface-box" id="slashOutput">Ready. Run any /plan, /rewind, /review, /quarantine, /dream, /evolve, or /doctor command.</pre>
        </div>

        <div class="card">
          <h2>Live SSE Session &amp; Control-Plane Event Stream</h2>
          <pre class="surface-box" id="sseLog"></pre>
        </div>
      </div>
    </section>

    <!-- TAB 6 (v2): MODELS, OLLAMA, MULTI-SESSION SWITCHER & CONFINED MCP HUB -->
    <section id="tab-models-mcp" class="tab-pane">
      <div class="grid-equal">
        <div class="card">
          <h2>
            <span>Active Model, <code>apex/auto</code> Router &amp; Cache Telemetry</span>
            <button class="primary" id="btnUseApexAuto">Use apex/auto</button>
          </h2>
          <div class="muted" id="usageTelemetryLine" style="margin-bottom:8px;">Cache hit: 0% | Cost: $0.000000</div>
          <div class="row" style="margin-bottom:8px;"><input id="modelCatalogQuery" placeholder="Search models by name or ID"/><input id="modelProviderFilter" placeholder="Provider filter (optional)" style="max-width:220px"/><label class="muted"><input id="modelFavoritesOnly" type="checkbox" style="width:auto"/> Favorites</label><label class="muted"><input id="modelRecentOnly" type="checkbox" style="width:auto"/> Recent</label><button id="btnSearchModelCatalog">Search catalog</button><button id="btnRefreshRuntimeCatalog">Refresh configured providers</button><button id="btnRefreshRemoteCatalog">Refresh models.dev</button></div>
          <div id="modelCatalogResults" class="surface-box" style="max-height:220px;overflow:auto;margin-bottom:10px;">Search the installed provider catalog to browse large model lists.</div>
          <div class="row" style="margin-bottom:10px;">
            <select id="modelCatalogSelect" style="flex:1;padding:7px;background:#090d15;color:#e2e8f0;border:1px solid var(--border);border-radius:6px;"></select>
            <button id="btnSwitchModel">Switch Model</button>
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:10px 0;" />
          <h2>One-time OpenRouter model check (not saved)</h2>
          <p class="muted">Makes one short fixed prompt to OpenRouter. The key is sent only to this local server, held in memory for the request, never added to your vault or chat, and cleared from this form afterward. Free models can still be unavailable, rate-limited, or have changing terms.</p>
          <div class="row" style="margin-bottom:8px;"><input id="oneShotOpenRouterModel" placeholder="OpenRouter model ID (e.g. provider/model:free)" autocomplete="off"/><input id="oneShotOpenRouterKey" type="password" autocomplete="new-password" placeholder="One-time OpenRouter key — not saved"/><button class="primary" id="btnOneShotOpenRouterTest">Test once</button></div>
          <div id="oneShotOpenRouterResult" class="muted" style="margin-bottom:10px;"></div>
          <details style="margin:10px 0;border:1px solid var(--border);border-radius:10px;padding:12px;">
            <summary style="cursor:pointer;font-weight:700;">Temporary multi-turn chat test (key kept in RAM briefly)</summary>
            <p class="muted">Starts a temporary OpenRouter :free model in the regular model selector and chat transcript (up to 1,024 output tokens per model response). The key remains only in server memory for up to 5 minutes or 3 chat turns, then the provider is removed and the prior model is restored. Chat prompts and replies are recorded by the normal session transcript; no API key is persisted. Use the standard chat box after starting, then end the test when done.</p>
            <div class="row"><input id="ephemeralOpenRouterModel" value="poolside/laguna-s-2.1:free" placeholder="OpenRouter model ID (e.g. provider/model:free)" autocomplete="off"/><input id="ephemeralOpenRouterKey" type="password" autocomplete="new-password" placeholder="Temporary OpenRouter key — not saved"/><button class="primary" id="btnStartEphemeralOpenRouter">Start temporary chat</button><button id="btnEndEphemeralOpenRouter" disabled>End test</button></div>
            <div id="ephemeralOpenRouterStatus" class="muted" style="margin-top:6px;">No temporary provider session active.</div>
          </details>
          <details id="connectProviderDetails" style="margin:10px 0;border:1px solid var(--border);border-radius:10px;padding:12px;">
            <summary style="cursor:pointer;font-weight:700;">Connect provider — discover and select models</summary>
            <h3>Supported providers</h3><p class="muted">Save an API key to the private vault; this saves credentials but does not preflight the provider. Runtime models appear in the selector when supported. Connection does not automatically change your selected model.</p>
            <div class="row"><select id="apiKeyProvider"><option value="anthropic">Anthropic</option><option value="openai">OpenAI</option><option value="google">Google</option><option value="openrouter">OpenRouter</option></select><input id="apiKeyInput" type="password" autocomplete="new-password" placeholder="Provider API key — private vault"/><button id="btnSaveApiKey" type="button">Save key</button></div>
            <div id="connectedProviderModelStep" class="row" style="display:none;"><select id="connectedProviderModel" aria-label="Choose connected provider model" style="flex:1;"></select><button id="btnUseConnectedProviderModel" type="button">Use selected model</button></div>
            <div id="connectedProviderModelStatus" class="muted" role="status" aria-live="polite"></div>
            <hr style="border:none;border-top:1px solid var(--border);margin:10px 0;" />
            <h3>OpenAI-compatible endpoint</h3>
            <p class="muted">Connect an OpenAI-compatible endpoint. Discovery reads model IDs only; tool, image, reasoning, and limit capabilities are not verified by a model list. Loopback endpoints may be keyless; remote endpoints require HTTPS and a key. Other adapters can still be configured manually in advanced settings.</p>
            <div class="row"><input id="customProviderName" placeholder="Connection name (e.g. local model server)"/><input id="customProviderUrl" placeholder="HTTPS endpoint, or local server URL"/></div>
            <div class="row"><input id="customProviderKey" type="password" autocomplete="new-password" placeholder="API key (required for remote endpoints)"/><button id="btnDiscoverCustomModels" type="button">Verify &amp; discover</button></div>
            <div id="customProviderDiscoveryResult" class="muted" role="status" aria-live="polite">Models not discovered yet.</div>
            <div id="customProviderDiscoveredModels" class="surface-box" style="max-height:180px;overflow:auto;display:none;"></div>
            <div class="row"><input id="customProviderManualModel" placeholder="Fallback model ID if discovery is unavailable"/><button class="primary" id="btnAddCustomProvider" type="button" disabled>Connect &amp; use selected model(s)</button></div>
          </details>
          <div id="providerConnectionsBox" class="surface-box" style="max-height:220px;overflow:auto;margin-bottom:10px;">Loading provider inventory…</div>
          <div class="row">
            <input id="ollamaModelInput" value="qwen2.5-coder:32b" placeholder="Ollama model id (e.g. qwen2.5-coder:32b)" />
            <input id="ollamaUrlInput" placeholder="Optional custom Ollama /v1 URL (blank = default local :11434/v1)" />
            <button class="primary" id="btnRegisterOllama">Register Ollama</button>
          </div>
          <hr style="border:none;border-top:1px solid var(--border);margin:10px 0;" />
          <h2>Saved Workspace Sessions (<code>.harness/sessions/*.jsonl</code>)</h2>
          <div id="sessionsListBox"></div>
        </div>

        <div class="card">
          <h2>
            <span>Confined <code>@earendil-works/pi-mcp</code> Hub (+0 Schema Tokens)</span>
            <span class="badge ok" id="mcpTrustBadge">Trusted</span>
          </h2>
          <div class="muted" style="margin-bottom:8px;">Named local stdio and remote HTTPS MCP servers. Tool metadata is scanned and risky tools are blocked. Workspace-sourced stdio is trust-gated. Remote OAuth and authenticated headers are not implemented yet; use only endpoints that do not require credentials.</div>
          <div class="row" style="margin-bottom:10px;">
            <input id="mcpNameInput" placeholder="Local server name" />
            <input id="mcpCmdInput" placeholder="Stdio command (e.g. npx or node)" />
            <input id="mcpArgsInput" placeholder="Space-separated args" />
            <button class="primary" id="btnConnectMcpStdio">Connect local</button>
          </div>
          <div class="row" style="margin-bottom:10px;"><input id="mcpRemoteNameInput" placeholder="Remote server name (e.g. docs-mcp)"/><input id="mcpRemoteUrlInput" placeholder="Remote HTTPS MCP URL" style="flex:2;"/><button id="btnConnectMcpRemote">Connect remote</button></div>
          <div id="mcpRestoreIssuesBox" class="muted"></div><div id="mcpServersBox" style="margin-bottom:10px;"></div>
          <h2>Audited MCP Tools</h2>
          <div id="mcpToolsBox"></div>
        </div>
      </div>
    </section>

    <!-- TAB 7 (v3): AUTONOMOUS PR PIPELINE, SESSION HANDOFF, PRESETS/BOOKMARKS, CHROMIUM CDP & WORKSPACES -->
    <section id="tab-ring7" class="tab-pane">
      <div class="grid-equal">
        <div class="card">
          <h2>
            <span>6-Stage Autonomous Issue-to-PR Pipeline (<code>/pr</code>)</span>
            <span class="badge accent">apex/&lt;slug&gt;</span>
          </h2>
          <div class="muted" style="margin-bottom:8px;">Branch isolation &rarr; Plan Trust Artifact &rarr; Disjoint worktrees &rarr; Codex/BugBot diff audit &rarr; bwrap CI &rarr; PR bundle.</div>
          <input id="prTitleInput" placeholder="PR title (e.g. Harden session token TTL validation)" />
          <textarea id="prDescInput" rows="2" placeholder="Issue summary &amp; acceptance criteria..."></textarea>
          <div class="row">
            <input id="prTestCmdInput" placeholder="Optional sandboxed CI command (e.g. node --test)" />
            <button class="primary" id="btnRunPrPipeline" style="white-space:nowrap;">Run PR Pipeline</button>
          </div>
          <div id="prRunsListBox" style="margin-top:10px;"></div>
          <pre class="surface-box" id="prBundlePreviewBox" style="margin-top:8px;max-height:180px;display:none;"></pre>
          <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;" />
          <h2>Focused Session Handoff (<code>/handoff</code>) &amp; Zero-Drift Presets (<code>/preset</code>)</h2>
          <div class="row" style="margin-bottom:8px;">
            <input id="handoffGoalInput" placeholder="Goal for clean parentSession-linked child thread..." />
            <button class="primary" id="btnCreateHandoff" style="white-space:nowrap;">Handoff &amp; Switch</button>
          </div>
          <div class="row" style="margin-bottom:8px;">
            <select id="presetSelect" style="flex:1;padding:7px;background:#090d15;color:#e2e8f0;border:1px solid var(--border);border-radius:6px;"></select>
            <button id="btnApplyPreset">Apply Preset (0 Drift)</button>
          </div>
          <div class="row">
            <input id="bookmarkLabelInput" placeholder="Bookmark label for latest turn..." />
            <button id="btnAddBookmark">Bookmark Turn</button>
          </div>
          <div id="bookmarksListBox" style="margin-top:8px;"></div>
        </div>

        <div class="card">
          <h2>
            <span>Live Headless Chromium 156 CDP Browser (<code>@e1</code> ARIA + PNG)</span>
            <span class="badge ok" id="cdpStatusBadge">Checking...</span>
          </h2>
          <div class="row" style="margin-bottom:8px;">
            <input id="browserUrlInput" value="data:text/html,&lt;h1&gt;Pi-Apex Live Chromium CDP&lt;/h1&gt;&lt;button&gt;Deploy&lt;/button&gt;" placeholder="https://... or data:text/html,..." />
            <button class="primary" id="btnCdpNavigate" style="white-space:nowrap;">Open &amp; Snapshot</button>
            <button id="btnCdpScreenshot">PNG Shot</button>
          </div>
          <pre class="surface-box" id="cdpSnapshotBox">Ready. Click Open &amp; Snapshot to query Chromium Accessibility.getFullAXTree.</pre>
          <img id="cdpScreenshotImg" alt="Chromium CDP Screenshot" style="display:none;max-width:100%;margin-top:8px;border:1px solid var(--border);border-radius:6px;" />
          <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;" />
          <h2>Multi-Repository Workspace Switcher</h2>
          <div class="row" style="margin-bottom:8px;">
            <input id="workspaceSwitchInput" placeholder="/path/to/another/git-repo" />
            <button class="primary" id="btnSwitchWorkspace" style="white-space:nowrap;">Switch Repo</button>
          </div>
          <div id="workspacesListBox"></div>
        </div>
      </div>
    </section>

    <!-- TAB 8 (v4): GITHUB QUARANTINE BRIDGE, VS CODE RPC & SWE BENCHMARK SUITE -->
    <section id="tab-ring8" class="tab-pane">
      <div class="grid-equal">
        <div class="card">
          <h2>
            <span>Quarantine-Scanned GitHub Issue Bridge (<code>/issue</code>)</span>
            <span class="badge ok">skills-guard-v10</span>
          </h2>
          <div class="muted" style="margin-bottom:8px;">Scans untrusted GitHub Issue prose &amp; comments before LLM ingestion; blocks prompt-injection / exfil payloads or wraps in <code>&lt;untrusted_github_issue&gt;</code>.</div>
          <input id="ghIssueRefInput" placeholder="https://github.com/owner/repo/issues/42  or  owner/repo#42  or  #42" />
          <div class="row" style="margin-bottom:8px;">
            <label style="display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);">
              <input type="checkbox" id="ghAllowQuarantinedChk" style="width:auto;margin:0;" />
              Sanitize quarantined lines instead of hard-blocking
            </label>
          </div>
          <div class="row" style="margin-bottom:10px;">
            <button class="primary" id="btnIngestGhIssue">Scan &amp; Ingest Issue</button>
            <button id="btnRunAutoPrFromIssue">Ingest &amp; Run Self-Healing /pr</button>
          </div>
          <pre class="surface-box" id="ghIssueEnvelopeBox" style="max-height:170px;">Enter a GitHub Issue URL/ref above to inspect its skills-guard-v10 quarantine envelope.</pre>
          <h2 style="margin-top:12px;">Ingested Issue Audit Ledger &amp; Merge Conflicts</h2>
          <div id="ghIngestionsListBox"></div>
        </div>

        <div class="card">
          <h2>
            <span>Personal SWE Eval &amp; Harness² A/B Cache Benchmark (<code>/bench</code>)</span>
            <span class="badge accent">3-Repo bwrap Corpus</span>
          </h2>
          <div class="muted" style="margin-bottom:8px;">Measures pass rate, BugBot/CI self-heal recoveries, <code>o200k_base</code> cache hit %, cost/resolved, and Before vs. After <code>EXPERIENCE.md</code> delta.</div>
          <div class="row" style="margin-bottom:8px;">
            <button class="primary" id="btnRunSweBench">Run 3-Repo A/B SWE Benchmark</button>
          </div>
          <pre class="surface-box" id="sweBenchReportBox" style="max-height:220px;">Click Run 3-Repo A/B SWE Benchmark (or run npm run bench) to evaluate baseline vs. Harness² EXPERIENCE.md.</pre>
          <div id="sweBenchHistoryBox" style="margin-top:8px;"></div>
          <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;" />
          <h2>VS Code &amp; Cursor RPC Extension (<code>extensions/vscode-pi-apex</code>)</h2>
          <div class="muted">Install locally with <code>bash scripts/install-personal.sh --install-vscode</code>. Streams active selection + IDE LSP diagnostics over <code>pi-apex --mode rpc</code> with <strong>0 prefix drift</strong> and automatic <code>.env</code> redaction.</div>
        </div>
      </div>
    </section>

    <!-- TAB 9 (v5): OMNI-CHANNEL GATEWAY, MULTI-AGENT SWARM, EXTERNAL PLUGINS & SELF-LEARNING LEDGER -->
    <section id="tab-ring9" class="tab-pane">
      <div class="grid-equal">
        <div class="card">
          <h2>
            <span>Omni-Channel Messaging Gateway (<code>/gateway</code>, <code>/send</code>)</span>
            <span class="badge ok" id="gatewaySendersBadge">0 paired</span>
          </h2>
          <div class="muted" style="margin-bottom:8px;">WhatsApp (Baileys QR/8-Char Bridge + Meta Cloud HMAC), Telegram, Discord, Slack (Socket Mode + Native Manifest), and Signal (<code>signal-cli</code> JSON-RPC). Fail-closed sender pairing + <code>skills-guard-v10</code> inbound scan.</div>
          <div class="row" style="margin-bottom:8px;">
            <select id="gwPlatformSelect" style="width:auto;">
              <option value="whatsapp_baileys">whatsapp_baileys (Personal QR/Link)</option>
              <option value="whatsapp_cloud">whatsapp_cloud (Meta Graph API)</option>
              <option value="telegram">telegram</option>
              <option value="discord">discord</option>
              <option value="slack">slack</option>
              <option value="signal">signal</option>
            </select>
            <button class="primary" id="btnIssuePairCode">Issue 6-Digit /pair Code</button>
            <button id="btnInitBaileys">WhatsApp Baileys Link Code</button>
          </div>
          <pre class="surface-box" id="gatewayStatusBox" style="max-height:150px;">Loading Omni-Channel Gateway status...</pre>

          <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;" />
          <h2>
            <span>Multi-Agent Swarm &amp; Personas (<code>/agents</code>, <code>/swarm</code>)</span>
            <span class="badge accent" id="personasCountBadge">5 personas</span>
          </h2>
          <input id="swarmGoalInput" placeholder="Goal for Multi-Agent Debate or Supervisor (e.g. Zero-downtime JWT key rotation across API &amp; worker)" />
          <div class="row" style="margin-bottom:8px;">
            <button class="primary" id="btnRunDebateSwarm">Run Multi-Persona Debate</button>
            <button id="btnRunSupervisorSwarm">Run Supervisor-Reviewer</button>
          </div>
          <pre class="surface-box" id="swarmOutputBox" style="max-height:150px;">Select Debate or Supervisor above to orchestrate specialist personas over shared AgentBlackboard.</pre>
        </div>

        <div class="card">
          <h2>
            <span>Hash-Chained Self-Learning Ledger (<code>/ledger</code>)</span>
            <span class="badge ok" id="ledgerChainBadge">Chain: Verified</span>
          </h2>
          <div class="muted" style="margin-bottom:8px;">Append-only SHA-256 chain unifying <code>/pr</code> self-heals, BugBot rules, operator steers, and Harness² <code>EXPERIENCE.md</code> with <strong>0 live prefix drift</strong>.</div>
          <div class="row" style="margin-bottom:6px;">
            <input id="ledgerCueInput" placeholder="Cue (e.g. Validating webhook HMAC headers)" style="margin:0;flex:1;" />
            <input id="ledgerLessonInput" placeholder="Lesson (e.g. Always use timingSafeEqual on equal-length Buffers)" style="margin:0;flex:1;" />
          </div>
          <div class="row" style="margin-bottom:8px;">
            <button class="primary" id="btnRecordLedgerLesson">Append Lesson</button>
            <button id="btnVerifyLedgerChain">Verify SHA-256 Chain</button>
            <button class="success" id="btnMaterializeLedger">Materialize Next-Boot Surfaces</button>
          </div>
          <div id="ledgerEntriesBox" style="max-height:175px;overflow-y:auto;"></div>

          <hr style="border:none;border-top:1px solid var(--border);margin:12px 0;" />
          <h2>
            <span>Quarantine-Scanned External Plugins (<code>/plugin</code>)</span>
            <span class="badge" id="pluginsCountBadge">0 installed</span>
          </h2>
          <div class="muted" style="margin:6px 0 8px;color:var(--danger);">Security note: scanning is defense-in-depth, not a sandbox. Plugin JavaScript runs inside the harness Node process. Install only code you personally trust. Installed copies persist on disk; after restart they remain unloaded until you explicitly enable (re-audit) them.</div>
          <div class="row" style="margin-bottom:8px;">
            <input id="pluginSourceDirInput" placeholder="Trusted local plugin folder with apex-plugin.json" style="margin:0;flex:1;" />
            <button class="primary" id="btnInstallPlugin">Audit &amp; Install</button>
          </div>
          <div id="pluginsListBox"></div>
        </div>
      </div>
    </section>

    <section id="tab-settings" class="tab-pane">
      <div class="card">
        <h2>Settings &amp; safety <span class="muted">Session controls and provider readiness</span></h2>
        <p class="muted">This is a personal local workspace. Secrets are configured through Quick setup and stored server-side in the private vault; never paste credentials into chat.</p>
        <div class="row" style="align-items:end;flex-wrap:wrap;">
          <label class="muted">Speech provider<select id="speechProviderSetting"><option value="cloud">Cloud (vault-backed)</option><option value="local">Local (explicitly configured)</option></select></label>
          <button id="btnRefreshSettings">Refresh status</button>
          <button id="btnQuickSetup" class="primary">Provider &amp; key setup</button>
          <button id="btnDoctor">Health check</button>
          <button id="btnThemeToggle" title="Toggle paper / espresso theme">◐ Appearance</button>
          <button id="btnOpenQuickSetup">More setup options</button>
        </div>
        <div class="grid-equal" style="margin-top:14px;">
          <div class="surface-box"><strong>Speech readiness</strong><pre id="settingsSpeechStatus" class="muted">Checking…</pre><strong>Obsidian vault</strong><pre id="obsidianVaultStatus" class="muted">Checking…</pre></div>
          <div class="surface-box"><strong>Active session</strong><pre id="settingsInteractionStatus" class="muted">Loading…</pre><strong>Recent safety decisions</strong><pre id="settingsAuditStatus" class="muted">Loading audit summary…</pre></div>
        </div>
        <div class="surface-box" style="margin-top:14px;border-left:4px solid var(--accent);">
          <strong>Execution modes do not change sandbox boundaries</strong>
          <p class="muted">Review asks before every command; Default asks before sensitive actions; Auto uses deterministic policy; Turbo skips confirmations only. All modes retain Bubblewrap, network/path controls, secret masking, and hard-deny rules. Change the current mode in Chat &amp; changes.</p>
        </div>
        <div class="surface-box" style="margin-top:12px;"><strong>Where features live</strong><p class="muted">Work contains the conversation, task review, build/browser, issue/IDE, and history surfaces. Library holds agents, models, tools, channels, and skills. Settings contains provider, speech, safety, appearance, memory, and diagnostics controls.</p></div>
      </div>
    </section>
  </main>

  <div id="approvalModal" role="dialog" aria-modal="true" aria-label="Command approval" style="position:fixed;inset:0;z-index:25;background:rgba(35,30,25,.36);display:none;align-items:center;justify-content:center;padding:20px;">
    <div class="modal-card" style="max-width:620px;"><div class="modal-head"><div><h2>Approve this action?</h2><div id="approvalRationale" class="muted"></div></div></div><pre id="approvalSummary" class="surface-box"></pre><div class="row" style="justify-content:flex-end;margin-top:14px;"><button id="btnDenyAction">Deny</button><button id="btnApproveAction" class="primary">Approve once</button></div></div>
  </div>
  <div id="quickSetupModal" role="dialog" aria-modal="true" aria-label="Quick setup">
    <div class="modal-card">
      <div class="modal-head"><div><h2>Make Pi-Apex yours</h2><div class="muted">Connect a model, discover local Ollama, or configure a messaging channel. Secrets are stored in your private 0600 vault.</div></div><button id="btnCloseSetup" aria-label="Close">✕</button></div>
      <section class="setup-section"><h3>Cloud model provider</h3><div class="muted">The key is masked after save and activated immediately.</div><div class="row"><select id="setupProvider"><option value="anthropic">Anthropic · Claude</option><option value="openai">OpenAI</option><option value="google">Google Gemini</option><option value="openrouter">OpenRouter</option><option value="groq">Groq</option><option value="xai">xAI</option><option value="mistral">Mistral</option></select><input id="setupApiKey" type="password" autocomplete="off" placeholder="Paste API key"/><button id="btnSaveSetupKey" class="primary">Save key</button></div></section>
      <section class="setup-section"><h3>Local Ollama</h3><div class="muted">Find installed models and optionally bind the planner and coder automatically.</div><div class="row"><input id="setupOllamaUrl" placeholder="Ollama base URL (default local service)"/><button id="btnDiscoverOllama">Find models</button></div><div id="setupOllamaResult" class="muted"></div></section>
      <section class="setup-section"><h3>Messaging channel</h3><div class="muted">Credentials stay in your local vault; configure pairing and sender allowlists under Agents &amp; channels.</div><div class="row"><select id="setupChannel"><option value="telegram">Telegram</option><option value="discord">Discord</option><option value="slack">Slack</option></select><input id="setupChannelToken" type="password" autocomplete="off" placeholder="Bot token"/><input id="setupSlackSecret" type="password" autocomplete="off" placeholder="Slack signing secret (Slack only)"/><button id="btnSaveChannel" class="primary">Connect</button></div></section>
      <section class="setup-section"><div id="setupReadiness" class="muted">Checking readiness…</div></section>
    </div>
  </div>
  <div id="commandPalette" role="dialog" aria-modal="true" aria-label="Command palette">
    <div class="modal-card" style="width:min(560px,100%);"><div class="modal-head"><div><h2>Jump to</h2><div class="muted">Search commands and Studio views</div></div><button id="btnClosePalette">Esc</button></div><input id="paletteSearch" placeholder="Type a command or view…" autocomplete="off"/><div id="paletteResults"></div></div>
  </div>

  <script>
    const TASK_MODE_HEURISTIC_RULES = ${taskModeRulesJson};
    let currentAutoTargets = null;
    let currentState = null;
    let selectedArtifactId = null;
    let attachedImages = [];
    let attachedDocument = null;
    let recordedAudioBlob = null;
    let transcriptPending = false;
    let mediaRecorder = null;
    let cancelCurrentRecording = false;
    let recordingTimer = null;
    let activeApprovalId = null;

    const tabItems = Array.from(document.querySelectorAll("nav.tabs button[data-tab]")).map((b) => ({
      label: b.textContent.trim().replace(/^\S+\s+/, ""), id: b.dataset.tab
    }));
    const slashItems = ["doctor", "plan", "rewind", "review", "quarantine", "dream", "evolve", "mcp", "router", "preset", "bookmark", "handoff", "pr", "issue", "bench", "gateway", "send", "agents", "swarm", "plugin", "ledger", "setup"];
    const setupModal = document.getElementById("quickSetupModal");
    const paletteModal = document.getElementById("commandPalette");
    function openSetup() { setupModal.classList.add("open"); refreshOnboardingStatus(); }
    function closeSetup() { setupModal.classList.remove("open"); }
    function openPalette() { paletteModal.classList.add("open"); const i=document.getElementById("paletteSearch"); i.value=""; renderPalette(""); i.focus(); }
    function closePalette() { paletteModal.classList.remove("open"); }
    function renderPalette(query) {
      const q = query.trim().toLowerCase();
      const items = [
        ...tabItems.map((t) => ({ label:t.label, detail:"Open view", run:() => document.querySelector('nav.tabs button[data-tab="'+t.id+'"]').click() })),
        ...slashItems.map((c) => ({ label:"/"+c, detail:"Run slash command", run:() => { document.getElementById("chatPromptInput").value="/"+c; document.getElementById("btnSendPrompt").click(); } })),
        { label:"Quick setup", detail:"Connect a provider or channel", run:openSetup },
        { label:"Toggle paper / espresso theme", detail:"Appearance", run:toggleTheme }
      ].filter((i) => !q || (i.label+" "+i.detail).toLowerCase().includes(q)).slice(0,12);
      const box=document.getElementById("paletteResults"); box.innerHTML="";
      for (const item of items) { const b=document.createElement("button"); b.textContent=item.label+"   ·   "+item.detail; b.addEventListener("click",()=>{ closePalette(); item.run(); }); box.appendChild(b); }
      if (!items.length) box.innerHTML="<div class='muted'>No matching commands.</div>";
    }
    function toggleTheme() {
      const next=document.documentElement.dataset.theme==="dark"?"light":"dark";
      document.documentElement.dataset.theme=next;
      try { localStorage.setItem("pi-apex-theme",next); } catch {}
    }
    try { document.documentElement.dataset.theme=localStorage.getItem("pi-apex-theme")||"light"; } catch { document.documentElement.dataset.theme="light"; }
    document.getElementById("btnQuickSetup").addEventListener("click",openSetup);
    document.getElementById("btnAttention").addEventListener("click",()=>{
      const reviewTab=document.querySelector('nav.tabs button[data-tab="tab-artifacts"]');
      if(reviewTab) reviewTab.click();
      refreshInteractionState();
    });
    document.getElementById("btnCloseSetup").addEventListener("click",closeSetup);
    document.getElementById("btnCommandPalette").addEventListener("click",openPalette);
    document.getElementById("btnClosePalette").addEventListener("click",closePalette);
    document.getElementById("btnThemeToggle").addEventListener("click",toggleTheme);
    document.getElementById("paletteSearch").addEventListener("input",(e)=>renderPalette(e.target.value));
    document.addEventListener("keydown",(e)=>{
      if ((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==="k") { e.preventDefault(); openPalette(); }
      if (e.key==="Escape") { closePalette(); closeSetup(); }
      if (e.altKey&&/^[1-9]$/.test(e.key)) { const b=document.querySelector('nav.tabs button[data-tab="'+tabItems[Number(e.key)-1]?.id+'"]'); if(b)b.click(); }
    });
    setupModal.addEventListener("click",(e)=>{if(e.target===setupModal)closeSetup();});
    paletteModal.addEventListener("click",(e)=>{if(e.target===paletteModal)closePalette();});
    async function refreshOnboardingStatus() {
      try {
        const s=await apiJson("./api/onboarding");
        const configured=s.providers.filter((p)=>p.configured).map((p)=>p.label+" "+p.maskedKey);
        const local=s.ollama.configured?s.ollama.discoveredModels.join(", "):"Ollama not discovered";
        const chans=s.channels.filter((c)=>c.configured).map((c)=>c.platform);
        document.getElementById("setupReadiness").textContent="Readiness "+s.readinessScorePct+"% · Providers: "+(configured.join("; ")||"none")+" · Local: "+local+" · Channels: "+(chans.join(", ")||"none");
      } catch(err) { document.getElementById("setupReadiness").textContent="Setup status unavailable: "+err.message; }
    }
    document.getElementById("btnSaveSetupKey").addEventListener("click",async()=>{
      try { const provider=document.getElementById("setupProvider").value, apiKey=document.getElementById("setupApiKey").value.trim();
        const res=await apiJson("./api/onboarding",{method:"POST",body:JSON.stringify({action:"save_provider_key",provider,apiKey})});
        document.getElementById("setupApiKey").value=""; showToast("Saved "+provider+" key ("+res.saved.maskedKey+") to private vault."); await refreshOnboardingStatus(); await refreshV2Panels();
      } catch(err){showToast(err.message,true);}
    });
    document.getElementById("btnDiscoverOllama").addEventListener("click",async()=>{
      try { const ollamaHostUrl=document.getElementById("setupOllamaUrl").value.trim()||undefined;
        const res=await apiJson("./api/onboarding",{method:"POST",body:JSON.stringify({action:"discover_ollama",ollamaHostUrl,bindApexAuto:true})});
        document.getElementById("setupOllamaResult").textContent="Found: "+res.discovery.discoveredModels.join(", "); showToast("Discovered local Ollama models."); await refreshOnboardingStatus(); await refreshV2Panels();
      } catch(err){showToast(err.message,true);}
    });
    document.getElementById("btnSaveChannel").addEventListener("click",async()=>{
      try { const platform=document.getElementById("setupChannel").value, botToken=document.getElementById("setupChannelToken").value.trim();
        const credentials={}; credentials[platform]={botToken};
        const s=await apiJson("./api/onboarding",{method:"POST",body:JSON.stringify({action:"save_channel_credentials",channels:credentials})});
        document.getElementById("setupChannelToken").value=""; showToast("Channel credentials saved to private vault."); await refreshOnboardingStatus(); await refreshV5Panels();
      } catch(err){showToast(err.message,true);}
    });

    function showToast(msg, isError = false) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.className = "toast visible " + (isError ? "error" : "ok");
    }

    async function apiJson(relUrl, opts = {}) {
      const res = await fetch(relUrl, {
        headers: { "Content-Type": "application/json" },
        ...opts
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || ("HTTP " + res.status));
      }
      return data;
    }

    const TASK_MODE_LABELS = { quick:"Quick answer", goal:"Goal", plan:"Plan", browser:"Browser research", teamwork:"Teamwork", schedule:"Schedule" };
    function inferTaskModeLocal(text) {
      const normalized=String(text||"").trim();
      const rule=TASK_MODE_HEURISTIC_RULES.find((item)=>new RegExp(item.pattern,item.flags).test(normalized));
      const mode=rule?.mode||"quick";
      return {mode,reason:rule?.reason||"No strong workflow cue was detected; a quick answer is the conservative default.",confidence:rule?"medium":"low"};
    }
    function updateTaskModeRecommendation() {
      const input=document.getElementById("chatPromptInput"), select=document.getElementById("taskModeSelect");
      const suggestion=inferTaskModeLocal(input.value);
      const chosen=select.value;
      const selectedText=chosen==="automatic"?"No special mode is selected. ":"Selected for this turn: "+TASK_MODE_LABELS[chosen]+". ";
      document.getElementById("taskSuggestionReason").textContent=input.value.trim()?selectedText+"Suggestion: "+TASK_MODE_LABELS[suggestion.mode]+" — "+suggestion.reason+" Nothing runs until you send.":"Type a task to see a local suggestion. Nothing is selected or dispatched automatically.";
      const useButton=document.getElementById("btnUseTaskSuggestion");
      useButton.disabled=!input.value.trim()||chosen===suggestion.mode;
      useButton.textContent=chosen===suggestion.mode?"Suggestion selected":"Use suggestion";
      return suggestion;
    }
    document.getElementById("chatPromptInput").addEventListener("input",updateTaskModeRecommendation);
    document.getElementById("taskModeSelect").addEventListener("change",updateTaskModeRecommendation);
    document.getElementById("btnUseTaskSuggestion").addEventListener("click",()=>{const suggestion=inferTaskModeLocal(document.getElementById("chatPromptInput").value);document.getElementById("taskModeSelect").value=suggestion.mode;updateTaskModeRecommendation();});
    updateTaskModeRecommendation();
    function updateTurnContextBadge() {
      const model=document.getElementById("chatModelSelect");
      document.getElementById("turnContextBadge").textContent = (model?.selectedOptions?.[0]?.textContent || "model") + " · " + document.getElementById("chatReasoning").value + " reasoning · " + document.getElementById("chatPersona").selectedOptions[0].textContent + " · " + document.getElementById("chatBuildProfile").selectedOptions[0].textContent + " · " + document.getElementById("chatExecutionMode").selectedOptions[0].textContent;
      const turbo=document.getElementById("chatExecutionMode").value==="turbo";document.getElementById("turboWarning").style.display=turbo?"inline-flex":"none";
    }
    document.getElementById("chatModelSelect").addEventListener("change",async(e)=>{try{const [provider,modelId]=e.target.value.split(":::");await apiJson("./api/models",{method:"POST",body:JSON.stringify({action:"set_model",provider,modelId})});await refreshV2Panels();updateTurnContextBadge();}catch(err){showToast(err.message,true);}});
    document.getElementById("chatReasoning").addEventListener("change",async(e)=>{try{const r=await apiJson("./api/models",{method:"POST",body:JSON.stringify({action:"set_thinking_level",thinkingLevel:e.target.value})});document.getElementById("effectiveReasoning").textContent="Effective: "+r.effective;updateTurnContextBadge();}catch(err){showToast(err.message,true);}});
    document.getElementById("chatPersona").addEventListener("change",async(e)=>{try{await apiJson("./api/interaction",{method:"POST",body:JSON.stringify({action:"set_profile",persona:e.target.value})});updateTurnContextBadge();}catch(err){showToast(err.message,true);}});
    document.getElementById("chatBuildProfile").addEventListener("change",async(e)=>{try{const profile=e.target.value;const defaults={implement:{persona:"builder",reasoning:"medium"},plan:{persona:"architect",reasoning:"high"},review:{persona:"reviewer",reasoning:"high"},"fast-local":{persona:"builder",reasoning:"low"},custom:{persona:document.getElementById("chatPersona").value,reasoning:document.getElementById("chatReasoning").value}};const d=defaults[profile];document.getElementById("chatPersona").value=d.persona;document.getElementById("chatReasoning").value=d.reasoning;await apiJson("./api/interaction",{method:"POST",body:JSON.stringify({action:"set_profile",persona:d.persona,buildProfile:profile})});await apiJson("./api/models",{method:"POST",body:JSON.stringify({action:"set_thinking_level",thinkingLevel:d.reasoning})});if(profile==="fast-local"){const o=Array.from(document.getElementById("chatModelSelect").options).find(x=>x.value.startsWith("ollama:::"));if(o){document.getElementById("chatModelSelect").value=o.value;const [p,m]=o.value.split(":::");await apiJson("./api/models",{method:"POST",body:JSON.stringify({action:"set_model",provider:p,modelId:m})});}}updateTurnContextBadge();await refreshV2Panels();}catch(err){showToast(err.message,true);}});
    document.getElementById("chatExecutionMode").addEventListener("change",async(e)=>{try{const mode=e.target.value;if((mode==="auto"||mode==="turbo")&&!confirm(mode.toUpperCase()+" mode changes approval-prompt behavior only; sandbox limits and hard guardrails remain active. Enable for this session?")){e.target.value="default";return;}await apiJson("./api/interaction",{method:"POST",body:JSON.stringify({action:"set_mode",mode})});updateTurnContextBadge();}catch(err){e.target.value="default";showToast(err.message,true);}});
    async function refreshInteractionState(){try{const s=await apiJson("./api/interaction");document.getElementById("settingsInteractionStatus").textContent="Mode: "+s.mode+"\\nPersona: "+s.persona+"\\nBuild profile: "+s.buildProfile+"\\nPending approvals: "+(s.pending?.length||0);document.getElementById("settingsAuditStatus").textContent=(s.recent||[]).slice(-5).reverse().map(x=>new Date(x.createdAtMs).toLocaleTimeString()+" · "+x.outcome+" · "+x.tool+" · "+x.summary).join("\\n")||"No decisions logged in this session yet.";const attention=document.getElementById("btnAttention");const pendingCount=s.pending?.length||0;attention.hidden=pendingCount===0;attention.textContent=pendingCount?"Needs your attention · "+pendingCount:"Needs your attention";attention.setAttribute("aria-label",pendingCount+" pending approval"+(pendingCount===1?"":"s")+". Open review");document.getElementById("chatExecutionMode").value=s.mode;const personaSel=document.getElementById("chatPersona");if(!personaSel.dataset.personasLoaded&&Array.isArray(s.personas)){const builtins=Array.from(personaSel.options).filter(o=>!o.dataset.custom);personaSel.innerHTML="";builtins.forEach(o=>personaSel.appendChild(o));s.personas.filter(p=>p.custom).forEach(p=>{const o=document.createElement("option");o.value=p.id;o.textContent=p.label+" (workspace)";o.dataset.custom="true";personaSel.appendChild(o);});personaSel.dataset.personasLoaded="true";}personaSel.value=s.persona;document.getElementById("chatBuildProfile").value=s.buildProfile;updateTurnContextBadge();if(s.pending?.length){const a=s.pending[0];activeApprovalId=a.approvalId;document.getElementById("approvalSummary").textContent=a.tool+"\\n"+a.summary;document.getElementById("approvalRationale").textContent=a.rationale;document.getElementById("approvalModal").style.display="flex";}else{activeApprovalId=null;document.getElementById("approvalModal").style.display="none";}}catch{}}
    async function resolveApproval(allow){if(!activeApprovalId)return;try{await apiJson("./api/interaction",{method:"POST",body:JSON.stringify({action:"resolve_approval",approvalId:activeApprovalId,allow})});await refreshInteractionState();}catch(err){showToast(err.message,true);}}
    document.getElementById("btnApproveAction").addEventListener("click",()=>resolveApproval(true));document.getElementById("btnDenyAction").addEventListener("click",()=>resolveApproval(false));
    setInterval(refreshInteractionState,700);
    function renderImagePreviews() {
      const box=document.getElementById("imageAttachmentPreview"); box.innerHTML="";
      attachedImages.forEach((img,i)=>{ const wrap=document.createElement("div"); wrap.style.cssText="position:relative"; const image=document.createElement("img"); image.src="data:"+img.mimeType+";base64,"+img.data; image.alt="Image attachment"; image.style.cssText="width:76px;height:58px;object-fit:cover;border-radius:8px;border:1px solid var(--border)"; const b=document.createElement("button"); b.textContent="×"; b.title="Remove image"; b.style.cssText="position:absolute;right:2px;top:2px;padding:1px 7px"; b.addEventListener("click",()=>{attachedImages.splice(i,1);renderImagePreviews();}); wrap.append(image,b);box.appendChild(wrap); });
    }
    function renderDocumentPreview(){const box=document.getElementById("documentAttachmentPreview");box.innerHTML="";if(!attachedDocument)return;const row=document.createElement("div");row.className="list-item";row.style.cssText="display:flex;align-items:center;gap:10px;";const label=document.createElement("span");label.className="muted";label.textContent=attachedDocument.filename+" · "+String(attachedDocument.filename).split(".").pop().toLowerCase()+" claim · "+(attachedDocument.bytes/1024/1024).toFixed(2)+" MiB · pending (signature checked on send)";const remove=document.createElement("button");remove.type="button";remove.textContent="Remove document";remove.addEventListener("click",()=>{attachedDocument=null;renderDocumentPreview();});row.append(label,remove);box.append(row);}
    const DOCUMENT_EXTENSIONS=["pdf","docx","pptx","xlsx","html","htm","md","txt"];
    async function attachDocumentFile(file){const ext=String(file.name||"").split(".").pop().toLowerCase();if(!DOCUMENT_EXTENSIONS.includes(ext))throw new Error("Choose PDF, DOCX, PPTX, XLSX, HTML, Markdown, or TXT.");if(file.size<1||file.size>25*1024*1024)throw new Error("Document must be between 1 byte and 25 MiB.");if(attachedImages.length)throw new Error("Send either one document or image attachments, not both.");if(attachedDocument)throw new Error("Only one document per prompt; remove the current document first.");const url=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=reject;reader.readAsDataURL(file);});attachedDocument={filename:file.name,bytes:file.size,mimeType:file.type||"application/octet-stream",dataBase64:String(url).split(",")[1]};renderDocumentPreview();}
    document.getElementById("btnAttachDocument").addEventListener("click",()=>document.getElementById("documentFilePicker").click());
    document.getElementById("documentFilePicker").addEventListener("change",async(e)=>{try{const file=e.target.files?.[0];if(file)await attachDocumentFile(file);}catch(err){showToast(err.message,true);}finally{e.target.value="";}});
    document.getElementById("btnAttachImage").addEventListener("click",()=>document.getElementById("imageFilePicker").click());
    document.getElementById("imageFilePicker").addEventListener("change",async(e)=>{
      try { if(attachedDocument)throw new Error("Send either one document or image attachments, not both.");for(const f of Array.from(e.target.files||[])){ if(!["image/jpeg","image/png","image/webp"].includes(f.type)||f.size>8*1024*1024) throw new Error("Choose JPEG, PNG, or WebP images up to 8 MiB each."); if(attachedImages.length>=4) throw new Error("At most four images per turn."); const url=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(f);}); attachedImages.push({mimeType:f.type,data:String(url).split(",")[1]}); } renderImagePreviews(); e.target.value=""; } catch(err){showToast(err.message,true);e.target.value="";}
    });
    document.getElementById("chatPromptInput").addEventListener("dragover",(e)=>{if(e.dataTransfer?.types?.includes("Files")){e.preventDefault();e.dataTransfer.dropEffect="copy";}});
    document.getElementById("chatPromptInput").addEventListener("drop",async(e)=>{
      const files=Array.from(e.dataTransfer?.files||[]);if(!files.length)return;e.preventDefault();
      try{if(files.length>1&&files.some(f=>DOCUMENT_EXTENSIONS.includes(String(f.name||"").split(".").pop().toLowerCase())))throw new Error("Drop one document at a time.");for(const f of files){const ext=String(f.name||"").split(".").pop().toLowerCase();if(DOCUMENT_EXTENSIONS.includes(ext)){await attachDocumentFile(f);}else if(["image/jpeg","image/png","image/webp"].includes(f.type)){if(attachedDocument||f.size>8*1024*1024||attachedImages.length>=4)throw new Error("Images are limited to four 8 MiB files and cannot be mixed with a document.");const url=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(f);});attachedImages.push({mimeType:f.type,data:String(url).split(",")[1]});}else if(f.type.toLowerCase().startsWith("audio/")){if(!["audio/webm","audio/ogg","audio/wav","audio/mpeg","audio/mp4","audio/aac"].includes(f.type.toLowerCase().split(";")[0])||f.size>8*1024*1024)throw new Error("Audio drop must be supported audio up to 8 MiB.");recordedAudioBlob=f;}else throw new Error("Drop a supported document, JPEG, PNG, WebP image or supported audio file.");}renderImagePreviews();renderDocumentPreview();showToast("Dropped media attached. Document text is extracted only when you send the prompt.");}catch(err){showToast(err.message,true);}
    });
    document.getElementById("chatPromptInput").addEventListener("paste",async(e)=>{
      const files=Array.from(e.clipboardData?.items||[]).filter((i)=>i.type.startsWith("image/")).map((i)=>i.getAsFile()).filter(Boolean);
      if(!files.length)return; e.preventDefault();
      try { if(attachedDocument)throw new Error("Send either one document or image attachments, not both.");for(const f of files){if(!["image/jpeg","image/png","image/webp"].includes(f.type)||f.size>8*1024*1024||attachedImages.length>=4)throw new Error("Image paste exceeds supported format/count/size."); const url=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(f);});attachedImages.push({mimeType:f.type,data:String(url).split(",")[1]});}renderImagePreviews();}catch(err){showToast(err.message,true);}
    });
    document.getElementById("btnUploadAudio").addEventListener("click",()=>document.getElementById("audioFilePicker").click());
    document.getElementById("audioFilePicker").addEventListener("change",(e)=>{const f=e.target.files?.[0];if(!f)return;if(!["audio/webm","audio/ogg","audio/wav","audio/mpeg","audio/mp4","audio/aac"].includes(f.type.toLowerCase().split(";")[0])||f.size>8*1024*1024){showToast("Choose supported WebM, Ogg, WAV, MP3, MP4, or AAC audio up to 8 MiB.",true);e.target.value="";return;}recordedAudioBlob=f;e.target.value="";showToast("Audio attached. Transcribe, then review text before sending.");});
    document.getElementById("btnCancelRecording").addEventListener("click",()=>{if(mediaRecorder?.state==="recording"){cancelCurrentRecording=true;mediaRecorder.stop();}else{recordedAudioBlob=null;showToast("Audio discarded.");}});
    document.getElementById("btnRecordAudio").addEventListener("click",async()=>{
      try { if(mediaRecorder?.state==="recording"){mediaRecorder.stop();return;} const stream=await navigator.mediaDevices.getUserMedia({audio:true}); const chunks=[]; cancelCurrentRecording=false; mediaRecorder=new MediaRecorder(stream); mediaRecorder.ondataavailable=(e)=>{if(e.data.size)chunks.push(e.data);}; mediaRecorder.onstop=()=>{clearTimeout(recordingTimer);const blob=new Blob(chunks,{type:mediaRecorder.mimeType||"audio/webm"});recordedAudioBlob=cancelCurrentRecording||blob.size>8*1024*1024?null:blob;stream.getTracks().forEach(t=>t.stop());document.getElementById("btnRecordAudio").textContent="● Record";showToast(cancelCurrentRecording?"Recording cancelled.":blob.size>8*1024*1024?"Recording exceeded the 8 MiB limit and was discarded.":"Recording ready. Review/transcribe before sending.",blob.size>8*1024*1024);};mediaRecorder.start();recordingTimer=setTimeout(()=>{if(mediaRecorder?.state==="recording"){showToast("Maximum recording duration reached (2 minutes).",true);mediaRecorder.stop();}},120000);document.getElementById("btnRecordAudio").textContent="■ Stop recording";showToast("Microphone active — click Stop recording when done (2-minute limit).");} catch(err){showToast("Microphone permission unavailable: "+err.message,true);}
    });
    document.getElementById("btnTranscribeAudio").addEventListener("click",async()=>{
      try { if(!recordedAudioBlob)throw new Error("Record audio first, or choose a recording file in browser permissions.");const dataUrl=await new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve(r.result);r.onerror=reject;r.readAsDataURL(recordedAudioBlob);});const result=await apiJson("./api/speech",{method:"POST",body:JSON.stringify({action:"transcribe",audioBase64:String(dataUrl).split(",")[1],mimeType:recordedAudioBlob.type,provider:document.getElementById("speechProviderSetting").value})});document.getElementById("chatPromptInput").value+=(document.getElementById("chatPromptInput").value?"\\n":"")+result.text;recordedAudioBlob=null;transcriptPending=true;document.getElementById("btnSendPrompt").textContent="Send transcript";showToast("Transcription ready — review and edit before sending.");}catch(err){showToast(err.message,true);}
    });
    async function loadSpeechStatus(){try{const s=await apiJson("./api/speech");const summary="Cloud speech: "+(s.cloud.configured?"ready":"not configured (add OpenAI-compatible key in Quick setup)")+"\\nLocal STT: "+(s.local.sttConfigured?"ready":"not configured")+"\\nLocal TTS: "+(s.local.ttsConfigured?"ready":"not configured")+(s.local.note?"\\n"+s.local.note:"");document.getElementById("speechStatus").textContent="Speech · cloud "+(s.cloud.configured?"ready":"not configured")+" · local STT "+(s.local.sttConfigured?"ready":"unavailable")+" · local TTS "+(s.local.ttsConfigured?"ready":"unavailable");document.getElementById("settingsSpeechStatus").textContent=summary;}catch{document.getElementById("speechStatus").textContent="Speech status unavailable";document.getElementById("settingsSpeechStatus").textContent="Speech status unavailable";}}
    async function speakReply(text){try{const r=await apiJson("./api/speech",{method:"POST",body:JSON.stringify({action:"synthesize",text,provider:document.getElementById("speechProviderSetting").value})});const audio=document.getElementById("speechPlayer");audio.src="data:"+r.mimeType+";base64,"+r.audioBase64;audio.style.display="block";await audio.play();}catch(err){showToast(err.message,true);}}

    // Tab switching
    document.querySelectorAll("nav.tabs button[data-tab]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("nav.tabs button[data-tab]").forEach((b) => { b.classList.remove("active"); b.removeAttribute("aria-current"); });
        document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
        btn.classList.add("active");
        btn.setAttribute("aria-current", "page");
        btn.closest("details.nav-section").open = true;
        document.getElementById(btn.dataset.tab).classList.add("active");
        refreshStatus();
        refreshV2Panels();
        refreshV3Panels();
        refreshV4Panels();
        refreshV5Panels();
      });
    });

    function renderSelectedArtifact() {
      const linesEl = document.getElementById("selectedArtLines");
      const approveBtn = document.getElementById("btnApproveArtifact");
      const titleEl = document.getElementById("selectedArtTitle");
      const metaEl = document.getElementById("selectedArtMeta");
      if (!currentState) return;
      const art = (currentState.artifacts || []).find((a) => a.artifactId === selectedArtifactId) || (currentState.artifacts || [])[0];
      if (!art) {
        titleEl.textContent = "No Trust Artifacts Yet";
        metaEl.textContent = "Create a Plan Trust Artifact on the left.";
        linesEl.innerHTML = "";
        approveBtn.style.display = "none";
        return;
      }
      selectedArtifactId = art.artifactId;
      titleEl.textContent = art.title + " (" + art.artifactId + ")";
      metaEl.textContent = "kind=" + art.kind + " | status=" + art.status + " | inline comments=" + (art.comments ? art.comments.length : 0);
      approveBtn.style.display = art.kind === "plan" && art.status !== "approved" ? "inline-block" : "none";

      const rawLines = String(art.markdown || "").split("\\n");
      linesEl.innerHTML = "";
      rawLines.forEach((lineText, idx) => {
        const row = document.createElement("div");
        row.className = "code-line";
        row.innerHTML = '<span class="line-num">' + (idx + 1) + '</span><span></span>';
        row.lastChild.textContent = lineText || " ";
        row.addEventListener("click", () => {
          document.getElementById("steerStart").value = String(idx + 1);
          document.getElementById("steerEnd").value = String(idx + 1);
        });
        linesEl.appendChild(row);
      });
    }

    let skillLibraryEntries = [];
    async function refreshSkillLibrary() {
      try {
        const data = await apiJson("./api/skills");
        skillLibraryEntries = data.skills || [];
        const query = document.getElementById("skillLibrarySearch").value.trim().toLowerCase();
        const filter = document.getElementById("skillLibraryFilter").value;
        const box = document.getElementById("skillLibraryList");
        box.replaceChildren();
        const entries = skillLibraryEntries.filter(s => (!query || (s.name+" "+s.description+" "+s.source+" "+s.pathLabel).toLowerCase().includes(query)) && (filter === "all" || s.status === filter || (filter === "external" && s.status === "external")));
        if (!entries.length) {
          const empty = document.createElement("div"); empty.className="muted";
          empty.textContent = skillLibraryEntries.length ? "No skills match these filters." : "No skill folders found. Scanned workspace .agents/skills, .opencode/skills, .claude/skills and app quarantine/archive.";
          box.appendChild(empty); return;
        }
        const counts = new Map(); skillLibraryEntries.forEach(s => counts.set(s.name,(counts.get(s.name)||0)+1));
        entries.forEach(skill => {
          const row=document.createElement("div"); row.className="list-item"; row.tabIndex=0; row.style.cursor="pointer";
          const title=document.createElement("strong"); title.textContent=skill.name; row.appendChild(title);
          const badges=document.createElement("span"); badges.className="badge "+(skill.status==="active"?"ok":skill.status==="quarantined"?"warn":skill.status==="invalid"?"danger":""); badges.textContent=skill.status; row.appendChild(badges);
          if(skill.scanVerdict){const scan=document.createElement("span");scan.className="badge";scan.textContent="scan: "+skill.scanVerdict;row.appendChild(scan);}
          const desc=document.createElement("div");desc.className="muted";desc.textContent=skill.description;row.appendChild(desc);
          const loc=document.createElement("div");loc.className="muted mono";loc.textContent=skill.source+"/"+skill.pathLabel;row.appendChild(loc);
          if((counts.get(skill.name)||0)>1){const warning=document.createElement("div");warning.className="muted";warning.textContent="Duplicate skill name — choose the source explicitly.";row.appendChild(warning);}
          if(skill.warnings?.length){const warning=document.createElement("div");warning.className="muted";warning.textContent=skill.warnings.join("; ");row.appendChild(warning);}
          row.addEventListener("click",()=>openSkillDetail(skill)); row.addEventListener("keydown",e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();openSkillDetail(skill);}});
          const actions=document.createElement("div");actions.className="row";actions.style.marginTop="6px";
          if(skill.managed&&skill.status==="quarantined"){const promote=document.createElement("button");promote.className="success";promote.textContent="Review scan & promote";promote.addEventListener("click",async e=>{e.stopPropagation();try{const result=await apiJson("./api/quarantine/"+encodeURIComponent(skill.name)+"/promote",{method:"POST",body:"{}"});showToast("Promoted "+skill.name+" to active skills (scan="+result.scan.verdict+").");await refreshSkillLibrary();await refreshStatus();}catch(err){showToast(err.message,true);}});actions.appendChild(promote);}
          if(skill.managed&&skill.status==="active"){const archive=document.createElement("button");archive.textContent="Archive";archive.addEventListener("click",async e=>{e.stopPropagation();if(!confirm("Archive the managed skill '"+skill.name+"'?"))return;try{await apiJson("./api/skills",{method:"POST",body:JSON.stringify({action:"archive",name:skill.name})});await refreshSkillLibrary();await refreshStatus();}catch(err){showToast(err.message,true);}});actions.appendChild(archive);}
          if(skill.managed&&(skill.status==="quarantined"||skill.status==="archived")){const remove=document.createElement("button");remove.className="danger";remove.textContent="Delete";remove.addEventListener("click",async e=>{e.stopPropagation();if(!confirm("Permanently delete managed skill '"+skill.name+"'?"))return;try{await apiJson("./api/skills",{method:"POST",body:JSON.stringify({action:"delete",name:skill.name})});await refreshSkillLibrary();await refreshStatus();}catch(err){showToast(err.message,true);}});actions.appendChild(remove);}
          if(actions.childElementCount)row.appendChild(actions);box.appendChild(row);
        });
      } catch (err) { document.getElementById("skillLibraryList").textContent="Could not read skill folders: "+err.message; }
    }
    async function openSkillDetail(skill) {
      const panel=document.getElementById("skillLibraryDetail"); panel.textContent="Loading skill files…";
      try {
        const detail=await apiJson("./api/skills?id="+encodeURIComponent(skill.id));
        panel.textContent="";
        const meta=document.createElement("div");meta.textContent=detail.entry.name+" · "+detail.entry.status+" · "+detail.entry.source+"/"+detail.entry.pathLabel+" · sha256 "+detail.entry.contentSha256;panel.appendChild(meta);
        (detail.entry.warnings||[]).forEach(w=>{const warning=document.createElement("div");warning.textContent="Warning: "+w;panel.appendChild(warning);});
        (detail.files||[]).forEach(f=>{const heading=document.createElement("h4");heading.textContent=f.path;panel.appendChild(heading);const pre=document.createElement("pre");pre.style.cssText="white-space:pre-wrap;overflow-wrap:anywhere;";pre.textContent=f.content;panel.appendChild(pre);});
      } catch(err){panel.textContent="Could not open skill: "+err.message;}
    }
    document.getElementById("btnRefreshSkillLibrary").addEventListener("click",()=>refreshSkillLibrary());
    document.getElementById("skillLibrarySearch").addEventListener("input",()=>refreshSkillLibrary());
    document.getElementById("skillLibraryFilter").addEventListener("change",()=>refreshSkillLibrary());

    async function refreshStatus() {
      try {
        const st = await apiJson("./api/status");
        currentState = st;
        const vaultStatus=document.getElementById("obsidianVaultStatus");
        if(vaultStatus)vaultStatus.textContent=st.obsidianVault?.enabled?"Enabled · read-only · Markdown only (hidden/config paths excluded)":"Not configured · no vault access";

        document.getElementById("workspaceLabel").textContent = st.workspaceRoot + " (session " + st.sessionId.slice(0, 8) + ")";
        document.getElementById("schemaBadge").textContent = "Schema: " + st.prefix.activeSchemaTokens + " o200k";
        document.getElementById("prefixBadge").textContent =
          "Prefix: " + st.prefix.totalPrefixTokens + "/" + st.prefix.maxPrefixTokens + " (" + st.prefix.livePrefixSha256.slice(0, 10) + ")";
        document.getElementById("guardrailsBadge").textContent =
          "GUARDRAILS: " + (st.guardrailsPinVerified ? "Pinned " + st.guardrailsSha256.slice(0, 8) : "TAMPERED");
        const modeEl = document.getElementById("planModeBadge");
        modeEl.textContent = st.planModeActive ? "Mode: PLAN (Read-Only)" : "Mode: EXEC (Confined)";
        modeEl.className = "badge " + (st.planModeActive ? "warn" : "ok");

        // Render Artifacts
        document.getElementById("artifactCount").textContent = st.artifacts.length + " artifact(s)";
        const artList = document.getElementById("artifactList");
        artList.innerHTML = "";
        st.artifacts.forEach((a) => {
          const d = document.createElement("div");
          d.className = "list-item" + (a.artifactId === selectedArtifactId ? " selected" : "");
          const done = (a.todos || []).filter((t) => t.completed).length;
          const total = (a.todos || []).length;
          d.innerHTML =
            "<strong></strong> <span class='badge'>" + a.kind + "</span> <span class='badge " +
            (a.status === "approved" ? "ok" : a.status === "changes_requested" ? "warn" : "accent") +
            "'>" + a.status + "</span>" +
            (total > 0 ? " <span class='muted'>steps " + done + "/" + total + "</span>" : "");
          d.firstChild.textContent = a.title;
          d.addEventListener("click", () => {
            selectedArtifactId = a.artifactId;
            refreshStatus();
          });
          artList.appendChild(d);
        });
        renderSelectedArtifact();

        // Render Skills
        const sList = document.getElementById("skillsList");
        sList.innerHTML = "";
        if (st.skills.length === 0) {
          sList.innerHTML = "<div class='muted'>No skills in ledger yet.</div>";
        }
        st.skills.forEach((s) => {
          const item = document.createElement("div");
          item.className = "list-item";
          const vClass = s.lastScanVerdict === "safe" ? "ok" : s.lastScanVerdict === "caution" ? "warn" : "danger";
          item.innerHTML =
            "<div class='row' style='justify-content:space-between;'>" +
            "<div><strong class='mono'></strong> <span class='badge'>" + s.status + "</span> <span class='badge " + vClass + "'>scan: " + s.lastScanVerdict + "</span></div>" +
            "<div class='row'></div></div><div class='muted' style='margin-top:4px;'></div>";
          item.querySelector("strong").textContent = s.name;
          item.lastChild.textContent = s.description;
          const btnRow = item.querySelectorAll(".row")[1];
          if (s.status === "quarantined") {
            const pBtn = document.createElement("button");
            pBtn.className = s.lastScanVerdict === "dangerous" ? "danger" : "success";
            pBtn.textContent = "Approve & Promote";
            pBtn.addEventListener("click", async (ev) => {
              ev.stopPropagation();
              try {
                const res = await apiJson("./api/quarantine/" + encodeURIComponent(s.name) + "/promote", { method: "POST", body: "{}" });
                showToast("Promoted '" + s.name + "' -> " + res.promotedPath);
                await refreshStatus();
              } catch (err) {
                showToast(err.message, true);
              }
            });
            btnRow.appendChild(pBtn);
          }
          item.addEventListener("click", () => {
            try {
              const parsedScan = JSON.parse(s.lastScanJson || "{}");
              document.getElementById("skillInspectBox").textContent = JSON.stringify(parsedScan, null, 2);
            } catch {
              document.getElementById("skillInspectBox").textContent = s.lastScanJson;
            }
          });
          sList.appendChild(item);
        });

        // Render Checkpoints & WAL
        document.getElementById("currentLeafBadge").textContent = "leaf: " + (st.currentLeafId || "none");
        const cpList = document.getElementById("checkpointList");
        cpList.innerHTML = "";
        if (st.checkpoints.length === 0) {
          cpList.innerHTML = "<div class='muted'>No turn checkpoints recorded in this session yet.</div>";
        }
        st.checkpoints.forEach((cp) => {
          const item = document.createElement("div");
          item.className = "list-item";
          item.innerHTML =
            "<div class='row' style='justify-content:space-between;'>" +
            "<span class='mono'>Turn #" + cp.turn_index + " | leaf=" + cp.leaf_id + " | tree=" + cp.git_tree_oid.slice(0, 10) + "</span>" +
            "<button>Rewind Here</button></div>";
          item.querySelector("button").addEventListener("click", async () => {
            try {
              const rw = await apiJson("./api/rewind", {
                method: "POST",
                body: JSON.stringify({ toLeafId: cp.leaf_id })
              });
              showToast("Rewound workspace to leaf " + cp.leaf_id + " (restored=" + rw.restoredPaths.length + ", deleted=" + rw.deletedPaths.length + ")");
              await refreshStatus();
            } catch (err) {
              showToast(err.message, true);
            }
          });
          cpList.appendChild(item);
        });

        const walList = document.getElementById("walList");
        walList.innerHTML = "";
        if (st.walRows.length === 0) {
          walList.innerHTML = "<div class='muted'>No WAL tool intents recorded yet in current session.</div>";
        }
        st.walRows.forEach((w) => {
          const d = document.createElement("div");
          d.className = "list-item mono";
          d.textContent = w.tool_name + " [" + w.status + "] " + (w.target_path || "");
          walList.appendChild(d);
        });

        // Memory & Experience surfaces
        document.getElementById("memoryBox").textContent = st.surfaces.memoryMd;
        document.getElementById("memoryMeta").textContent =
          "Disk MEMORY.md: " + st.surfaces.memoryTokens + "/300 o200k tokens (frozen boot MEMORY.md: " + st.prefix.bootMemoryTokens + " tokens)";
        document.getElementById("memoryMeter").style.width = Math.min(100, Math.round((st.surfaces.memoryTokens / 300) * 100)) + "%";

        document.getElementById("expBox").textContent = st.surfaces.experienceMd;
        document.getElementById("expMeta").textContent =
          "Disk EXPERIENCE.md: " + st.surfaces.experienceTokens + "/220 o200k tokens";
        document.getElementById("expMeter").style.width = Math.min(100, Math.round((st.surfaces.experienceTokens / 220) * 100)) + "%";
      } catch (err) {
        showToast("Status error: " + err.message, true);
      }
    }

    document.getElementById("btnTogglePlan").addEventListener("click", async () => {
      try {
        const r = await apiJson("./api/plan/toggle", { method: "POST", body: "{}" });
        showToast("Plan Mode is now " + (r.planModeActive ? "ACTIVE (read-only)" : "INACTIVE (exec)"));
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnDoctor").addEventListener("click", async () => {
      try {
        const r = await apiJson("./api/slash", { method: "POST", body: JSON.stringify({ command: "/doctor" }) });
        document.getElementById("slashOutput").textContent = r.markdown;
        showToast("Doctor self-audit completed: ALL HEALTHY");
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnNewSession").addEventListener("click", async () => {
      try {
        const r = await apiJson("./api/new-session", { method: "POST", body: "{}" });
        showToast("Started fresh session " + r.sessionId.slice(0, 8) + " (reloaded staged MEMORY.md; prefix=" + r.prefixSha256.slice(0, 12) + ")");
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnCreateArtifact").addEventListener("click", async () => {
      try {
        const title = document.getElementById("newArtTitle").value.trim() || "Implementation Plan";
        const markdown = document.getElementById("newArtMarkdown").value;
        const art = await apiJson("./api/artifacts", {
          method: "POST",
          body: JSON.stringify({ kind: "plan", title, markdown })
        });
        selectedArtifactId = art.artifactId;
        showToast("Created Plan Trust Artifact " + art.artifactId);
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnApproveArtifact").addEventListener("click", async () => {
      if (!selectedArtifactId) return;
      try {
        await apiJson("./api/artifacts/" + encodeURIComponent(selectedArtifactId) + "/approve", { method: "POST", body: "{}" });
        showToast("Approved " + selectedArtifactId + " and unlocked execution mode.");
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnSendSteer").addEventListener("click", async () => {
      if (!selectedArtifactId) { showToast("Select a Trust Artifact first", true); return; }
      try {
        const lineStart = Number(document.getElementById("steerStart").value || 1);
        const lineEnd = Number(document.getElementById("steerEnd").value || lineStart);
        const comment = document.getElementById("steerComment").value.trim();
        const cmt = await apiJson("./api/artifacts/" + encodeURIComponent(selectedArtifactId) + "/steer", {
          method: "POST",
          body: JSON.stringify({ lineStart, lineEnd, comment })
        });
        showToast("Delivered inline steer comment " + cmt.commentId + " (L" + cmt.lineStart + "-L" + cmt.lineEnd + ")");
        document.getElementById("steerComment").value = "";
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnDistillSkill").addEventListener("click", async () => {
      try {
        const skillMd = document.getElementById("distillSkillMd").value;
        const res = await apiJson("./api/quarantine/distill", {
          method: "POST",
          body: JSON.stringify({ skillMd })
        });
        document.getElementById("skillInspectBox").textContent = JSON.stringify(res.scan, null, 2);
        showToast("Quarantined '" + res.record.name + "' (scan verdict: " + res.scan.verdict + ")");
        await refreshStatus();
        await refreshSkillLibrary();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnImportSkillFolder").addEventListener("click", async () => {
      try {
        const input=document.getElementById("skillFolderImport"); const selected=Array.from(input.files||[]);
        if(!selected.length) throw new Error("Choose a skill folder first.");
        if(selected.length>200) throw new Error("Skill import is limited to 200 files.");
        const files={}; let total=0; let skillMd="";
        for(const file of selected){
          if(file.size>512000) throw new Error("A skill file exceeds the 512 KiB limit.");
          const relative=(file.webkitRelativePath||file.name).split("/").slice(1).join("/")||file.name;
          if(relative.split("/").some(part=>part===".."||part===".")) throw new Error("Unsafe path in selected skill folder.");
          const text=await file.text(); total+=new Blob([text]).size; if(total>2*1024*1024)throw new Error("Skill folder exceeds 2 MiB total.");
          if(relative==="SKILL.md") skillMd=text; else files[relative]=text;
        }
        if(!skillMd) throw new Error("Selected folder must contain SKILL.md at its root.");
        const res=await apiJson("./api/quarantine/distill",{method:"POST",body:JSON.stringify({skillMd,supportingFiles:files,source:"operator-local-folder-import"})});
        document.getElementById("skillInspectBox").textContent=JSON.stringify(res.scan,null,2);input.value="";
        showToast("Imported '"+res.record.name+"' into quarantine ("+res.scan.verdict+"). Review before promoting.");await refreshSkillLibrary();await refreshStatus();
      } catch(err){showToast(err.message,true);}
    });

    document.getElementById("btnLifecyclePass").addEventListener("click", async () => {
      try {
        const res = await apiJson("./api/quarantine/lifecycle", { method: "POST", body: "{}" });
        showToast("Lifecycle pass: stale=[" + res.markedStale.join(",") + "] archived=[" + res.archived.join(",") + "]");
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnRunDream").addEventListener("click", async () => {
      try {
        const res = await apiJson("./api/dream", { method: "POST", body: "{}" });
        showToast("Dreaming staged " + res.memoryMdTokens + "/300 tokens into MEMORY.md (0 live prefix drift; click '/new Session Reload' to activate!)");
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnRunSlash").addEventListener("click", async () => {
      try {
        const cmd = document.getElementById("slashInput").value.trim();
        if (!cmd) return;
        if (cmd.startsWith("/")) {
          const res = await apiJson("./api/slash", { method: "POST", body: JSON.stringify({ command: cmd }) });
          document.getElementById("slashOutput").textContent = res.markdown || "(command executed)";
        } else {
          const res = await apiJson("./api/prompt", { method: "POST", body: JSON.stringify({ text: cmd, mode: "prompt" }) });
          document.getElementById("slashOutput").textContent = res.replyText || "(prompt completed)";
        }
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    async function loadProviderCatalog(offset=0,append=false){const q=document.getElementById("modelCatalogQuery").value.trim();const provider=document.getElementById("modelProviderFilter").value.trim();const params=new URLSearchParams({q,offset:String(offset),limit:"50"});if(provider)params.set("provider",provider);if(document.getElementById("modelFavoritesOnly").checked)params.set("favorites","1");if(document.getElementById("modelRecentOnly").checked)params.set("recent","1");const data=await apiJson("./api/catalog?"+params.toString());const box=document.getElementById("modelCatalogResults");if(!append)box.replaceChildren();const summary=document.createElement("div");summary.className="muted";summary.textContent=data.total+" catalog model(s) · showing "+Math.min(data.total,offset+data.models.length)+(data.remoteCatalog?" · models.dev cache refreshed "+new Date(data.remoteCatalog.refreshedAtMs).toLocaleString()+(data.remoteCatalog.stale?" (STALE — refresh recommended)":" (metadata only)"):" · remote catalog not yet refreshed");if(!append)box.appendChild(summary);(data.models||[]).forEach(m=>{const row=document.createElement("div");row.className="list-item row";const label=document.createElement("span");label.textContent=m.provider+"/"+m.id+" · "+m.name+" · "+(m.supportsImage?"image":"text")+(m.reasoning?" · reasoning":"")+" · context "+m.contextWindow;row.appendChild(label);const star=document.createElement("button");star.textContent=m.favorite?"★":"☆";star.title=m.favorite?"Remove favorite":"Add favorite";star.setAttribute("aria-label",star.title);star.addEventListener("click",async()=>{try{await apiJson("./api/models",{method:"POST",body:JSON.stringify({action:"set_favorite",provider:m.provider,modelId:m.id,favorite:!m.favorite})});await loadProviderCatalog();}catch(err){showToast(err.message,true);}});row.appendChild(star);const b=document.createElement("button");const runtimeModel=Boolean(m.runtimeRegistered);const canSelect=Boolean(m.configured&&runtimeModel);b.textContent=canSelect?"Use model":runtimeModel?"Connect provider":"Add to custom endpoint";b.disabled=false;b.title=canSelect?"Set as this conversation's model":runtimeModel?"Choose this provider, then enter its API key":"Prefill an advisory model definition into the custom connection form; endpoint compatibility must be verified";b.addEventListener("click",async()=>{if(canSelect){try{await apiJson("./api/models",{method:"POST",body:JSON.stringify({action:"set_model",provider:m.provider,modelId:m.id})});await refreshV2Panels();showToast("Selected "+m.provider+"/"+m.id);}catch(err){showToast(err.message,true);}return;}if(runtimeModel){const p=document.getElementById("apiKeyProvider");p.value=m.provider;document.getElementById("apiKeyInput").focus();showToast("Enter a key for "+m.provider+" and choose Set Key.");return;}const details=document.querySelector("#tab-models-mcp details");details.open=true;document.getElementById("customProviderName").value=m.providerName||m.provider;document.getElementById("customProviderManualModel").value=m.id;document.getElementById("customProviderName").scrollIntoView({block:"center"});showToast("Advisory model ID copied only. Set a compatible endpoint and verify the model before connecting; capabilities are not copied.");});row.appendChild(b);box.appendChild(row);});if(data.hasMore){const more=document.createElement("button");more.textContent="Load next 50";more.addEventListener("click",()=>loadProviderCatalog(offset+data.models.length,true));box.appendChild(more);}}
    document.getElementById("btnSearchModelCatalog").addEventListener("click",()=>loadProviderCatalog().catch(err=>showToast(err.message,true)));
    document.getElementById("btnRefreshRuntimeCatalog").addEventListener("click",async()=>{try{const r=await apiJson("./api/catalog",{method:"POST",body:JSON.stringify({action:"refresh_runtime"})});showToast("Refreshed "+r.providerCount+" configured provider(s); "+r.failedProviderIds.length+" reported catalog errors.",r.failedProviderIds.length>0);await loadProviderCatalog();await refreshV2Panels();}catch(err){showToast(err.message,true);}});
    document.getElementById("btnRefreshRemoteCatalog").addEventListener("click",async()=>{try{const r=await apiJson("./api/catalog",{method:"POST",body:JSON.stringify({action:"refresh_remote"})});showToast("Refreshed models.dev metadata: "+r.modelCount+" models.");await loadProviderCatalog();}catch(err){showToast(err.message,true);}});
    document.getElementById("modelCatalogQuery").addEventListener("keydown",e=>{if(e.key==="Enter")loadProviderCatalog().catch(err=>showToast(err.message,true));});
    document.getElementById("modelFavoritesOnly").addEventListener("change",()=>loadProviderCatalog().catch(err=>showToast(err.message,true)));
    document.getElementById("modelRecentOnly").addEventListener("change",()=>loadProviderCatalog().catch(err=>showToast(err.message,true)));

    async function refreshV2Panels() {
      try {
        const [tr, df, md, ss, mcp, providerData] = await Promise.all([
          apiJson("./api/transcript"),
          apiJson("./api/diff"),
          apiJson("./api/models"),
          apiJson("./api/sessions"),
          apiJson("./api/mcp"),
          apiJson("./api/providers")
        ]);

        // Header model + cache hit badge
        const hitPct = tr.usage ? tr.usage.cacheHitRatePct : 0;
        const costUsd = tr.usage ? tr.usage.totalCostUsd : 0;
        document.getElementById("modelCacheBadge").textContent =
          "Model: " + (tr.activeModel || "none") + " | Cache: " + hitPct + "%";
        document.getElementById("usageTelemetryLine").textContent =
          "Active: " + tr.activeModel + " | Cache Hit: " + hitPct + "% | Input: " +
          (tr.usage ? tr.usage.inputTokens : 0) + " | Output: " +
          (tr.usage ? tr.usage.outputTokens : 0) + " | Cost: $" + Number(costUsd).toFixed(6);
        document.getElementById("chatStreamingBadge").textContent = tr.isStreaming ? "STREAMING..." : "idle";

        // 1. Transcript
        const chatBox = document.getElementById("chatTranscriptBox");
        chatBox.innerHTML = "";
        if (!tr.messages || tr.messages.length === 0) {
          chatBox.innerHTML = "<div class='muted'>No messages in this session yet. Send a prompt below or run /doctor!</div>";
        } else {
          tr.messages.forEach((m) => {
            const card = document.createElement("div");
            card.className = "list-item";
            const badgeClass = m.role === "user" ? "accent" : m.role === "assistant" ? "ok" : m.isError ? "danger" : "";
            const header = document.createElement("div");
            header.innerHTML =
              "<span class='badge " + badgeClass + "'>" + m.role + (m.toolName ? ":" + m.toolName : "") + "</span> " +
              (m.model ? "<span class='muted mono'>" + m.model + "</span>" : "");
            const body = document.createElement("pre");
            body.style.cssText = "margin:6px 0 0 0;white-space:pre-wrap;font-size:12px;color:#e2e8f0;";
            let fullTxt = m.text || "";
            if (m.toolCalls && m.toolCalls.length > 0) {
              fullTxt += (fullTxt ? "\\n" : "") + m.toolCalls.map((tc) => "[toolCall " + tc.name + "] " + tc.argsPreview).join("\\n");
            }
            body.textContent = fullTxt || (m.role === "assistant" ? "[No text response" + (m.stopReason ? " · " + m.stopReason : "") + (m.failureCode ? " · " + m.failureCode : "") + "]" : "(empty)");
            card.appendChild(header);
            card.appendChild(body);
            if (m.role === "assistant" && fullTxt.trim()) {
              const listen=document.createElement("button"); listen.textContent="Listen"; listen.className="listen-reply"; listen.style.marginTop="8px";
              listen.addEventListener("click",()=>speakReply(fullTxt)); card.appendChild(listen);
            }
            chatBox.appendChild(card);
          });
          chatBox.scrollTop = chatBox.scrollHeight;
        }

        // 2. Git Diff Viewer
        document.getElementById("diffStatusSummary").textContent =
          df.changedFilesCount > 0
            ? df.changedFilesCount + " modified/untracked file(s): " + df.statusLines.join(" | ")
            : "Clean working tree (0 uncommitted changes).";
        document.getElementById("diffViewerBox").textContent =
          df.diffText && df.diffText.trim() ? df.diffText : "(no uncommitted diff against HEAD)";

        // 3. Model catalog selector
        currentAutoTargets = md.autoTargets || null;
        const sel = document.getElementById("modelCatalogSelect");
        sel.innerHTML = "";
        const chatSel = document.getElementById("chatModelSelect");
        sel.innerHTML = ""; chatSel.innerHTML = "";
        (md.models || []).forEach((m) => {
          const opt = document.createElement("option");
          opt.value = m.provider + ":::" + m.id;
          opt.textContent = m.provider + "/" + m.id + (m.isVirtual ? " [virtual router]" : "") + (m.supportsImage ? " [image]" : "");
          opt.dataset.supportsImage = String(Boolean(m.supportsImage));
          if (md.activeModel === m.provider + "/" + m.id) opt.selected = true;
          sel.appendChild(opt);
          const chatOpt=opt.cloneNode(true); chatSel.appendChild(chatOpt);
        });
        chatSel.value=md.activeModel.replace("/",":::");
        document.getElementById("imageModelNotice").style.display=chatSel.selectedOptions[0]?.dataset.supportsImage==="true"?"none":"block";
        if (["low","medium","high","max"].includes(md.thinkingLevel)) document.getElementById("chatReasoning").value=md.thinkingLevel;
        document.getElementById("effectiveReasoning").textContent="Effective: "+(md.thinkingLevel||"unknown");
        updateTurnContextBadge(); updateTaskModeRecommendation();

        // Provider inventory and named compatible connections (all text is inserted as textContent).
        const keyProvider=document.getElementById("apiKeyProvider");const priorProvider=keyProvider.value;keyProvider.replaceChildren();(providerData.providers||[]).forEach(p=>{const option=document.createElement("option");option.value=p.id;option.textContent=p.name+" ("+p.id+")";keyProvider.appendChild(option);});if(Array.from(keyProvider.options).some(o=>o.value===priorProvider))keyProvider.value=priorProvider;
        const pBox=document.getElementById("providerConnectionsBox");pBox.replaceChildren();
        const pHead=document.createElement("div");pHead.className="muted";pHead.textContent=(providerData.providers?.length||0)+" runtime providers · "+(providerData.connections?.length||0)+" custom connections";pBox.appendChild(pHead);
        (providerData.connections||[]).forEach((c)=>{const row=document.createElement("div");row.className="list-item row";const label=document.createElement("span");label.textContent=c.name+" · "+c.adapter+" · "+c.models.length+" models · "+new URL(c.baseUrl).host+(c.enabled?" · enabled":" · disabled");row.appendChild(label);const test=document.createElement("button");test.textContent="Test";test.title="Send a small authenticated models-list request to this provider";test.addEventListener("click",async()=>{try{const result=await apiJson("./api/providers",{method:"POST",body:JSON.stringify({action:"test_connection",id:c.id})});showToast(result.ok?"Connection verified ("+result.latencyMs+" ms).":"Provider responded HTTP "+result.httpStatus+".",!result.ok);}catch(err){showToast(err.message,true);}});test.disabled=!c.enabled;row.appendChild(test);const toggle=document.createElement("button");toggle.textContent=c.enabled?"Disable":"Enable";toggle.addEventListener("click",async()=>{try{await apiJson("./api/providers",{method:"POST",body:JSON.stringify({action:"set_enabled",id:c.id,enabled:!c.enabled})});await refreshV2Panels();}catch(err){showToast(err.message,true);}});row.appendChild(toggle);const remove=document.createElement("button");remove.textContent="Disconnect";remove.addEventListener("click",async()=>{try{await apiJson("./api/providers",{method:"POST",body:JSON.stringify({action:"remove_connection",id:c.id})});await refreshV2Panels();showToast("Disconnected "+c.name);}catch(err){showToast(err.message,true);}});row.appendChild(remove);pBox.appendChild(row);});
        (providerData.providers||[]).slice(0,40).forEach((p)=>{const row=document.createElement("div");row.className="muted";row.textContent=(p.configured?"● ":"○ ")+p.name+" — "+p.modelCount+" models"+(p.connection?" · custom connection":"");pBox.appendChild(row);});

        // 4. Saved Workspace Sessions
        const sBox = document.getElementById("sessionsListBox");
        sBox.innerHTML = "";
        if (!ss.sessions || ss.sessions.length === 0) {
          sBox.innerHTML = "<div class='muted'>Current session is active (saved on first message).</div>";
        } else {
          ss.sessions.slice(0, 12).forEach((s) => {
            const row = document.createElement("div");
            row.className = "list-item row";
            row.style.justifyContent = "space-between";
            const info = document.createElement("div");
            info.innerHTML =
              "<strong class='mono'>" + s.id.slice(0, 8) + "</strong> " +
              (s.isCurrent ? "<span class='badge ok'>current</span> " : "") +
              "<span class='muted'>(" + s.messageCount + " msgs)</span>";
            const sub = document.createElement("div");
            sub.className = "muted";
            sub.textContent = s.firstMessage || "(no prompt yet)";
            info.appendChild(sub);
            row.appendChild(info);
            if (!s.isCurrent) {
              const b = document.createElement("button");
              b.textContent = "Switch";
              b.addEventListener("click", async () => {
                try {
                  await apiJson("./api/sessions", {
                    method: "POST",
                    body: JSON.stringify({ sessionPath: s.path })
                  });
                  showToast("Switched to session " + s.id.slice(0, 8));
                  await refreshStatus();
                } catch (err) { showToast(err.message, true); }
              });
              row.appendChild(b);
            }
            sBox.appendChild(row);
          });
        }

        // 5. Confined MCP Hub
        document.getElementById("mcpTrustBadge").textContent = mcp.workspaceTrusted ? "Workspace Trusted" : "Untrusted (Stdio Blocked)";
        document.getElementById("mcpTrustBadge").className = "badge " + (mcp.workspaceTrusted ? "ok" : "warn");
        document.getElementById("mcpRestoreIssuesBox").textContent=(mcp.restoreIssues||[]).length?"Not restored: "+mcp.restoreIssues.join("; "):"Remote HTTPS server definitions are stored in .harness/mcp-remote-servers.json (no credentials).";
        const mSrv = document.getElementById("mcpServersBox");
        mSrv.innerHTML = "";
        if (!mcp.servers || mcp.servers.length === 0) {
          mSrv.innerHTML = "<div class='muted'>No MCP servers connected (+0 active schema tokens).</div>";
        } else {
          mcp.servers.forEach((sv) => {
            const item = document.createElement("div");
            item.className = "list-item row";
            item.style.justifyContent = "space-between";
            const left = document.createElement("div");
            left.textContent = sv.name + " [" + sv.transportKind + "] safe=" + sv.safeTools + " poisoned=" + sv.poisonedTools;
            const dBtn = document.createElement("button");
            dBtn.className = "danger";
            dBtn.textContent = "Disconnect";
            dBtn.addEventListener("click", async () => {
              try {
                await apiJson("./api/mcp", { method: "POST", body: JSON.stringify({ action: "disconnect", name: sv.name }) });
                await refreshV2Panels();
              } catch (err) { showToast(err.message, true); }
            });
            item.appendChild(left);
            item.appendChild(dBtn);
            mSrv.appendChild(item);
          });
        }
        const mTools = document.getElementById("mcpToolsBox");
        mTools.innerHTML = "";
        (mcp.tools || []).forEach((t) => {
          const d = document.createElement("div");
          d.className = "list-item";
          d.textContent = t.serverName + "/" + t.name + " [scan=" + t.scanVerdict + (t.poisoned ? " BLOCKED" : "") + "] - " + t.description;
          mTools.appendChild(d);
        });
      } catch {}
    }

    document.getElementById("btnSendPrompt").addEventListener("click", async () => {
      let pendingText = "";
      let pendingCard = null;
      try {
        const input = document.getElementById("chatPromptInput");
        const txt = input.value.trim();
        const selectedTaskMode = document.getElementById("taskModeSelect").value;
        pendingText = txt;
        if (!txt && attachedImages.length === 0 && !attachedDocument) return;
        if (txt.startsWith("/") && (attachedImages.length || attachedDocument)) throw new Error("Remove attachments before running a /slash command.");
        input.value = "";
        // Show the submitted user turn immediately; the API responds only after model generation ends.
        if (txt && !txt.startsWith("/")) {
          const chatBox = document.getElementById("chatTranscriptBox");
          const emptyHint = chatBox.querySelector(".muted");
          if (emptyHint && emptyHint.textContent.includes("No messages in this session")) emptyHint.remove();
          pendingCard = document.createElement("div");
          pendingCard.className = "list-item pending-user-message";
          const head = document.createElement("div");
          const modeBadge=selectedTaskMode!=="automatic"?" <span class='badge'>"+TASK_MODE_LABELS[selectedTaskMode]+" mode</span>":"";
          head.innerHTML = "<span class='badge accent'>user</span>"+modeBadge+" <span class='muted'>sending…</span>";
          const body = document.createElement("pre");
          body.style.cssText = "margin:6px 0 0 0;white-space:pre-wrap;font-size:12px;color:#e2e8f0;";
          body.textContent = txt;
          pendingCard.append(head, body);
          chatBox.appendChild(pendingCard);
          chatBox.scrollTop = chatBox.scrollHeight;
        }
        if (txt.startsWith("/")) {
          await apiJson("./api/slash", { method: "POST", body: JSON.stringify({ command: txt }) });
        } else {
          const result=await apiJson("./api/prompt", { method: "POST", body: JSON.stringify({ text: txt, mode: "prompt", taskMode:selectedTaskMode, images:attachedImages, ...(attachedDocument?{document:{filename:attachedDocument.filename,mimeType:attachedDocument.mimeType,dataBase64:attachedDocument.dataBase64}}:{}), personaId:document.getElementById("chatPersona").value, buildProfile:document.getElementById("chatBuildProfile").value }) });
          attachedImages=[]; attachedDocument=null; renderImagePreviews(); renderDocumentPreview();
          document.getElementById("taskModeSelect").value="automatic"; updateTaskModeRecommendation();
          await refreshV2Panels();
          if(document.getElementById("autoReadReplies").checked && result.replyText) await speakReply(result.replyText);
        }
        if(transcriptPending){transcriptPending=false;document.getElementById("btnSendPrompt").textContent="Send";}
        document.getElementById("liveStreamBox").style.display = "none";
        document.getElementById("liveStreamBox").textContent = "";
        await refreshStatus();
      } catch (err) {
        const input = document.getElementById("chatPromptInput");
        if (pendingCard?.isConnected) {
          const label = pendingCard.querySelector(".muted");
          if (label) label.textContent = "send failed — not confirmed";
          if (!input.value) input.value = pendingText;
        }
        showToast(err.message, true);
      }
    });

    document.getElementById("btnSteerPrompt").addEventListener("click", async () => {
      try {
        const input = document.getElementById("chatPromptInput");
        const txt = input.value.trim();
        if (!txt) return;
        input.value = "";
        await apiJson("./api/prompt", { method: "POST", body: JSON.stringify({ text: txt, mode: "steer" }) });
        showToast("Delivered mid-turn steer message");
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnAbortTurn").addEventListener("click", async () => {
      try {
        await apiJson("./api/abort", { method: "POST", body: "{}" });
        showToast("Aborted in-flight turn");
        await refreshStatus();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnRefreshDiff").addEventListener("click", () => refreshV2Panels());
    document.getElementById("btnRunBugBot").addEventListener("click", async () => {
      try {
        const res = await apiJson("./api/slash", { method: "POST", body: JSON.stringify({ command: "/review uncommitted" }) });
        document.getElementById("diffViewerBox").textContent = res.markdown || "(BugBot clean)";
        showToast("BugBot diff review completed");
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnUseApexAuto").addEventListener("click", async () => {
      try {
        await apiJson("./api/models", { method: "POST", body: JSON.stringify({ action: "set_model", provider: "apex", modelId: "auto" }) });
        showToast("Switched active model to apex/auto (Plan-Strong / Implement-Fast)");
        await refreshV2Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnSwitchModel").addEventListener("click", async () => {
      try {
        const val = document.getElementById("modelCatalogSelect").value;
        if (!val) return;
        const parts = val.split(":::");
        await apiJson("./api/models", { method: "POST", body: JSON.stringify({ action: "set_model", provider: parts[0], modelId: parts[1] }) });
        showToast("Switched model to " + parts[0] + "/" + parts[1]);
        await refreshV2Panels();
      } catch (err) { showToast(err.message, true); }
    });

    async function loadConnectedProviderModels(provider){const step=document.getElementById("connectedProviderModelStep"),select=document.getElementById("connectedProviderModel"),status=document.getElementById("connectedProviderModelStatus");try{const params=new URLSearchParams({provider,offset:"0",limit:"200"});const data=await apiJson("./api/catalog?"+params.toString());const models=(data.models||[]).filter(m=>m.runtimeRegistered&&m.configured);select.replaceChildren();for(const m of models){const option=document.createElement("option");option.value=m.provider+":::"+m.id;option.textContent=m.name+" · "+m.id;select.appendChild(option);}step.style.display=models.length?"flex":"none";status.textContent=models.length?models.length+" runtime model(s) ready for explicit selection. Credentials were saved but not preflighted.":"No configured runtime models are listed for this provider yet. Check provider support or refresh runtime models.";}catch{step.style.display="none";status.textContent="Could not load provider models. The key remains saved; use the model selector after refreshing.";}}
    document.getElementById("btnUseConnectedProviderModel").addEventListener("click",async()=>{try{const [provider,modelId]=document.getElementById("connectedProviderModel").value.split(":::");await apiJson("./api/models",{method:"POST",body:JSON.stringify({action:"set_model",provider,modelId})});await refreshV2Panels();showToast("Selected "+provider+"/"+modelId);}catch(err){showToast(err.message,true);}});
    document.getElementById("btnSaveApiKey").addEventListener("click", async () => {
      const keyInput=document.getElementById("apiKeyInput");
      try {
        const provider = document.getElementById("apiKeyProvider").value;
        const apiKey = keyInput.value.trim();
        await apiJson("./api/models", { method: "POST", body: JSON.stringify({ action: "set_api_key", provider, apiKey }) });
        showToast("Saved provider credentials for " + provider + ". The key is not preflighted.");
        await refreshV2Panels();
        await loadConnectedProviderModels(provider);
      } catch (err) { showToast(err.message, true); }
      finally { keyInput.value=""; }
    });

    document.getElementById("btnOneShotOpenRouterTest").addEventListener("click",async()=>{const keyInput=document.getElementById("oneShotOpenRouterKey");const modelInput=document.getElementById("oneShotOpenRouterModel");const button=document.getElementById("btnOneShotOpenRouterTest");const resultBox=document.getElementById("oneShotOpenRouterResult");button.disabled=true;resultBox.textContent="Sending one bounded test request…";try{const result=await apiJson("./api/providers",{method:"POST",body:JSON.stringify({action:"one_shot_openrouter_test",apiKey:keyInput.value,modelId:modelInput.value})});resultBox.textContent="Success · "+result.modelId+" · "+result.latencyMs+" ms · reply: "+result.reply+" · This isolated probe is not added to chat or model selection.";showToast("One-time OpenRouter request succeeded.");}catch(err){resultBox.textContent="Test failed. The key was not saved. Check the model ID, key permissions, provider availability, or rate limits.";showToast("One-time OpenRouter request failed; the key was not saved.",true);}finally{keyInput.value="";button.disabled=false;}});
    document.getElementById("btnStartEphemeralOpenRouter").addEventListener("click",async()=>{const keyInput=document.getElementById("ephemeralOpenRouterKey");const button=document.getElementById("btnStartEphemeralOpenRouter");const status=document.getElementById("ephemeralOpenRouterStatus");button.disabled=true;status.textContent="Starting temporary model session…";try{const result=await apiJson("./api/providers",{method:"POST",body:JSON.stringify({action:"begin_ephemeral_openrouter_session",apiKey:keyInput.value,modelId:document.getElementById("ephemeralOpenRouterModel").value})});document.getElementById("btnEndEphemeralOpenRouter").disabled=false;status.textContent="Active · "+result.modelId+" selected · up to 3 chat turns / 5 minutes · key is memory-only. Use the regular chat box, then click End test.";showToast("Temporary model selected. Send a chat turn to test streaming.");await refreshV2Panels();}catch(err){const code=String(err.message||"");status.textContent=code.includes("AUTH_REJECTED")?"OpenRouter rejected this key. It may be expired, revoked, or missing inference permission.":code.includes("FREE_MODEL_REQUIRED")?"Temporary chat requires an OpenRouter model ID ending in :free.":"Could not validate the temporary provider. Check the model ID, key, and OpenRouter availability.";showToast(status.textContent,true);}finally{keyInput.value="";button.disabled=false;}});
    document.getElementById("btnEndEphemeralOpenRouter").addEventListener("click",async()=>{try{await apiJson("./api/providers",{method:"POST",body:JSON.stringify({action:"end_ephemeral_openrouter_session"})});document.getElementById("btnEndEphemeralOpenRouter").disabled=true;document.getElementById("ephemeralOpenRouterStatus").textContent="Temporary provider ended; credential removed from runtime memory.";await refreshV2Panels();showToast("Temporary OpenRouter session ended.");}catch(err){showToast("Could not end the temporary session.",true);}});
    let discoveredProviderModels=[];
    document.getElementById("btnConnectProvider").addEventListener("click",()=>{document.querySelector('[data-tab="tab-models-mcp"]').click();const details=document.getElementById("connectProviderDetails");details.open=true;details.scrollIntoView({behavior:"smooth",block:"center"});document.getElementById("customProviderUrl").focus();});
    document.getElementById("btnDiscoverCustomModels").addEventListener("click",async()=>{const button=document.getElementById("btnDiscoverCustomModels"),status=document.getElementById("customProviderDiscoveryResult"),box=document.getElementById("customProviderDiscoveredModels");button.disabled=true;status.textContent="Verifying endpoint and reading model IDs…";box.replaceChildren();try{const result=await apiJson("./api/providers",{method:"POST",body:JSON.stringify({action:"discover_custom",baseUrl:document.getElementById("customProviderUrl").value,apiKey:document.getElementById("customProviderKey").value})});discoveredProviderModels=result.models||[];box.style.display="block";if(!discoveredProviderModels.length){status.textContent="Endpoint responded, but no valid model IDs were found. Enter a model ID manually below.";}else{status.textContent=discoveredProviderModels.length+" model ID(s) discovered from endpoint. Capabilities are unverified; select the model(s) to register.";for(const model of discoveredProviderModels){const row=document.createElement("label");row.className="list-item row";const check=document.createElement("input");check.type="checkbox";check.value=model.id;check.style.width="auto";check.checked=true;const active=document.createElement("input");active.type="radio";active.name="connectActiveModel";active.value=model.id;active.title="Use this as the active model after connecting";active.style.width="auto";active.checked=box.querySelectorAll("input[type=radio]").length===0;const label=document.createElement("span");label.textContent=model.name+" · "+model.id+" · capabilities unknown";row.append(check,active,label);box.appendChild(row);}}document.getElementById("btnAddCustomProvider").disabled=!discoveredProviderModels.length&&!document.getElementById("customProviderManualModel").value.trim();}catch(err){discoveredProviderModels=[];box.style.display="none";status.textContent="Discovery failed. You can enter a model ID manually; compatibility and capabilities will remain unverified.";showToast(err.message,true);}finally{button.disabled=false;document.getElementById("customProviderKey").setAttribute("autocomplete","new-password");}});
    document.getElementById("customProviderManualModel").addEventListener("input",()=>{document.getElementById("btnAddCustomProvider").disabled=!discoveredProviderModels.length&&!document.getElementById("customProviderManualModel").value.trim();});
    document.getElementById("btnAddCustomProvider").addEventListener("click",async()=>{const keyInput=document.getElementById("customProviderKey");try{const rows=[...document.querySelectorAll("#customProviderDiscoveredModels input[type=checkbox]:checked")];const models=rows.map(ch=>{const item=discoveredProviderModels.find(m=>m.id===ch.value);return {id:item.id,name:item.name,input:["text"],reasoning:false,contextWindow:128000,maxTokens:16384};});const manual=document.getElementById("customProviderManualModel").value.trim();if(!models.length&&manual)models.push({id:manual,name:manual,input:["text"],reasoning:false,contextWindow:128000,maxTokens:16384});if(!models.length)throw new Error("Select at least one discovered model or enter a model ID.");const active=document.querySelector("#customProviderDiscoveredModels input[type=radio]:checked")?.value||models[0].id;if(!models.some(m=>m.id===active))throw new Error("Choose an active model from the selected models.");const res=await apiJson("./api/providers",{method:"POST",body:JSON.stringify({action:"add_custom",name:document.getElementById("customProviderName").value,adapter:"openai-compatible",baseUrl:document.getElementById("customProviderUrl").value,apiKey:keyInput.value,models})});keyInput.value="";await apiJson("./api/models",{method:"POST",body:JSON.stringify({action:"set_model",provider:res.connection.id,modelId:active})});discoveredProviderModels=[];document.getElementById("customProviderManualModel").value="";document.getElementById("customProviderDiscoveryResult").textContent="Connected. Model IDs came from the endpoint; capabilities remain unverified.";showToast("Connected "+res.connection.name+" and selected "+active+". Capabilities are unverified.");await refreshV2Panels();}catch(err){showToast(err.message,true);}finally{keyInput.value="";}});

    document.getElementById("btnRegisterOllama").addEventListener("click", async () => {
      try {
        const modelId = document.getElementById("ollamaModelInput").value.trim();
        const baseUrl = document.getElementById("ollamaUrlInput").value.trim();
        const res = await apiJson("./api/models", {
          method: "POST",
          body: JSON.stringify({ action: "register_ollama", modelId, baseUrl, activate: true })
        });
        showToast("Registered & activated local Ollama model: " + res.activeModel);
        await refreshV2Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnConnectMcpStdio").addEventListener("click", async () => {
      try {
        const name = document.getElementById("mcpNameInput").value.trim();
        const command = document.getElementById("mcpCmdInput").value.trim();
        const rawArgs = document.getElementById("mcpArgsInput").value.trim();
        const args = rawArgs ? rawArgs.split(/\\s+/) : [];
        const res = await apiJson("./api/mcp", {
          method: "POST",
          body: JSON.stringify({ action: "connect_stdio", name, command, args })
        });
        showToast("Connected MCP server '" + res.summary.name + "' (" + res.summary.safeTools + " safe tools)");
        await refreshV2Panels();
      } catch (err) { showToast(err.message, true); }
    });
    document.getElementById("btnConnectMcpRemote").addEventListener("click",async()=>{try{const name=document.getElementById("mcpRemoteNameInput").value.trim();const url=document.getElementById("mcpRemoteUrlInput").value.trim();const res=await apiJson("./api/mcp",{method:"POST",body:JSON.stringify({action:"connect_http",name,url})});showToast("Connected remote MCP '"+res.summary.name+"' ("+res.summary.safeTools+" safe tools)");await refreshV2Panels();}catch(err){showToast(err.message,true);}});

    async function refreshV3Panels() {
      try {
        const [prs, pres, brw, wss] = await Promise.all([
          apiJson("./api/pr-pipeline"),
          apiJson("./api/presets"),
          apiJson("./api/browser"),
          apiJson("./api/workspaces")
        ]);

        // 1. PR Runs
        const prBox = document.getElementById("prRunsListBox");
        const prPreview = document.getElementById("prBundlePreviewBox");
        prBox.innerHTML = "";
        const prRuns = prs.runs || [];
        if (prRuns.length === 0) {
          prBox.innerHTML = "<div class='muted'>No PR runs yet. Enter a title above and click Run PR Pipeline.</div>";
          prPreview.style.display = "none";
        } else {
          prRuns.slice(0, 8).forEach((r, idx) => {
            const item = document.createElement("div");
            item.className = "list-item";
            item.style.cursor = "pointer";
            item.textContent = "[" + r.status.toUpperCase() + "] " + r.branchName + " -> " + r.baseBranch + " (" + r.title + ")";
            item.addEventListener("click", () => {
              prPreview.style.display = "block";
              prPreview.textContent = r.markdown || r.ghCommand || "";
            });
            prBox.appendChild(item);
            if (idx === 0 && !prPreview.textContent) {
              prPreview.style.display = "block";
              prPreview.textContent = r.markdown || r.ghCommand || "";
            }
          });
        }

        // 2. Presets & Bookmarks
        const pSel = document.getElementById("presetSelect");
        pSel.innerHTML = "";
        const clearOpt = document.createElement("option");
        clearOpt.value = "clear";
        clearOpt.textContent = "(none — default core posture)";
        pSel.appendChild(clearOpt);
        (pres.presets || []).forEach((p) => {
          const opt = document.createElement("option");
          opt.value = p.name;
          opt.textContent = p.name + (p.active ? " [ACTIVE]" : "") + " — " + p.summary;
          if (p.active) opt.selected = true;
          pSel.appendChild(opt);
        });

        const bmBox = document.getElementById("bookmarksListBox");
        bmBox.innerHTML = "";
        (pres.bookmarks || []).forEach((b) => {
          const d = document.createElement("div");
          d.className = "list-item";
          d.textContent = "[" + b.label + "] entry=" + b.entryId.slice(0, 8) + " — " + b.preview;
          bmBox.appendChild(d);
        });

        // 3. Chromium CDP Status
        const cdpBadge = document.getElementById("cdpStatusBadge");
        cdpBadge.textContent = brw.hasLocalChromium
          ? (brw.isCdpActive ? "Chromium CDP Live" : "Chromium Ready")
          : "Virtual DOM Fallback";

        // 4. Workspaces
        const wsBox = document.getElementById("workspacesListBox");
        wsBox.innerHTML = "";
        (wss.workspaces || []).forEach((w) => {
          const row = document.createElement("div");
          row.className = "list-item row";
          row.style.justifyContent = "space-between";
          const span = document.createElement("span");
          span.className = "mono";
          span.textContent = w.path + (w.active ? " [ACTIVE]" : "");
          row.appendChild(span);
          if (!w.active) {
            const b = document.createElement("button");
            b.textContent = "Activate";
            b.addEventListener("click", async () => {
              try {
                await apiJson("./api/workspaces", {
                  method: "POST",
                  body: JSON.stringify({ action: "switch", workspaceRoot: w.path })
                });
                showToast("Switched active workspace to " + w.path);
                await refreshStatus();
                await refreshV2Panels();
                await refreshV3Panels();
              } catch (err) { showToast(err.message, true); }
            });
            row.appendChild(b);
          }
          wsBox.appendChild(row);
        });
      } catch {}
    }

    document.getElementById("btnRunPrPipeline").addEventListener("click", async () => {
      try {
        const title = document.getElementById("prTitleInput").value.trim();
        const issueDescription = document.getElementById("prDescInput").value.trim() || title;
        const testCommand = document.getElementById("prTestCmdInput").value.trim();
        const res = await apiJson("./api/pr-pipeline", {
          method: "POST",
          body: JSON.stringify({ title, issueDescription, testCommand: testCommand || undefined })
        });
        showToast("PR Pipeline finished: " + res.branchName + " [" + res.status + "]");
        await refreshStatus();
        await refreshV3Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnCreateHandoff").addEventListener("click", async () => {
      try {
        const goal = document.getElementById("handoffGoalInput").value.trim();
        if (!goal) return;
        const res = await apiJson("./api/handoff", {
          method: "POST",
          body: JSON.stringify({ goal, switchNow: true })
        });
        document.getElementById("handoffGoalInput").value = "";
        showToast("Handed off & switched to session " + res.childSessionId.slice(0, 8));
        await refreshStatus();
        await refreshV2Panels();
        await refreshV3Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnApplyPreset").addEventListener("click", async () => {
      try {
        const name = document.getElementById("presetSelect").value;
        const res = await apiJson("./api/presets", {
          method: "POST",
          body: JSON.stringify({ action: "apply_preset", name })
        });
        showToast("Preset updated (" + (res.activated || "cleared") + ", 0 prefix drift)");
        await refreshStatus();
        await refreshV3Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnAddBookmark").addEventListener("click", async () => {
      try {
        const label = document.getElementById("bookmarkLabelInput").value.trim();
        const res = await apiJson("./api/presets", {
          method: "POST",
          body: JSON.stringify({ action: "add_bookmark", label })
        });
        document.getElementById("bookmarkLabelInput").value = "";
        showToast("Bookmarked turn as '" + res.label + "'");
        await refreshV3Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnCdpNavigate").addEventListener("click", async () => {
      try {
        const url = document.getElementById("browserUrlInput").value.trim();
        await apiJson("./api/browser", {
          method: "POST",
          body: JSON.stringify({ action: "navigate", backend: "cdp", url })
        });
        const snap = await apiJson("./api/browser", {
          method: "POST",
          body: JSON.stringify({ action: "snapshot", backend: "cdp" })
        });
        document.getElementById("cdpSnapshotBox").textContent =
          "[" + snap.snapshotId + " rev=" + snap.domRevision + "]\\n" + snap.snapshot;
        await refreshV3Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnCdpScreenshot").addEventListener("click", async () => {
      try {
        const shot = await apiJson("./api/browser", {
          method: "POST",
          body: JSON.stringify({ action: "screenshot", backend: "cdp" })
        });
        const img = document.getElementById("cdpScreenshotImg");
        img.src = "data:" + shot.mimeType + ";base64," + shot.data;
        img.style.display = "block";
        showToast("Captured live Chromium CDP PNG screenshot");
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnSwitchWorkspace").addEventListener("click", async () => {
      try {
        const workspaceRoot = document.getElementById("workspaceSwitchInput").value.trim();
        if (!workspaceRoot) return;
        const sw = await apiJson("./api/workspaces", {
          method: "POST",
          body: JSON.stringify({ action: "switch", workspaceRoot })
        });
        document.getElementById("workspaceSwitchInput").value = "";
        showToast("Switched active repo to " + sw.workspaceRoot);
        await refreshStatus();
        await refreshV2Panels();
        await refreshV3Panels();
        await refreshV4Panels();
      } catch (err) { showToast(err.message, true); }
    });

    async function refreshV4Panels() {
      try {
        const [ghi, bch] = await Promise.all([
          apiJson("./api/github-issue"),
          apiJson("./api/bench")
        ]);
        const gBox = document.getElementById("ghIngestionsListBox");
        gBox.innerHTML = "";
        const items = ghi.ingestions || [];
        const conflicts = ghi.conflicts || [];
        if (conflicts.length > 0) {
          const cDiv = document.createElement("div");
          cDiv.className = "list-item";
          cDiv.textContent = "[CONFLICT] " + conflicts.length + " unresolved Git merge conflict block(s) detected";
          gBox.appendChild(cDiv);
        }
        if (items.length === 0 && conflicts.length === 0) {
          gBox.innerHTML = "<div class='muted'>No GitHub issues ingested yet and 0 Git merge conflicts.</div>";
        } else {
          items.slice(0, 8).forEach((it) => {
            const d = document.createElement("div");
            d.className = "list-item";
            d.textContent = it.repo + "#" + it.number + " [scan=" + it.scanVerdict + (it.sanitized ? ", sanitized" : "") + "] — " + it.title;
            gBox.appendChild(d);
          });
        }

        const bBox = document.getElementById("sweBenchHistoryBox");
        bBox.innerHTML = "";
        const runs = bch.benchmarks || [];
        runs.slice(0, 6).forEach((b) => {
          const d = document.createElement("div");
          d.className = "list-item";
          d.textContent = b.benchId + " | baseline=" + b.baselinePassRatePct + "%" +
            (b.evolvedPassRatePct !== undefined ? (" -> evolved=" + b.evolvedPassRatePct + "% (repairsSaved=" + (b.repairAttemptsSaved || 0) + ")") : "") +
            " | cacheHit=" + b.baselineCacheHitPct + "%";
          bBox.appendChild(d);
        });
      } catch {}
    }

    document.getElementById("btnIngestGhIssue").addEventListener("click", async () => {
      try {
        const refOrUrl = document.getElementById("ghIssueRefInput").value.trim();
        const allowQuarantinedIssue = document.getElementById("ghAllowQuarantinedChk").checked;
        if (!refOrUrl) return;
        const res = await apiJson("./api/github-issue", {
          method: "POST",
          body: JSON.stringify({ refOrUrl, allowQuarantinedIssue, runPr: false })
        });
        document.getElementById("ghIssueEnvelopeBox").textContent = res.isolatedPromptEnvelope;
        showToast("Ingested " + res.repo + "#" + res.number + " (scan=" + res.scanVerdict + ")");
        await refreshV4Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnRunAutoPrFromIssue").addEventListener("click", async () => {
      try {
        const refOrUrl = document.getElementById("ghIssueRefInput").value.trim();
        const allowQuarantinedIssue = document.getElementById("ghAllowQuarantinedChk").checked;
        if (!refOrUrl) return;
        const res = await apiJson("./api/github-issue", {
          method: "POST",
          body: JSON.stringify({ refOrUrl, allowQuarantinedIssue, runPr: true, liveLlm: false })
        });
        document.getElementById("ghIssueEnvelopeBox").textContent = res.prReceipt.prMarkdown;
        showToast("Completed Issue-to-PR: " + res.prReceipt.branchName + " [" + res.prReceipt.status + "]");
        await refreshV3Panels();
        await refreshV4Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnRunSweBench").addEventListener("click", async () => {
      try {
        document.getElementById("sweBenchReportBox").textContent = "Running 3-Repo bwrap SWE Benchmark (baseline vs. Harness² EXPERIENCE.md)...";
        const res = await apiJson("./api/bench", {
          method: "POST",
          body: JSON.stringify({ compareExperienceAb: true })
        });
        document.getElementById("sweBenchReportBox").textContent = res.markdownReport;
        showToast("SWE Benchmark complete: evolved pass=" + (res.evolved ? res.evolved.passRatePct : res.baseline.passRatePct) + "%");
        await refreshV4Panels();
      } catch (err) { showToast(err.message, true); }
    });

    async function refreshV5Panels() {
      try {
        const [gwData, swarmData, plugData, ledData] = await Promise.all([
          apiJson("./api/gateway"),
          apiJson("./api/swarm"),
          apiJson("./api/plugins"),
          apiJson("./api/ledger")
        ]);

        document.getElementById("gatewaySendersBadge").textContent =
          gwData.status.allowedSendersCount + " paired";
        const gwLines = gwData.status.platforms.map(
          (p) => p.platform + " [" + (p.configured ? "READY" : "OFF") + "] -> " + p.mode
        );
        document.getElementById("gatewayStatusBox").textContent = gwLines.join("\\n");

        document.getElementById("personasCountBadge").textContent =
          swarmData.personas.length + " personas";
        if (swarmData.recentRuns && swarmData.recentRuns.length > 0) {
          const latest = swarmData.recentRuns[0];
          document.getElementById("swarmOutputBox").textContent =
            "[" + latest.runId + " | " + latest.topology + " | waves=" + latest.wavesExecuted + "]\\n" +
            (latest.winningSummary || "");
        }

        const chainEl = document.getElementById("ledgerChainBadge");
        chainEl.textContent = ledData.integrity.valid
          ? "Chain: Verified (#" + ledData.integrity.totalEntries + " " + ledData.integrity.headHash.slice(0, 8) + ")"
          : "Chain: TAMPERED";
        chainEl.className = "badge " + (ledData.integrity.valid ? "ok" : "danger");

        const ledBox = document.getElementById("ledgerEntriesBox");
        ledBox.innerHTML = "";
        if (!ledData.entries || ledData.entries.length === 0) {
          ledBox.innerHTML = "<div class='muted'>No ledger entries yet.</div>";
        } else {
          ledData.entries.slice(0, 12).forEach((e) => {
            const row = document.createElement("div");
            row.className = "list-item";
            row.innerHTML =
              "<div class='row' style='justify-content:space-between;'>" +
              "<span class='mono'>#" + e.seq + " " + e.entryId + " [" + e.status + " | conf=" + e.confidence + "]</span>" +
              "<span class='mono muted'>" + e.entryHash.slice(0, 10) + "</span></div>" +
              "<div class='muted' style='margin-top:3px;'></div>";
            row.lastChild.textContent = e.cue + " -> " + e.lesson;
            ledBox.appendChild(row);
          });
        }

        document.getElementById("pluginsCountBadge").textContent =
          plugData.plugins.length + " installed";
        const pBox = document.getElementById("pluginsListBox");
        pBox.innerHTML = "";
        if (!plugData.plugins || plugData.plugins.length === 0) {
          pBox.innerHTML = "<div class='muted'>No external plugins installed yet (active schema stays strictly 1,073 o200k tokens).</div>";
        } else {
          plugData.plugins.forEach((p) => {
            const d = document.createElement("div");
            d.className = "list-item";
            const status=p.restoreState==="stored-not-loaded"?"STORED · NOT LOADED":p.restoreState==="changed-on-disk"?"CHANGED · BLOCKED":p.restoreState==="audit-blocked"?"AUDIT BLOCKED":p.enabled?"ENABLED":"DISABLED";
            const summary=document.createElement("div");summary.textContent=p.id+"@"+p.version+" ["+status+" | scan="+p.scanVerdict+"] tools="+(p.tools.map(t=>t.qualifiedName).join(", ")||"none");d.appendChild(summary);
            const desc=document.createElement("div");desc.className="muted";desc.textContent=p.description+" · "+p.installedPath;d.appendChild(desc);
            const controls=document.createElement("div");controls.className="row";controls.style.marginTop="6px";
            if(p.restoreState!=="changed-on-disk"&&p.restoreState!=="audit-blocked"){
              const toggle=document.createElement("button");toggle.textContent=p.enabled?"Disable":"Enable & re-audit";toggle.addEventListener("click",async()=>{try{await apiJson("./api/plugins",{method:"POST",body:JSON.stringify({action:p.enabled?"disable":"enable",pluginId:p.id})});await refreshV5Panels();}catch(err){showToast(err.message,true);}});controls.appendChild(toggle);
            }
            const remove=document.createElement("button");remove.className="danger";remove.textContent="Remove";remove.addEventListener("click",async()=>{if(!confirm("Remove stored plugin '"+p.id+"' and its installed files?"))return;try{await apiJson("./api/plugins",{method:"POST",body:JSON.stringify({action:"remove",pluginId:p.id})});await refreshV5Panels();}catch(err){showToast(err.message,true);}});controls.appendChild(remove);d.appendChild(controls);
            pBox.appendChild(d);
          });
        }
      } catch {}
    }

    document.getElementById("btnIssuePairCode").addEventListener("click", async () => {
      try {
        const platform = document.getElementById("gwPlatformSelect").value;
        const tok = await apiJson("./api/gateway", {
          method: "POST",
          body: JSON.stringify({ action: "issue_pair", platform })
        });
        document.getElementById("gatewayStatusBox").textContent =
          "Issued 1-time pairing code for " + tok.platform + ": /pair " + tok.code + " (valid 10m)";
        showToast("Pairing code for " + tok.platform + ": " + tok.code);
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnInitBaileys").addEventListener("click", async () => {
      try {
        const st = await apiJson("./api/gateway", {
          method: "POST",
          body: JSON.stringify({ action: "pair_whatsapp_baileys" })
        });
        document.getElementById("gatewayStatusBox").textContent =
          "WhatsApp Personal Baileys Link Code: " + st.eightCharLinkCode + "\\nQR URI: " + st.qrPayload;
        showToast("WhatsApp link code: " + st.eightCharLinkCode);
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnRunDebateSwarm").addEventListener("click", async () => {
      try {
        const goal = document.getElementById("swarmGoalInput").value.trim() || "Design zero-downtime key rotation";
        document.getElementById("swarmOutputBox").textContent = "Running Multi-Persona Debate...";
        const run = await apiJson("./api/swarm", {
          method: "POST",
          body: JSON.stringify({ topology: "debate", goal })
        });
        document.getElementById("swarmOutputBox").textContent =
          "[" + run.runId + " | debate | waves=" + run.wavesExecuted + "]\\n" + (run.winningSummary || "");
        showToast("Debate complete (" + run.runId + ")");
        await refreshV5Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnRunSupervisorSwarm").addEventListener("click", async () => {
      try {
        const goal = document.getElementById("swarmGoalInput").value.trim() || "Audit workspace security posture";
        document.getElementById("swarmOutputBox").textContent = "Running Supervisor-Reviewer orchestration...";
        const run = await apiJson("./api/swarm", {
          method: "POST",
          body: JSON.stringify({ topology: "supervisor", goal })
        });
        document.getElementById("swarmOutputBox").textContent =
          "[" + run.runId + " | supervisor | waves=" + run.wavesExecuted + "]\\n" + (run.winningSummary || "");
        showToast("Supervisor run complete (" + run.runId + ")");
        await refreshV5Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnRecordLedgerLesson").addEventListener("click", async () => {
      try {
        const cue = document.getElementById("ledgerCueInput").value.trim();
        const lesson = document.getElementById("ledgerLessonInput").value.trim();
        const entry = await apiJson("./api/ledger", {
          method: "POST",
          body: JSON.stringify({ action: "record", cue, lesson })
        });
        document.getElementById("ledgerCueInput").value = "";
        document.getElementById("ledgerLessonInput").value = "";
        showToast("Recorded #" + entry.seq + " (" + entry.entryId + ")");
        await refreshV5Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnVerifyLedgerChain").addEventListener("click", async () => {
      try {
        const rep = await apiJson("./api/ledger", {
          method: "POST",
          body: JSON.stringify({ action: "verify" })
        });
        showToast(rep.valid ? "SHA-256 Chain VERIFIED (" + rep.totalEntries + " entries)" : ("TAMPER: " + rep.reason), !rep.valid);
        await refreshV5Panels();
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnMaterializeLedger").addEventListener("click", async () => {
      try {
        const mat = await apiJson("./api/ledger", {
          method: "POST",
          body: JSON.stringify({ action: "materialize" })
        });
        showToast("Materialized " + mat.experienceCount + " cues (" + mat.experienceTokens + "/220 o200k tokens) for next boot");
      } catch (err) { showToast(err.message, true); }
    });

    document.getElementById("btnInstallPlugin").addEventListener("click", async () => {
      try {
        const sourceDir = document.getElementById("pluginSourceDirInput").value.trim();
        const p = await apiJson("./api/plugins", {
          method: "POST",
          body: JSON.stringify({ action: "install", sourceDir })
        });
        showToast("Installed plugin " + p.id + "@" + p.version + " (+0 active schema tokens)");
        await refreshV5Panels();
      } catch (err) { showToast(err.message, true); }
    });

    // Live SSE connection (strictly relative URL './api/events')
    const sse = new EventSource("./api/events");
    const sseLog = document.getElementById("sseLog");
    const liveStreamBox = document.getElementById("liveStreamBox");
    sse.onopen = () => {
      document.getElementById("sseDot").style.background = "#22c55e";
    };
    sse.onerror = () => {
      document.getElementById("sseDot").style.background = "#f59e0b";
    };
    sse.onmessage = (ev) => {
      const line = "[" + new Date().toISOString().slice(11, 19) + "] " + ev.data;
      sseLog.textContent = (line + "\\n" + sseLog.textContent).slice(0, 8000);
      try {
        const parsed = JSON.parse(ev.data);
        if(parsed.type==="ephemeral_provider_session_started"){document.getElementById("btnEndEphemeralOpenRouter").disabled=false;document.getElementById("ephemeralOpenRouterStatus").textContent="Active · "+parsed.modelId+" selected · up to 3 chat turns / 5 minutes · key is memory-only.";}
        if(parsed.type==="ephemeral_provider_session_ended"){document.getElementById("btnEndEphemeralOpenRouter").disabled=true;document.getElementById("ephemeralOpenRouterStatus").textContent="Temporary provider ended; credential removed from runtime memory.";}
        if (parsed.type === "message_update" && parsed.assistantMessageEvent && parsed.assistantMessageEvent.delta) {
          liveStreamBox.style.display = "block";
          liveStreamBox.textContent += parsed.assistantMessageEvent.delta;
        }
        if (parsed.type === "agent_end" || parsed.type === "cockpit_refresh" || parsed.type === "turn_end") {
          if (parsed.type === "agent_end") {
            liveStreamBox.style.display = "none";
            liveStreamBox.textContent = "";
          }
          refreshStatus();
          refreshV2Panels();
          refreshSkillLibrary();
          refreshV3Panels();
          refreshV4Panels();
          refreshV5Panels();
        }
      } catch {}
    };

    document.getElementById("btnRefreshSettings").addEventListener("click",()=>{loadSpeechStatus();refreshInteractionState();});
    document.getElementById("btnOpenQuickSetup").addEventListener("click",openSetup);
    refreshStatus();
    refreshV2Panels();
    refreshSkillLibrary();
    refreshV3Panels();
    refreshV4Panels();
    refreshV5Panels();
    loadSpeechStatus();
    refreshInteractionState();
  </script>
</body>
</html>`;
  if (!_validatedInlineScript) {
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    if (match && match[1]) {
      // Fail-fast syntax guard: catches any unescaped newline or JS syntax error immediately.
      new Function(match[1]);
    }
    _validatedInlineScript = true;
  }
  return html;
}
