import assert from "node:assert/strict";
import { inferTaskMode, isTaskMode, frameTaskPrompt, routeTaskModePrompt } from "../../src/ring5/task-mode-routing.ts";
import { renderMissionControlHtml } from "../../src/ring5/mission-control-ui.ts";

let checks = 0;
function check(name: string, fn: () => void) { fn(); checks++; console.log(`  ✓ ${name}`); }

console.log("Ring 14 — Task-aware chat modes and model routing");
check("local heuristic prioritizes scheduled intent and returns an observable reason", () => {
  const result = inferTaskMode("Please build a report and send it every Friday at 9am");
  assert.equal(result.mode, "schedule"); assert.equal(result.confidence, "medium");
  assert.match(result.reason, /recurring or timed run/i);
  assert.equal(inferTaskMode("Run this in 5 minutes").mode, "schedule");
});
check("browser, teamwork, plan and goal cues route to the intended task modes", () => {
  assert.equal(inferTaskMode("Find the latest official guidance online").mode, "browser");
  assert.equal(inferTaskMode("Use a multi-agent team for this review").mode, "teamwork");
  assert.equal(inferTaskMode("Draft an architecture plan before coding").mode, "plan");
  assert.equal(inferTaskMode("Implement the feature and verify it").mode, "goal");
});
check("ambiguous input conservatively defaults to quick answer without a route change", () => {
  const result = inferTaskMode("What does this function do?");
  assert.equal(result.mode, "quick"); assert.equal(result.confidence, "low");
});
check("workflow suggestions are independent of model selection", () => {
  const result = inferTaskMode("Design and implement a secure end-to-end migration with comprehensive tests.");
  assert.equal(result.mode, "goal"); assert.equal("modelReason" in result, false);
});
check("mode validation rejects unknown client-supplied IDs", () => {
  for (const mode of ["quick", "goal", "plan", "browser", "teamwork", "schedule"]) assert.equal(isTaskMode(mode), true);
  for (const mode of ["automatic", "admin", "turbo", null, 7]) assert.equal(isTaskMode(mode), false);
});
check("selected prompt framing preserves explicit guardrail and schedule confirmation language", () => {
  assert.match(frameTaskPrompt("Make a weekly report", "schedule"), /ask the user to confirm/i);
  assert.match(frameTaskPrompt("Finish the task", "goal"), /Do not create unattended or background work/i);
  assert.match(frameTaskPrompt("Research this", "browser"), /approval/i);
});
check("selected modes map to existing safe workflows without routing automatic prompts", () => {
  const automatic = routeTaskModePrompt("ordinary user text", "automatic");
  assert.deepEqual(automatic, { prompt: "ordinary user text", dispatch: "prompt", enablePlanMode: false });
  const plan = routeTaskModePrompt("Design a release", "plan");
  assert.equal(plan.enablePlanMode, true); assert.match(plan.prompt, /read-only Plan Mode/i);
  const team = routeTaskModePrompt("Review the migration", "teamwork");
  assert.equal(team.dispatch, "swarm"); assert.equal(team.prompt, "/swarm debate Review the migration");
  const schedule = routeTaskModePrompt("Run every week", "schedule");
  assert.equal(schedule.dispatch, "prompt"); assert.match(schedule.prompt, /ask the user to confirm/i);
});
check("chat UI exposes manual override, explicit acceptance, and optional model selection", () => {
  const html = renderMissionControlHtml();
  assert.match(html, /id="taskModeSelect"/);
  assert.match(html, /id="btnUseTaskSuggestion"/);
  assert.match(html, /Normal prompt — no workflow override/);
  assert.match(html, /Nothing is selected or dispatched automatically/);
  assert.match(html, /taskMode:selectedTaskMode/);
  assert.match(html, /id="taskModelRouting"/);
  assert.doesNotMatch(html, /btnUseSuggestedModel/);
  assert.match(html, /id="btnConnectProvider"/);
  assert.match(html, /id="btnDiscoverCustomModels"/);
  assert.match(html, /id="connectedProviderModelStep"/);
});
console.log(`Ring 14: ${checks} checks passed.`);
