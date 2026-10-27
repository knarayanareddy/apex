# Pi-Apex Mission Control UX Overhaul — Spec first

**Status:** Implemented and verified against the acceptance criteria below.  
**Approval:** User requested implementation (“Proceed with your recommendations with tasteful implementation and extensive testing across each phase”).  
**Scope:** Information architecture, progressive disclosure, task-centered navigation and visual density in Mission Control. Preserve runtime behavior and all existing controls/capabilities. No orchestration semantics or API changes in this UX pass.

## Product outcome

A first-time user can begin a task from the default screen without first learning Pi-Apex internals. Advanced controls, role catalogs, security controls, history and diagnostics remain reachable, but are grouped and revealed when relevant. The Warm Editorial visual direction remains in force and is not considered final until reviewed by the user.

## Functional requirements

### IA / navigation
- Replace current four category headings and flat ten-item nav with exactly three expandable groups: **Work**, **Library**, **Settings**.
- Work (expanded initially): Chat & changes, Plans & review, Build & browser, Issues & IDE, History & rewind.
- Library (collapsed): Agents & channels, Models & tools, Skills library.
- Settings (collapsed): Settings & safety, Memory & console.
- Keep the original panel IDs and data bindings so all functionality remains intact.
- Use semantic `<details>/<summary>` and preserve keyboard access; active tab must remain visibly highlighted.
- Make nav labels user/task-oriented; retain technical capability names in panel detail.

### Header and “attention” affordance
- Reduce the always-visible toolbar to a dynamic **Needs your attention** button, command palette, and **New task** (retains existing new-session action).
- Put Quick setup, Health check, and appearance/theme inside Settings, not the global toolbar.
- The attention button displays the pending approval count, is hidden/quiet when zero, and opens the existing review surface / pending approval flow when clicked. Do not create a new approval mechanism.
- Retain existing status badges and all server/API diagnostics behavior.

### Task composer progressive disclosure
- Keep message, attachments, speech and send/stop/steer controls readily available.
- Collapse model, reasoning, persona, build profile, and execution mode under a closed-by-default “Task setup” disclosure, with a concise summary of effective selections always visible.
- Retain all existing IDs, event handlers, and interactions for selectors.
- Rename Turbo’s UI text to **Turbo (fewer approval prompts)**; explain that Turbo skips confirmations only and does not weaken sandbox or hard guardrails. Never imply zero safety checks.
- Keep Plan mode task-local beside the composer. Keep exactly the existing approval matrix and expiration/confirmation behavior.

### Work/review organization
- Keep approval/artifact review in the existing Plans & review view, but separate conceptually from task configuration.
- Make the attention shortcut bring the user to the current review state.
- Do not change modal approval semantics, tool scope, approval expiry, or refusal behavior.

### Library and Settings
- Group agents/channels, providers/models/tools, and skills in Library. Keep all pages and controls reachable.
- Keep provider setup, speech settings, appearance/theme, safety explanation, and health check in Settings. No new credentials flow, provider claims, or persistence.
- Memory/console remains reachable as an advanced system feature under Settings.
- Preserve explicit in-process plugin trust disclosure and all existing local-security boundaries.

### Visual quality / accessibility
- Keep Warm Editorial colors, typography and low-chrome surfaces.
- Ensure focus-visible affordances, semantic nav controls, `aria-expanded`-equivalent native details state, and named attention control.
- Responsive design: collapsible groups and composer options remain usable at narrow widths without horizontal overflow caused by fixed navigation.
- Reduced-motion preference continues to be respected.

## Non-functional constraints
- No CDN, external styles/scripts/fonts or network dependency in UI.
- No browser-side localhost/127.0.0.1 API calls; use existing relative URLs.
- Preserve every existing DOM ID used by JavaScript, tests, and API-backed flows.
- Preserve session/model/provider/safety semantics and all hard guardrails.
- Do not implement automatic agent spawning or an agent board in this pass.

## Phases and per-phase verification

