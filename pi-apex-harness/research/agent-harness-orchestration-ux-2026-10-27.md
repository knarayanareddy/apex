# Agent orchestration and calm UX — research & Pi-Apex IA proposal

**Research date:** 27 October 2026  
**Scope:** OpenMuse, OpenDots, OpenAI Dots, Meta Muse, Claude Cowork, OpenCode, Hermes Agent, OpenAI Codex, and Google Antigravity. This is product/repository research plus a spec direction—not an implementation or a claim that Pi-Apex's visual redesign is approved.

## Executive take

Pi-Apex currently exposes **12 top-level navigation destinations** across four groups, plus six persistent toolbar actions (Theme, command palette, Quick setup, Plan mode, Health check, New session). Those controls mix task destinations, configuration catalogs, safety state, and diagnostics. This makes the interface read like a cockpit before the user has started a task.

The strongest shared pattern across the references is not “hide capability”; it is **one calm task surface, with capability-specific detail appearing when relevant**:

1. Start from one primary task/chat entry point.
2. Let the agent decide whether to delegate; represent delegation as a compact task/activity detail, not another permanent workspace users must learn.
3. Let users inspect plans, approvals, diffs, browser state, and outputs at useful milestones.
4. Put reusable building blocks (roles, skills, tools, connectors, models) in a small number of clear libraries.
5. Keep safety boundaries explicit, scoped, and persistent; approval shortcuts must never turn off hard guardrails.

**Recommendation for Pi-Apex:** consolidate navigation into **Work, Library, and Settings**, with a persistent **Needs your attention** indicator. Keep the composer the primary control surface. Treat all deeper controls as context panels or nested pages. Preserve the selected Warm Editorial visual direction, but do not call the redesign final until the user reviews it.

---

## What the references actually are

| Name | Open-source status / product boundary | Useful evidence and caution |
|---|---|---|
| **OpenMuse** (`CopilotKit/OpenMuse`) | MIT-licensed, open-source personal-agent app/template; alpha and explicitly for self-hosting/building on. | Real README describes a chat-first personal agent with a persistent browser, optional isolated Linux workspace, a durable Activity surface, plans, approvals, and delegated tasks. Not a general-purpose multi-agent team manager: its “task worker” and “browser worker” are runtime workers, while user-facing delegation is chiefly durable task execution. The README and feature inventory explicitly separate implemented behavior from planned work and unverified live-provider integration. |
| **OpenDots** (`CopilotKit/OpenDots`) | MIT-licensed, open-source template; alpha; requires configured CopilotKit Intelligence / conversation infrastructure. It is not a hosted CopilotKit product. | The model is multiple **independent, persistent specialist Dots**, each configured with identity/role/instructions/tools, permissions, and optionally its own computer. A person selects a Dot and can continue its conversation in a Space/page, call, or Slack. The documented flow is not primarily an autonomous parent spawning children. MCP tools can be read-only or approval-gated; review cards pause writes until approved. |
| **OpenAI Dots** | Proprietary ChatGPT product; no public Dots implementation repo identified. OpenAI describes a primary Dot now and future teams/specialist Dots; treat private architecture claims as product statements, not inspectable code. | Product reference for a unified conversational entry, background work, app access, user-set action rules, Activity View, and approvals. OpenAI says proactive research uses read-only tools; custom rules allow/require/block; some actions remain user-only. |
| **Meta Muse** | Proprietary personal-agent product; no public Muse implementation repository identified. | Product reference: conversational task requests, long-running work, per-app access and approvals, audit trail, editable memory, and a separate Sentinel component that gates internet access. Sentinel is Meta's description of its own system; we cannot inspect or independently verify the private implementation. |
| **Claude Cowork** | Proprietary Anthropic product, not an official open-source “Cowork harness.” `yaniv-golan/cowork-harness` is an independent, unofficial runtime-contract emulator—not Anthropic's code. | First-party help describes a shared Chat/Cowork home, plan then execute, parallel subagents, progress/steering, file/tool boundaries, and permission modes. Current docs distinguish Manual, Auto, and Skip. Skip removes action review, so Pi-Apex should not copy that safety tradeoff. Cowork capabilities and availability change over time; refer to the live first-party docs. |
| **OpenCode** (`anomalyco/opencode`) | Open-source repo, MIT. The hosted/product service may have different boundaries; this row refers to the repo and its open-source clients. | Official docs make two primary modes legible: Build (full development) and Plan (restricted/read-mostly). Specialized subagents are auto-routable or manually invoked via `@`; permissions resolve to allow/ask/deny. Good precedent for a tiny mode set and role-specific capabilities. |
| **Hermes Agent** (`NousResearch/hermes-agent`) | Open-source repo, MIT; also ships a desktop product built on the same agent. | Docs distinguish short-lived `delegate_task` (isolated child context, summary returned) from durable Kanban tasks (persistent, inspectable, handoffs, human input). That distinction is technically useful but is too much to surface as competing top-level modes in Pi-Apex initially. Desktop keeps chat central and puts live tool activity/previews/files in a side pane. |
| **OpenAI Codex** (`openai/codex`) | Public source repository under Apache-2.0 for the Codex CLI/client; distinct from proprietary ChatGPT Work and hosted Codex services, which are not thereby open source. | First-party docs describe subagents as parallel task threads whose status/work can be inspected and whose summaries return to the main thread. They explicitly warn that agents consume additional tokens and advise read-heavy parallelism before concurrent writing. |
| **Google Antigravity** | Proprietary app/agent harness; no official open-source implementation repo identified. | Official docs describe Editor plus Agent Manager, parallel conversations/subagents, task-oriented artifacts (plans, diffs, screenshots, recordings), and review/feedback at milestones. Good precedent for artifact-centered oversight, not for copying its full surface. |

