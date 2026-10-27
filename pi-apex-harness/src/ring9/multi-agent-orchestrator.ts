/**
 * Ring 9 — Multi-Agent Persona Registry, Shared Typed Blackboard & Multi-Topology Orchestrator
 * (`src/ring9/multi-agent-orchestrator.ts`).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 * 1. `@earendil-works/pi-coding-agent@1.4.0` — `examples/extensions/subagent/{index,agents}.ts`
 *    (MIT License): Markdown+YAML custom agent persona discovery (`parseFrontmatter`),
 *    role/tool constraints, and structured task delegation.
 * 2. `anomalyco/opencode` @ `7c16f4ac3ea5` — `packages/core/src/worktree.ts` (PR #14649, MIT):
 *    Disjoint `ownedPaths` parallel worktree execution via Ring 2's `WorktreeSubagentPool`
 *    with guaranteed `0` leaked worktrees.
 * 3. `google-research/harness2` @ `1cfe254e8d25` — `harness2/core/selection.py` (Apache-2.0):
 *    Multi-candidate parallel Proposer + Judge tournament selection (`debate` topology).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readWorkspaceFileSafe } from "../core/safe-path.ts";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import { writeFileDurable } from "../core/wal-recovery.ts";
import {
  assertDisjointOwnedPaths,
  FIVE_ROLE_POLICIES,
  type SubagentRole,
  type SubagentSingleResult,
  type WorktreeSubagentPool
} from "../ring2/worktree-subagent-pool.ts";
import { scanSkillBundle } from "../ring3/skills-guard-quarantine.ts";
import type { DurabilityMode } from "../types.ts";
import type { SelfLearningLedger } from "./self-learning-ledger.ts";

export type OrchestrationTopology = "dag" | "supervisor" | "debate" | "map_reduce";

export interface AgentPersonaDefinition {
  name: string;
  description: string;
  role: SubagentRole;
  preferredModel?: string;
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  tools: string[];
  defaultOwnedPaths?: string[];
  systemPrompt: string;
  source: "builtin" | "workspace";
  relPath?: string;
}

export const BUILTIN_AGENT_PERSONAS: ReadonlyArray<AgentPersonaDefinition> = [
  {
    name: "architect",
    description: "Decomposes cross-cutting goals into disjoint module boundaries and interface contracts",
    role: "plan",
    thinkingLevel: "high",
    tools: ["read"],
    systemPrompt:
      "You are the Principal System Architect. Produce concise module boundaries, data contracts, and disjoint ownedPaths.",
    source: "builtin"
  },
  {
    name: "backend-engineer",
    description: "Implements server, database, and domain logic within assigned backend ownedPaths",
    role: "execute",
    thinkingLevel: "medium",
    tools: ["read", "write", "edit", "bash"],
    defaultOwnedPaths: ["src/backend", "src/api", "src/core"],
    systemPrompt:
      "You are the Backend Engineer. Implement clean, type-safe changes strictly inside your assigned ownedPaths.",
    source: "builtin"
  },
  {
    name: "frontend-engineer",
    description: "Implements UI components, styles, and client state within assigned frontend ownedPaths",
    role: "execute",
    thinkingLevel: "medium",
    tools: ["read", "write", "edit", "bash"],
    defaultOwnedPaths: ["src/ui", "src/frontend", "public"],
    systemPrompt:
      "You are the Frontend Engineer. Build accessible, zero-external-CDN UI changes strictly within assigned ownedPaths.",
    source: "builtin"
  },
  {
    name: "security-auditor",
    description: "Audits diffs, trust boundaries, secret exposure, and injection surfaces",
    role: "review",
    thinkingLevel: "high",
    tools: ["read", "bash"],
    systemPrompt:
      "You are the Security Auditor. Flag concrete P0/P1 vulnerabilities, path traversal, and secret leaks with line references.",
    source: "builtin"
  },
  {
    name: "qa-verifier",
    description: "Executes isolated verification checks, edge-case assertions, and regression suites",
    role: "verify",
    thinkingLevel: "medium",
    tools: ["read", "bash"],
    systemPrompt:
      "You are the QA Verifier. Validate behavioral invariants, edge cases, and test suite pass criteria.",
    source: "builtin"
  }
];

export interface BlackboardFact {
  key: string;
  authorNodeId: string;
  persona: string;
  value: string;
  timestampMs: number;
}

/**
 * Scoped inter-agent typed blackboard allowing upstream nodes in a DAG / Supervisor / Debate run
 * to publish interface contracts, findings, and candidate proposals to downstream agents cleanly.
 */