1. **Spec/baseline:** capture current state; map all current nav pages, header actions, composer controls. Baseline typecheck + Ring 5/11 UI suites.
2. **Navigation/header:** three semantic disclosure groups; reduce toolbar; move setup/appearance/health to Settings; attention button. Verify all original views remain routable, every target ID exists exactly once, nested navigation and responsive DOM structure.
3. **Composer:** Task setup details collapsed initially, summary visible, selector IDs unchanged, Plan mode in context, Turbo copy safety-aligned. Verify actual Chromium toggling, selector updates, prompt send and guardrail regression tests.
4. **Library/Settings copy and grouping:** update cross-references/labels; verify existing skills/provider/agent/settings APIs and lifecycle tests untouched/passing.
5. **Polish/accessibility:** keyboard focus, reduced motion, narrow-width CSS; run full `npm test` (including Tier, Rings 1–12) and Mission Control Chromium e2e. Inspect served HTML and restart live preview.

## Acceptance criteria
- Three expandable primary navigation groups and no more than three persistent groups.
- Default view opens Chat & changes, with Library/Settings closed and Task setup closed.
- New task, command palette, quick setup, health check, theme toggle, Plan mode and all original tabs remain functional.
- Every pending approval can still be opened and resolved through the existing modal; attention count reflects live/polled interaction state and is zero when none are pending.
- User sees contextual model/persona/profile/mode summary without all settings expanded.
- Turbo label/help text clearly state “fewer approval prompts / confirmations only”; sandbox and hard guardrails remain unchanged.
- No runtime/API behavior or capability removed, no secret leakage, no external assets, no localhost calls.
- Full test suite and targeted Chromium/UI tests pass; any failure is investigated at root rather than retried blindly.

## Implementation and test record

- **Phase 0 — spec/baseline:** Spec written before code changes. Typecheck and Ring 5 baseline passed. Ring 11's baseline reached the Chromium gate but the environment initially had no browser; Chromium and its runtime dependencies were installed for the UI checks.
- **Phase 1 — navigation/header:** 3 semantic disclosure groups; Work open by default, Library/Settings closed; 3 global actions; status badges tucked under Status; Quick setup/theme/health moved to Settings; pending-approval attention shortcut added. Verified by Ring 5 and real Chromium Ring 11 tests.
- **Phase 2 — composer:** model/reasoning/persona/build profile/mode collapsed under Task setup; Plan mode kept next to the task; Turbo copy corrected; image action kept one-click while voice/audio tools and full diff are collapsed. Existing IDs and API behavior retained. Verified in Chromium, including selector updates, multiple streamed turns, image/audio flows, and Turbo's hard-deny regression.
- **Phase 3 — Library/Settings:** All existing views/actions remain reachable through the three groups. Settings cross-reference updated; skills, provider, agent, and safety logic unchanged. Ring 5, Ring 6, Ring 9, Ring 11, and Ring 12 passed. Ring 6's presentation assertions were updated for the intentionally renamed Conversation/Workspace changes headings.
- **Phase 4 — polish/accessibility:** focus-visible outlines, native details/summary disclosure, dark theme support for new surfaces, responsive work layout, and narrow viewport checks. Chromium verified no page-level horizontal overflow at 390px, intentional horizontal nav scrolling, theme action, setup/health actions, status count, opening/denying the existing approval modal, and closed/open disclosures.
- **Final verification:** `npm test` passed end-to-end: native build, typecheck, Tier A/B, Rings 1–12, including headless Chromium UI gates. First full-suite attempts surfaced environment/setup gaps (missing `node_modules`, Chromium, `libnspr4`, `bubblewrap`) and one stale Ring 6 text assertion; those were root-caused, resolved, and the final complete run passed. `bubblewrap` was available during the final run.
- **Live preview:** Mission Control runs on port 4310 from the updated sources; process ID `pi-apex-mission-control-a3e484a1`. Visual review image: `research/mission-control-ux-preview.png`. HTML review capture: `mission-control-review.html`.