### Status discipline

A public product announcement is evidence of what its vendor says is available or intended; it is not evidence of a private architecture. Open-source README feature tables may mix implemented, alpha, configured, and planned capabilities. OpenMuse explicitly cautions about this distinction; OpenDots also labels itself a template/alpha and requires external conversation services. The findings below distinguish documented implementation from vendor product descriptions.

---

## Orchestration patterns: setup and user workflow

### 1) OpenMuse — one personal agent, durable work behind a conversational front

The repository describes a server plus task worker and browser worker. The core pattern is: ask for an outcome in chat → see plan/progress and task state in Activity → supply missing inputs or approve a consequential action → inspect the result/receipt. Browser and optional Linux computer are separate execution capabilities; the user can inspect/take over the browser or inspect terminal/files. Durable task records, leases, pause/resume/cancel/retry, and receipts matter more to the visible workflow than exposing worker topology.

**Pi-Apex lesson:** represent “agent delegated to a worker” as a single task with a status, next checkpoint, and outcome. Do not make users understand worker processes unless debugging. Provide a clean path from task to artifact or approval. Avoid describing the alpha's computer as a full VM or the future capabilities as shipped.

### 2) OpenDots — stable role identity, scoped access, human review in context

OpenDots separates specialist Dots from Spaces/documents. Each Dot has a name, role, instructions, and permitted tools; optional computers are per-Dot and persist state. A user can grant a Dot access to Spaces and connect MCP tools per Dot. A generated document is shown for review; only “Approve & save” persists it. Non-read-only MCP actions can pause on “Approve & run.” Each action is associated with the exact saved tool/arguments and permission state, not a general “trust this agent” switch.

**Pi-Apex lesson:** agents are a reusable roster/catalog (role + scope + tools + safety), while one task may use one or more of them invisibly or explicitly. Put “who can do what” in agent detail; show the selected agent/mode in the composer only when it changes the task. Present approval beside the exact action and intended result.