export class AgentBlackboard {
  private readonly facts = new Map<string, BlackboardFact>();

  public postFact(authorNodeId: string, persona: string, key: string, value: string): BlackboardFact {
    const entry: BlackboardFact = {
      key,
      authorNodeId,
      persona,
      value: scrubSecretsInfallible(value),
      timestampMs: Date.now()
    };
    this.facts.set(key, entry);
    return entry;
  }

  public getFact(key: string): BlackboardFact | undefined {
    return this.facts.get(key);
  }

  public listFacts(): BlackboardFact[] {
    return Array.from(this.facts.values());
  }

  public formatContextBlock(filterKeys?: string[]): string {
    const entries = filterKeys
      ? filterKeys.map((k) => this.facts.get(k)).filter((x): x is BlackboardFact => Boolean(x))
      : this.listFacts();
    if (entries.length === 0) return "";
    const lines = entries.map(
      (f) => `  <fact key="${f.key}" author="${f.authorNodeId}" persona="${f.persona}">${f.value}</fact>`
    );
    return [`<blackboard_context>`, ...lines, `</blackboard_context>`].join("\n");
  }
}

export interface DagNodeSpec {
  id: string;
  persona?: string;
  role?: SubagentRole;
  task: string;
  dependsOn?: string[];
  ownedPaths?: string[];
  applyChangesToWorkspace?: boolean;
  publishBlackboardKey?: string;
}

export interface OrchestrationNodeOutcome {
  nodeId: string;
  wave: number;
  persona: string;
  role: SubagentRole;
  output: string;
  harvestedFiles: string[];
  deletedFiles: string[];
  appliedToWorkspace: boolean;
  exitStatus: "ok" | "error";
  errorMessage?: string;
}

export interface OrchestrationRunResult {
  runId: string;
  topology: OrchestrationTopology;
  wavesExecuted: number;
  nodes: OrchestrationNodeOutcome[];
  blackboardFacts: BlackboardFact[];
  winningSummary?: string;
  ledgerEntryId?: string;
  elapsedMs: number;
}

/**
 * Partitions a DAG into topological execution waves via Kahn's algorithm.
 * Throws `DAG_CYCLE_DETECTED` or `DAG_UNKNOWN_DEPENDENCY` before any worker runs.
 */
