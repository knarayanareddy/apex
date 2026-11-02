/**
 * Host Tool Admission & Turn Bounding Contract (R03 & R04)
 * (`src/core/tool-admission.ts`).
 *
 * UPSTREAM SPECIFICATION & ARCHITECTURAL MANDATE:
 *  - R03: One authoritative default-deny host admission contract binding
 *         (principal, workspace, tool, arguments, session, approval) BEFORE WAL dispatch.
 *  - R04: Live dispatcher bounds on nested execution, turn tool limits, total session tool
 *         calls, execution duration, and cancellation without authority drift.
 */

import path from "node:path";
import { GuardDeniedError } from "./monotonic-guard.ts";

export type ToolExecutionPrincipal =
  | "operator"
  | "model"
  | "subagent"
  | "codemode"
  | "cron"
  | "external-channel"
  | "synthetic-test";

export interface ToolAdmissionLimits {
  /** Maximum tool calls permitted within a single assistant turn (default: 25) */
  readonly maxToolCallsPerTurn: number;
  /** Maximum cumulative tool calls permitted across the entire session (default: 200) */
  readonly maxTotalToolCalls: number;
  /**
   * Maximum allowed nesting depth for tool calls:
   *  0: Direct top-level call from model or operator
   *  1: Sub-call issued by a parent tool (e.g., QuickJS codemode executing `tools.<tool>()`)
   * >1: Disallowed (nested sub-sub calls blocked fail-closed)
   */
  readonly maxNestedDepth: number;
  /** Maximum duration in milliseconds allowed for a single turn before timeout (default: 120_000 ms) */
  readonly maxTurnDurationMs: number;
}

export const DEFAULT_ADMISSION_LIMITS: ToolAdmissionLimits = {
  maxToolCallsPerTurn: 25,
  maxTotalToolCalls: 200,
  maxNestedDepth: 1,
  maxTurnDurationMs: 120_000
} as const;

export interface ToolAdmissionRequest {
  readonly principal: ToolExecutionPrincipal;
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly toolCallId: string;
  readonly parentToolCallId?: string | null;
  readonly signal?: AbortSignal;
}

export interface ToolAdmissionDecision {
  readonly allowed: boolean;
  readonly reason?: string;
  readonly depth: number;
  readonly turnCount: number;
  readonly sessionTotalCount: number;
}

export class ToolAdmissionError extends GuardDeniedError {
  public readonly code: string;
  public readonly toolName: string;

  constructor(code: string, toolName: string, reason: string) {
    super(`[TOOL_ADMISSION_DENIED:${code}] ${reason}`);
    this.name = "ToolAdmissionError";
    this.code = code;
    this.toolName = toolName;
  }
}

export interface ToolAdmissionOptions {
  readonly workspaceRoot: string;
  readonly sessionId: string;
  readonly limits?: Partial<ToolAdmissionLimits>;
  readonly allowedTools?: readonly string[];
  readonly deniedTools?: readonly string[];
  readonly readOnly?: boolean;
  readonly defaultPrincipal?: ToolExecutionPrincipal;
  readonly customValidator?: (req: ToolAdmissionRequest) => { allowed: boolean; reason?: string };
}

/** Mutating tool names blocked in read-only sandbox mode */
const MUTATING_CORE_TOOLS = new Set<string>([
  "write",
  "edit",
  "pty_write",
  "skill_promote",
  "autonomous_pr"
]);

export class ToolAdmissionController {
  private workspaceRoot: string;
  private sessionId: string;
  private limits: ToolAdmissionLimits;
  private allowedToolsSet: Set<string> | null = null;
  private deniedToolsSet: Set<string>;
  private readOnly: boolean;
  private defaultPrincipal: ToolExecutionPrincipal;
  private customValidator?: (req: ToolAdmissionRequest) => { allowed: boolean; reason?: string };

  private turnToolCallCount = 0;
  private sessionTotalToolCallCount = 0;
  private currentTurnStartMs: number = Date.now();
  private admittedToolCallIds = new Set<string>();