### 3) OpenAI Dots and Meta Muse — task request, asynchronous progress, bounded autonomy

OpenAI Dots' product story begins with one primary Dot, not a team topology. The interface promises activity visibility, redirectable background work, rules for allowed/approval-required/blocked actions, and later specialist Dots. Meta Muse describes conversational requests and plans, ongoing work, an audit trail, sensitive-action approval, app-by-app grants, and a separate Sentinel boundary. Both point to the value of dependable permissions and reviewable progress without requiring users to author a graph of agents.

**Pi-Apex lesson:** show a human-readable task title, current state, next intervention, and recent output. Do not surface agent internals or entire tool traces by default. Keep read, write, send, delete, and purchase permissions distinct; approvals should be tied to action/scope, not a vague “safe mode.”

### 4) Claude Cowork — one home, modes near the composer, intervention during work

First-party help describes Chat and Cowork moving toward a shared home, with the same task entry point. The user can review an approach, see progress, steer mid-run, and let complex work use parallel subagents. Permission modes sit near the task composer rather than requiring users to visit an admin page for every run. The product documents Manual and Auto review modes; “Skip” is materially less safe and is not a model for Pi-Apex Turbo.

**Pi-Apex lesson:** the user should be able to start naturally and find relevant controls in the composer/context menu. Offer concise, task-level autonomy choices; do not turn global settings into the main task workflow.

### 5) OpenCode — keep top-level agent modes few; capabilities differ by role

OpenCode's primary Build/Plan distinction is simple, and roles can have distinct model/tool/permission policies. Subagents are available through automatic routing or an explicit `@role` mention. The user can inspect child sessions. Its permission model is explicit allow/ask/deny, including agent-specific overrides.

**Pi-Apex lesson:** preserve the small set of user-meaningful modes (e.g., Work / Plan) and make role-specific tool scopes visible on demand. Avoid exposing implementation-oriented agent taxonomies as primary navigation.

### 6) Hermes — separate quick delegation from durable task orchestration

Hermes docs make a useful engineering distinction: a delegated child is a fork-and-return helper with isolated context and no durability across process restarts; its Kanban is a durable shared work queue with named profiles, task state, comments, handoffs, and human unblock/review. The breadth demonstrates why the product needs progressive disclosure: this is valuable for power workflows but can become an entire “control plane.”

**Pi-Apex lesson:** start with lightweight delegation and one user-facing task record. Only add durable board/queue UI if recurring, cross-session multi-role work is a proven use case. If added, make it a focused “Tasks” view with filters, not another set of top-level agent-management tabs.

### 7) Codex and Antigravity — inspect agent threads or artifacts, not every internal event

Codex exposes agent threads/status and returns distilled summaries to a main conversation, avoiding raw child logs in the main flow. Its docs call out context pollution and recommend parallel work when tasks are independent, especially read-heavy work. Antigravity elevates plans, diffs, screenshots, and browser recordings as artifacts; its artifact review flow lets the user give feedback at milestones without watching each tool call.

**Pi-Apex lesson:** provide a compact “Working” view and expandable agent/activity detail, plus a dedicated artifact/review panel. Default to summaries; make raw logs available for diagnosis.

---

## Pi-Apex diagnosis from the current UI

The current source navigation contains these 12 destinations:

- Chat & changes
- Plans & approvals
- Build & browser
- Issues & IDE
- History & rewind
- Agents & channels
- Models & tools
- Settings & safety
- Skills & quarantine
- Memory & console

It also labels the four groups “Workspace,” “Autonomy & PRs,” “Swarm & channels,” and “Trust & memory,” while the toolbar persistently exposes Theme, ⌘K, Quick setup, Plan mode, Health check, and New session. This is feature-rich, but combines at the same level:

- places to do work (chat, build, IDE, browser),
- review states (plans, approvals, history),
- reusable catalogs (agents, models, skills, tools, channels), and
- system administration (safety, memory, diagnostics).