export function buildTopologicalWaves(nodes: readonly DagNodeSpec[]): DagNodeSpec[][] {
  if (nodes.length === 0) {
    throw new Error("EMPTY_ORCHESTRATION_DAG: provide at least 1 node.");
  }
  const byId = new Map<string, DagNodeSpec>();
  for (const n of nodes) {
    if (byId.has(n.id)) {
      throw new Error(`DUPLICATE_DAG_NODE_ID: '${n.id}'`);
    }
    byId.set(n.id, n);
  }

  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const n of nodes) {
    inDegree.set(n.id, 0);
    dependents.set(n.id, []);
  }

  for (const n of nodes) {
    for (const dep of n.dependsOn ?? []) {
      if (!byId.has(dep)) {
        throw new Error(`DAG_UNKNOWN_DEPENDENCY: node '${n.id}' depends on unknown '${dep}'.`);
      }
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1);
      dependents.get(dep)!.push(n.id);
    }
  }

  const waves: DagNodeSpec[][] = [];
  let ready = nodes.filter((n) => (inDegree.get(n.id) ?? 0) === 0).map((n) => n.id);
  let visited = 0;

  while (ready.length > 0) {
    const waveSpecs = ready.map((id) => byId.get(id)!);
    // Validate disjoint ownedPaths across concurrent execute nodes within the same wave!
    assertDisjointOwnedPaths(
      waveSpecs.map((s) => ({
        id: s.id,
        role: s.role ?? "explore",
        ownedPaths: s.ownedPaths
      }))
    );
    waves.push(waveSpecs);
    visited += waveSpecs.length;

    const nextReady: string[] = [];
    for (const id of ready) {
      for (const childId of dependents.get(id) ?? []) {
        const nextDeg = (inDegree.get(childId) ?? 1) - 1;
        inDegree.set(childId, nextDeg);
        if (nextDeg === 0) {
          nextReady.push(childId);
        }
      }
    }
    ready = nextReady;
  }

  if (visited !== nodes.length) {
    throw new Error(
      `DAG_CYCLE_DETECTED: dependency cycle detected among [${nodes
        .filter((n) => (inDegree.get(n.id) ?? 0) > 0)
        .map((n) => n.id)
        .join(", ")}].`
    );
  }

  return waves;
}

export class MultiAgentOrchestrator {
  private readonly workspaceRoot: string;
  private readonly getSubagentPool: () => WorktreeSubagentPool;
  private readonly getLedger?: () => SelfLearningLedger;
  private readonly durabilityMode: DurabilityMode;
  private readonly history: OrchestrationRunResult[] = [];