  constructor(opts: ToolAdmissionOptions) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.sessionId = opts.sessionId;
    this.limits = {
      ...DEFAULT_ADMISSION_LIMITS,
      ...(opts.limits ?? {})
    };
    if (opts.allowedTools) {
      this.allowedToolsSet = new Set(opts.allowedTools);
    }
    this.deniedToolsSet = new Set(opts.deniedTools ?? []);
    this.readOnly = opts.readOnly ?? false;
    this.defaultPrincipal = opts.defaultPrincipal ?? "model";
    this.customValidator = opts.customValidator;
  }

  /**
   * Computes the invocation nesting depth:
   *  - No parentToolCallId -> depth 0
   *  - Each slash `/` in toolCallId increases depth (e.g. `call_1/sub_0` -> depth 1)
   */
  public calculateNestingDepth(toolCallId: string, parentToolCallId?: string | null): number {
    if (!parentToolCallId && !toolCallId.includes("/")) {
      return 0;
    }
    const slashMatches = toolCallId.match(/\//g);
    const idDepth = slashMatches ? slashMatches.length : 0;
    if (parentToolCallId) {
      const parentSlashes = parentToolCallId.match(/\//g);
      const parentDepth = parentSlashes ? parentSlashes.length + 1 : 1;
      return Math.max(idDepth, parentDepth);
    }
    return idDepth;
  }

  public onTurnStart(): void {
    this.turnToolCallCount = 0;
    this.currentTurnStartMs = Date.now();
    this.admittedToolCallIds.clear();
  }

  public onTurnEnd(): void {
    this.turnToolCallCount = 0;
    this.admittedToolCallIds.clear();
  }

  public switchSession(newSessionId: string, newWorkspaceRoot?: string): void {
    this.sessionId = newSessionId;
    if (newWorkspaceRoot) {
      this.workspaceRoot = path.resolve(newWorkspaceRoot);
    }
    this.turnToolCallCount = 0;
    this.sessionTotalToolCallCount = 0;
    this.currentTurnStartMs = Date.now();
    this.admittedToolCallIds.clear();
  }

  public setAllowedTools(tools: readonly string[] | null): void {
    this.allowedToolsSet = tools ? new Set(tools) : null;
  }

  public setReadOnly(readOnly: boolean): void {
    this.readOnly = readOnly;
  }

  public getMetrics(): {
    turnToolCalls: number;
    sessionToolCalls: number;
    turnElapsedMs: number;
    activeSessionId: string;
    readOnly: boolean;
    allowedTools: string[] | null;
  } {
    return {
      turnToolCalls: this.turnToolCallCount,
      sessionToolCalls: this.sessionTotalToolCallCount,
      turnElapsedMs: Date.now() - this.currentTurnStartMs,
      activeSessionId: this.sessionId,
      readOnly: this.readOnly,
      allowedTools: this.allowedToolsSet ? Array.from(this.allowedToolsSet) : null
    };
  }

  /**
   * Primary authoritative admission check.
   * Evaluates all constraints and returns an authoritative decision.
   */
  public admit(req: Partial<ToolAdmissionRequest> & { toolName: string; toolCallId: string }): ToolAdmissionDecision {
    const fullReq: ToolAdmissionRequest = {
      principal: req.principal ?? this.defaultPrincipal,
      workspaceRoot: req.workspaceRoot ? path.resolve(req.workspaceRoot) : this.workspaceRoot,
      sessionId: req.sessionId ?? this.sessionId,
      toolName: req.toolName,
      args: req.args ?? {},
      toolCallId: req.toolCallId,
      parentToolCallId: req.parentToolCallId ?? null,
      signal: req.signal
    };

    const depth = this.calculateNestingDepth(fullReq.toolCallId, fullReq.parentToolCallId);

    // If this specific toolCallId was already admitted in this turn, allow idempotent re-check without double-increment
    if (this.admittedToolCallIds.has(fullReq.toolCallId)) {
      return {
        allowed: true,
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 1. Cancellation check
    if (fullReq.signal?.aborted) {
      return {
        allowed: false,
        reason: "TOOL_EXECUTION_CANCELLED: Operation aborted by signal before dispatch",
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 2. Workspace containment check (reject cross-workspace invocation)
    if (fullReq.workspaceRoot !== this.workspaceRoot) {
      return {
        allowed: false,
        reason: `WORKSPACE_MISMATCH: Requested workspace '${fullReq.workspaceRoot}' does not match active harness workspace '${this.workspaceRoot}'`,
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 3. Session identity binding (reject cross-session invocation)
    if (fullReq.sessionId !== this.sessionId) {
      return {
        allowed: false,
        reason: `SESSION_MISMATCH: Requested session '${fullReq.sessionId}' does not match active session '${this.sessionId}'`,
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 4. Nested call depth bound (R04)
    if (depth > this.limits.maxNestedDepth) {
      return {
        allowed: false,
        reason: `NESTED_DEPTH_EXCEEDED: Tool call '${fullReq.toolName}' has depth ${depth}, exceeding maximum allowed depth ${this.limits.maxNestedDepth}`,
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 5. Turn duration bound (R04)
    const turnElapsed = Date.now() - this.currentTurnStartMs;
    if (turnElapsed > this.limits.maxTurnDurationMs) {
      return {
        allowed: false,
        reason: `TURN_TIMEOUT_EXCEEDED: Turn duration ${turnElapsed}ms exceeded limit of ${this.limits.maxTurnDurationMs}ms`,
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 6. Turn tool count bound (R04)
    if (this.turnToolCallCount >= this.limits.maxToolCallsPerTurn) {
      return {
        allowed: false,
        reason: `TURN_TOOL_LIMIT_EXCEEDED: Reached maximum of ${this.limits.maxToolCallsPerTurn} tool calls in a single turn`,
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 7. Cumulative session tool count bound (R04)
    if (this.sessionTotalToolCallCount >= this.limits.maxTotalToolCalls) {
      return {
        allowed: false,
        reason: `SESSION_TOOL_LIMIT_EXCEEDED: Reached maximum of ${this.limits.maxTotalToolCalls} cumulative tool calls in session`,
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 8. Explicit Denylist check
    if (this.deniedToolsSet.has(fullReq.toolName)) {
      return {
        allowed: false,
        reason: `TOOL_DENIED: Tool '${fullReq.toolName}' is explicitly forbidden by admission policy`,
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 9. Authoritative Allowlist check (Default-Deny when allowedTools is specified)
    if (this.allowedToolsSet !== null && !this.allowedToolsSet.has(fullReq.toolName)) {
      return {
        allowed: false,
        reason: `TOOL_NOT_ADMITTED: Tool '${fullReq.toolName}' is not permitted by active tool admission policy (allowed: [${Array.from(this.allowedToolsSet).join(", ")}])`,
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 10. Read-only Sandbox Mode enforcement
    if (this.readOnly && MUTATING_CORE_TOOLS.has(fullReq.toolName)) {
      return {
        allowed: false,
        reason: `READ_ONLY_VIOLATION: Mutation tool '${fullReq.toolName}' blocked in read-only sandbox mode`,
        depth,
        turnCount: this.turnToolCallCount,
        sessionTotalCount: this.sessionTotalToolCallCount
      };
    }

    // 11. Custom Validator check (if supplied)
    if (this.customValidator) {
      const customDecision = this.customValidator(fullReq);
      if (!customDecision.allowed) {
        return {
          allowed: false,
          reason: customDecision.reason ?? `CUSTOM_GUARD_DENIED: Tool '${fullReq.toolName}' rejected by admission guard`,
          depth,
          turnCount: this.turnToolCallCount,
          sessionTotalCount: this.sessionTotalToolCallCount
        };
      }
    }

    // Record admitted invocation
    this.admittedToolCallIds.add(fullReq.toolCallId);
    this.turnToolCallCount++;
    this.sessionTotalToolCallCount++;

    return {
      allowed: true,
      depth,
      turnCount: this.turnToolCallCount,
      sessionTotalCount: this.sessionTotalToolCallCount
    };
  }

  /**
   * Asserts that a tool call is admitted, throwing `ToolAdmissionError` if denied.
   */
  public assertAdmitted(req: Partial<ToolAdmissionRequest> & { toolName: string; toolCallId: string }): ToolAdmissionDecision {
    const decision = this.admit(req);
    if (!decision.allowed) {
      const codeMatch = decision.reason?.match(/^([A-Z_]+):/);
      const code = codeMatch ? codeMatch[1]! : "DENIED";
      throw new ToolAdmissionError(code, req.toolName, decision.reason ?? "Tool call not admitted");
    }
    return decision;
  }
}