The issue is structural, not just styling: the user must choose among implementation concepts before knowing what task they want to do. Multiple controls also describe adjacent concepts (plan mode vs plans; build/browser vs issues/IDE; agents/channels vs models/tools; skills/quarantine vs memory/console).

---

## Proposed information architecture (for spec review)

### Persistent navigation: three groups

**1. Work** — default landing surface
- **Start / Chat:** one primary composer and current workspace/session context.
- **Tasks:** running, queued, waiting-for-you, completed. A “Needs your attention” count is visible globally; approvals/input requests are task states, not a separate permanent destination.
- **History:** sessions and rewind/recovery, nested beneath Work rather than alongside the task entry point.
- **Artifacts:** plans, diffs, files, browser receipts, generated documents. Open these from the originating task; optionally provide a single “Artifacts” list as a secondary view.

**2. Library** — reusable capabilities
- **Agents:** role cards with purpose, tools, model route, permission scope, and enabled status. Specialist agents are selectable from the composer/mention menu; orchestration details are inspectable from a task.
- **Skills:** discover, inspect, import, promote/archive/quarantine. Keep destructive lifecycle actions behind the skill detail/review flow.
- **Tools & connections:** combine MCP, plugins, channels, integrations into one catalog, with clear “connected / enabled / trusted / loaded” states. Do not visually imply that a security scan makes in-process plugins sandboxed.

**3. Settings** — system-level configuration
- **Models & providers**
- **Permissions & safety** (global hard rules; task-level approvals remain in Work)
- **Memory & context**
- **Diagnostics / health** (advanced)
- **Appearance / keyboard / onboarding**

Keep advanced/configuration sections searchable and collapsible. Do not put them in the normal task path.

### Composer and task surface

- Main surface starts with a plain-language task box, attachment affordance, and optional mode selector.
- Default mode: **Work**. Optional **Plan** is a lightweight composer-level choice; it means “prepare and review a plan before changing files,” not a second global workspace.
- Show chosen model/agent only as a small contextual chip/dropdown, not as a permanent multi-control toolbar.
- Expose **Turbo** as “fewer approval interruptions” only. It may not disable hard guardrails, sandbox limits, blocked actions, or irreversible-action requirements.
- During execution, present one status line: “Researching · 2 helpers running” or “Waiting for approval · send email?” with an expandable activity detail.
- For delegation, show names/roles, task summaries, status, and final synthesis. Keep child transcripts/tool logs collapsed by default.
- Surface artifact cards and decision cards inline with the task. High-impact actions get explicit target, change, and consequence, plus approve/deny; never bury the action in raw tool output.
- Maintain a small persistent status/attention indicator. Health check and setup belong in contextual states (first run, unhealthy system), not permanent top-level buttons after successful setup.

### Progressive disclosure rules

1. **Default:** task, response, progress headline, pending decision, result.
2. **One click:** plan, artifacts, delegated roles, concise activity timeline, approval details.
3. **Advanced:** raw tool arguments/output, logs, model routing, per-tool permission rules, environment/system details.
4. **Dangerous/destructive:** reason, target, scope, recovery path, explicit confirmation; no Turbo bypass.

### Visual direction guardrail

Use the already-selected **Warm Editorial** direction to reduce density: calmer spacing, restrained visual weight, one dominant composer/task, quiet metadata, and warm neutral surfaces. Avoid using color or heavy chrome to solve the information architecture problem. The existing visual direction is a chosen direction—not yet a reviewed final design.

---

## Suggested implementation sequencing (after spec approval)

**Phase 0 — spec and acceptance:** confirm the IA, labels, safety rules, and responsive/keyboard behavior. Inventory every existing control/action so consolidation does not remove a capability.

**Phase 1 — navigation and grouping:** reorganize existing screens into Work / Library / Settings; keep routes/actions intact; add “Needs your attention” task state and improve naming. No runtime/orchestration semantics change.