  constructor(opts: {
    workspaceRoot: string;
    getSubagentPool: () => WorktreeSubagentPool;
    getLedger?: () => SelfLearningLedger;
    durabilityMode?: DurabilityMode;
  }) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.getSubagentPool = opts.getSubagentPool;
    this.getLedger = opts.getLedger;
    this.durabilityMode = opts.durabilityMode ?? "crash-safe";
  }

  /**
   * Discovers built-in + `.agents/agents/*.md` custom personas, enforcing `skills-guard-v10`
   * prompt-injection quarantine on workspace persona definitions (`AGENT_PERSONA_POISONED`).
   */
  public listPersonas(): AgentPersonaDefinition[] {
    const merged = new Map<string, AgentPersonaDefinition>();
    for (const b of BUILTIN_AGENT_PERSONAS) {
      merged.set(b.name, b);
    }

    const agentsDirRel = path.join(".agents", "agents");
    const agentsDirAbs = path.join(this.workspaceRoot, agentsDirRel);
    if (fs.existsSync(agentsDirAbs) && fs.lstatSync(agentsDirAbs).isDirectory()) {
      for (const entry of fs.readdirSync(agentsDirAbs).sort()) {
        if (!entry.endsWith(".md")) continue;
        const relPath = path.join(agentsDirRel, entry);
        const rawBuf = readWorkspaceFileSafe({
          workspaceRoot: this.workspaceRoot,
          candidatePath: relPath
        });
        const content = rawBuf.toString("utf8");
        const scan = scanSkillBundle({
          skillName: `persona-${entry}`,
          files: { [entry]: content },
          source: relPath,
          trustLevel: "community"
        });
        if (scan.verdict === "dangerous") {
          throw new Error(
            `AGENT_PERSONA_POISONED (${relPath}): skills-guard-v10 blocked malicious custom agent definition.`
          );
        }

        const { frontmatter, body } = parseFrontmatter<Record<string, unknown>>(content);
        const name =
          typeof frontmatter["name"] === "string" && frontmatter["name"].trim()
            ? frontmatter["name"].trim()
            : entry.replace(/\.md$/, "");
        const roleRaw = typeof frontmatter["role"] === "string" ? frontmatter["role"] : "explore";
        const role: SubagentRole =
          roleRaw in FIVE_ROLE_POLICIES ? (roleRaw as SubagentRole) : "explore";
        const tools = Array.isArray(frontmatter["tools"])
          ? (frontmatter["tools"] as unknown[]).map(String)
          : typeof frontmatter["tools"] === "string"
            ? frontmatter["tools"]
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean)
            : FIVE_ROLE_POLICIES[role].allowedBuiltInTools;
        const defaultOwnedPaths = Array.isArray(frontmatter["ownedPaths"])
          ? (frontmatter["ownedPaths"] as unknown[]).map(String)
          : undefined;

        merged.set(name, {
          name,
          description:
            typeof frontmatter["description"] === "string"
              ? frontmatter["description"]
              : `Custom ${role} agent persona`,
          role,
          preferredModel:
            typeof frontmatter["model"] === "string" ? frontmatter["model"] : undefined,
          thinkingLevel:
            typeof frontmatter["thinkingLevel"] === "string"
              ? (frontmatter["thinkingLevel"] as AgentPersonaDefinition["thinkingLevel"])
              : undefined,
          tools,
          defaultOwnedPaths,
          systemPrompt: body.trim(),
          source: "workspace",
          relPath
        });
      }
    }

    return Array.from(merged.values());
  }

  /**
   * Creates & `skills-guard-v10` validates a custom `.agents/agents/<name>.md` persona file.
   */
  public saveCustomPersona(spec: {
    name: string;
    description: string;
    role: SubagentRole;
    preferredModel?: string;
    thinkingLevel?: "minimal" | "low" | "medium" | "high";
    tools?: string[];
    defaultOwnedPaths?: string[];
    systemPrompt: string;
  }): AgentPersonaDefinition {
    const slug = spec.name.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
    if (!slug) {
      throw new Error("INVALID_PERSONA_NAME: name must contain alphanumeric characters.");
    }
    const tools = spec.tools ?? FIVE_ROLE_POLICIES[spec.role].allowedBuiltInTools;
    const mdLines = [
      "---",
      `name: ${slug}`,
      `description: ${spec.description.trim()}`,
      `role: ${spec.role}`,
      ...(spec.preferredModel ? [`model: ${spec.preferredModel}`] : []),
      ...(spec.thinkingLevel ? [`thinkingLevel: ${spec.thinkingLevel}`] : []),
      `tools: ${tools.join(", ")}`,
      ...(spec.defaultOwnedPaths && spec.defaultOwnedPaths.length > 0
        ? [`ownedPaths: [${spec.defaultOwnedPaths.join(", ")}]`]
        : []),
      "---",
      "",
      spec.systemPrompt.trim(),
      ""
    ].join("\n");

    const scan = scanSkillBundle({
      skillName: `persona-${slug}`,
      files: { [`${slug}.md`]: mdLines },
      source: `saveCustomPersona:${slug}`,
      trustLevel: "community"
    });
    if (scan.verdict === "dangerous") {
      throw new Error(
        `AGENT_PERSONA_POISONED (${slug}): skills-guard-v10 rejected dangerous persona prompt.`
      );
    }

    const relPath = path.join(".agents", "agents", `${slug}.md`);
    writeFileDurable(
      path.join(this.workspaceRoot, relPath),
      Buffer.from(mdLines, "utf8"),
      this.durabilityMode,
      { workspaceRoot: this.workspaceRoot, mode: 0o644 }
    );

    return this.listPersonas().find((p) => p.name === slug)!;
  }

  public getRecentRuns(): ReadonlyArray<OrchestrationRunResult> {
    return this.history;
  }

  /**
   * Executes a multi-agent workflow under `dag`, `supervisor`, `debate`, or `map_reduce` topology.
   */
  public async runOrchestration(input: {
    topology: OrchestrationTopology;
    goal?: string;
    nodes?: DagNodeSpec[];
    workerTasks?: Array<{
      id?: string;
      persona?: string;
      task: string;
      ownedPaths: string[];
      applyChangesToWorkspace?: boolean;
    }>;
    debatePersonas?: string[];
    shards?: Array<{ id: string; scopePath: string; question: string }>;
  }): Promise<OrchestrationRunResult> {
    const t0 = performance.now();
    const runId = `swm_${crypto.randomBytes(4).toString("hex")}`;
    const personasByName = new Map(this.listPersonas().map((p) => [p.name, p]));
    const blackboard = new AgentBlackboard();

    let resolvedNodes: DagNodeSpec[];

    if (input.topology === "dag") {
      if (!input.nodes || input.nodes.length === 0) {
        throw new Error("MISSING_DAG_NODES: topology='dag' requires non-empty nodes[].");
      }
      resolvedNodes = input.nodes.map((n) => {
        const persona = n.persona ? personasByName.get(n.persona) : undefined;
        const role = n.role ?? persona?.role ?? "explore";
        return {
          ...n,
          role,
          ownedPaths: n.ownedPaths ?? (role === "execute" ? persona?.defaultOwnedPaths : undefined)
        };
      });
    } else if (input.topology === "supervisor") {
      const goal = (input.goal ?? "").trim();
      if (!goal) throw new Error("MISSING_SUPERVISOR_GOAL: provide goal for supervisor topology.");
      const workers = input.workerTasks ?? [];
      const workerNodes: DagNodeSpec[] = workers.map((w, idx) => ({
        id: w.id ?? `worker_${idx + 1}`,
        persona: w.persona ?? "backend-engineer",
        role: "execute",
        dependsOn: ["supervisor_plan"],
        ownedPaths: w.ownedPaths,
        applyChangesToWorkspace: w.applyChangesToWorkspace ?? true,
        publishBlackboardKey: `worker_${idx + 1}_result`,
        task: `Goal: ${goal}\nAssigned Worker Task: ${w.task}\nFollow <blackboard_context> plan.`
      }));
      resolvedNodes = [
        {
          id: "supervisor_plan",
          persona: "architect",
          role: "plan",
          publishBlackboardKey: "architecture_plan",
          task: `Decompose goal into concrete implementation contracts:\n${goal}`
        },
        ...workerNodes,
        {
          id: "supervisor_review",
          persona: "security-auditor",
          role: "review",
          dependsOn: workerNodes.length > 0 ? workerNodes.map((w) => w.id) : ["supervisor_plan"],
          publishBlackboardKey: "security_signoff",
          task: `Audit all completed worker outputs for goal: ${goal}`
        }
      ];
    } else if (input.topology === "debate") {
      const goal = (input.goal ?? "").trim();
      if (!goal) throw new Error("MISSING_DEBATE_GOAL: provide goal for debate topology.");
      const debaters =
        input.debatePersonas && input.debatePersonas.length >= 2
          ? input.debatePersonas
          : ["architect", "security-auditor"];
      const propNodes: DagNodeSpec[] = debaters.map((pName, idx) => ({
        id: `proposer_${idx + 1}`,
        persona: pName,
        role: "plan",
        publishBlackboardKey: `proposal_${idx + 1}_${pName}`,
        task: `Propose concrete design & trade-offs for:\n${goal}`
      }));
      resolvedNodes = [
        ...propNodes,
        {
          id: "debate_judge",
          persona: "qa-verifier",
          role: "plan",
          dependsOn: propNodes.map((p) => p.id),
          publishBlackboardKey: "debate_winner",
          task: `Compare all <blackboard_context> proposals and synthesize the single strongest winning plan for: ${goal}`
        }
      ];
    } else {
      // `map_reduce`
      const shards = input.shards ?? [];
      if (shards.length === 0) {
        throw new Error("MISSING_MAP_REDUCE_SHARDS: topology='map_reduce' requires shards[].");
      }
      const mapNodes: DagNodeSpec[] = shards.map((s) => ({
        id: `map_${s.id}`,
        persona: "architect",
        role: "explore",
        publishBlackboardKey: `shard_${s.id}`,
        task: `Scope '${s.scopePath}': ${s.question}`
      }));
      resolvedNodes = [
        ...mapNodes,
        {
          id: "reduce_synthesis",
          persona: "architect",
          role: "plan",
          dependsOn: mapNodes.map((m) => m.id),
          publishBlackboardKey: "reduced_report",
          task: `Synthesize all mapped shard findings from <blackboard_context> into one unified report.`
        }
      ];
    }

    const waves = buildTopologicalWaves(resolvedNodes);
    const pool = this.getSubagentPool();
    const outcomesById = new Map<string, OrchestrationNodeOutcome>();
    const allOutcomes: OrchestrationNodeOutcome[] = [];

    for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
      const wave = waves[waveIdx]!;
      const waveTasks = wave.map((node) => {
        const persona = node.persona ? personasByName.get(node.persona) : undefined;
        const role = node.role ?? persona?.role ?? "explore";

        // Substitute `{dep:<nodeId>}` references with upstream outputs
        let hydratedTask = node.task.replace(/\{dep:([a-zA-Z0-9_-]+)\}/g, (_m, depId: string) => {
          return outcomesById.get(depId)?.output ?? "";
        });

        const bbBlock = blackboard.formatContextBlock();
        const personaHeader = persona
          ? `[Agent Persona: ${persona.name} (${role})]\n${persona.systemPrompt}\n\n`
          : "";
        hydratedTask = [personaHeader, bbBlock, hydratedTask].filter(Boolean).join("\n\n");

        return {
          node,
          personaName: persona?.name ?? role,
          spec: {
            role,
            task: hydratedTask,
            ownedPaths: node.ownedPaths,
            applyChangesToWorkspace: node.applyChangesToWorkspace ?? (role === "execute")
          }
        };
      });

      const dispatchRes =
        waveTasks.length === 1
          ? await pool.dispatch(waveTasks[0]!.spec)
          : await pool.dispatch({
              mode: "parallel",
              tasks: waveTasks.map((w) => w.spec)
            });

      waveTasks.forEach((wt, i) => {
        const r: SubagentSingleResult = dispatchRes.results[i]!;
        const outcome: OrchestrationNodeOutcome = {
          nodeId: wt.node.id,
          wave: waveIdx + 1,
          persona: wt.personaName,
          role: wt.spec.role,
          output: r.output,
          harvestedFiles: r.harvestedFiles,
          deletedFiles: r.deletedFiles,
          appliedToWorkspace: r.appliedToWorkspace,
          exitStatus: r.exitStatus,
          errorMessage: r.errorMessage
        };
        outcomesById.set(wt.node.id, outcome);
        allOutcomes.push(outcome);

        const bbKey = wt.node.publishBlackboardKey ?? wt.node.id;
        blackboard.postFact(wt.node.id, wt.personaName, bbKey, r.output);
      });
    }

    const lastOutcome = allOutcomes.at(-1);
    const winningSummary = lastOutcome?.output;
    let ledgerEntryId: string | undefined;

    if (
      input.topology === "debate" &&
      winningSummary &&
      lastOutcome?.exitStatus === "ok" &&
      this.getLedger
    ) {
      try {
        const entry = this.getLedger().recordSwarmConsensus({
          runId,
          topic: input.goal ?? "Multi-agent debate",
          winningSummary
        });
        ledgerEntryId = entry.entryId;
      } catch {
        // Optional ledger capture
      }
    }

    const result: OrchestrationRunResult = {
      runId,
      topology: input.topology,
      wavesExecuted: waves.length,
      nodes: allOutcomes,
      blackboardFacts: blackboard.listFacts(),
      winningSummary,
      ledgerEntryId,
      elapsedMs: Number((performance.now() - t0).toFixed(2))
    };
    this.history.unshift(result);
    if (this.history.length > 25) this.history.pop();
    return result;
  }
}