**Phase 2 — task-centered execution:** make chat/task the primary surface; move plans/approvals and history to contextual views; fold build/browser/IDE into task artifacts/context panels; simplify toolbar.

**Phase 3 — library consolidation:** create coherent Agents, Skills, and Tools & Connections indexes, retaining their existing security and lifecycle behavior.

**Phase 4 — progressive disclosure and polish:** collapse low-level logs/config, make task details keyboard accessible, test first-run and dense states, and tune Warm Editorial visual design after review.

### Acceptance criteria to write before implementation

- A new user can start a task without understanding Rings, swarm terminology, MCP, or agent topology.
- No existing implemented capability disappears; every current action is reachable from the new IA.
- Default view has one obvious primary action and no more than three persistent navigation groups.
- Users can find all pending approvals/input requests from one visible attention entry point.
- Every delegated task shows a clear owner/role, status, next step, and result; raw child logs remain optional.
- Exact action scope and consequences are available before approval; only the relevant action is approved.
- Turbo cannot weaken hard safety rules or bypass explicit irreversible-action checks.
- Settings/catalog changes are distinguishable from per-task behavior; no UI implies unsupported sandboxing.
- Keyboard navigation, mobile/narrow window, empty/error/loading states, and accessibility labels are covered.

---

## Source register (first-party / upstream)

### Open source repositories and docs
- [OpenMuse GitHub repository](https://github.com/CopilotKit/OpenMuse) · [README](https://raw.githubusercontent.com/CopilotKit/openmuse/main/README.md) · [feature inventory](https://raw.githubusercontent.com/CopilotKit/openmuse/main/docs/FEATURES.md) · [verification/limits](https://raw.githubusercontent.com/CopilotKit/openmuse/main/docs/VERIFICATION.md)
- [OpenDots GitHub repository](https://github.com/CopilotKit/OpenDots) · [README](https://raw.githubusercontent.com/CopilotKit/OpenDots/main/README.md) · [connections and approvals](https://raw.githubusercontent.com/CopilotKit/OpenDots/main/docs/CONNECTIONS.md) · [computer model and limits](https://raw.githubusercontent.com/CopilotKit/OpenDots/main/docs/COMPUTERS.md)
- [OpenCode repository](https://github.com/anomalyco/opencode) · [Agents docs](https://opencode.ai/docs/agents/) · [Permissions docs](https://opencode.ai/docs/permissions/)
- [Hermes Agent repository](https://github.com/NousResearch/hermes-agent) · [delegation patterns](https://hermes-agent.nousresearch.com/docs/guides/delegation-patterns/) · [Kanban vs delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/kanban/) · [Hermes Desktop README](https://github.com/NousResearch/hermes-agent/blob/main/apps/desktop/README.md)
- [OpenAI Codex repository](https://github.com/openai/codex) · [Subagents docs](https://learn.chatgpt.com/docs/agent-configuration/subagents)

### Proprietary product references / first-party material
- [OpenAI: Introducing Dots](https://openai.com/index/introducing-dots/)
- [Meta: Introducing Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- [Claude Cowork: official help guide](https://support.claude.com/en/articles/13345190-get-started-with-claude-cowork)
- [Google Antigravity agent overview](https://antigravity.google/docs/agent/) · [subagents](https://antigravity.google/docs/subagents/) · [artifacts](https://antigravity.google/docs/artifacts/)

---

## Bottom line

Do not make Pi-Apex less capable. Make the **default surface smaller** and the deeper capability **findable when the task calls for it**. The best synthesis is OpenMuse's task/activity lifecycle, OpenDots' role-and-permission boundaries, OpenCode's small mode set, Codex/Antigravity's inspectable delegated work and review artifacts, and the product agents' conversational entry plus background continuity. Keep advanced operations available—but behind a coherent Library/Settings structure and progressive disclosure.
