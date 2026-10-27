/**
 * Ring 9 — Deferred Specialist Tools (`gateway_dispatch`, `swarm_orchestrate`, `plugin_manager`,
 * `learning_ledger`) + Zero-Token Operator Slash Commands (`/gateway`, `/send`, `/agents`,
 * `/swarm`, `/plugin`, `/ledger`) (`src/ring9/ring9-extension.ts`).
 *
 * PRESERVED INVARIANTS:
 * - All 4 Ring 9 tools register strictly with `exposure: "deferred"` (`1,073 === 1,073` `o200k_base`
 *   active schema tokens — zero schema bloat even when external plugins are installed at runtime!).
 * - All 6 slash commands register via `ExtensionAPI.registerCommand` (`+0` schema tokens, `0` drift).
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExternalPluginHost } from "./external-plugin-host.ts";
import {
  type GatewayPlatform,
  generateSlackAppManifest,
  type OmniChannelGateway
} from "./messaging-gateway.ts";
import type {
  DagNodeSpec,
  MultiAgentOrchestrator
} from "./multi-agent-orchestrator.ts";
import type {
  LearningEntryKind,
  LearningSourceEvent,
  SelfLearningLedger
} from "./self-learning-ledger.ts";

export interface Ring9Options {
  gatewayAllowedSenders?: Array<{ platform: GatewayPlatform; senderId: string; label?: string }>;
}

export const RING9_SLASH_COMMANDS = [
  "gateway",
  "send",
  "agents",
  "swarm",
  "plugin",
  "ledger"
] as const;

export function createRing9Extension(bridge: {
  getSurfacesDir: () => string;
  getAllSlashCommands: () => readonly string[];
  getGateway: () => OmniChannelGateway;
  getOrchestrator: () => MultiAgentOrchestrator;
  getPluginHost: () => ExternalPluginHost;
  getLedger: () => SelfLearningLedger;
  onCommandOutput?: (commandName: string, markdown: string, details: unknown) => void;
}): ExtensionFactory {
  const GatewayParams = Type.Object({
    action: Type.Union([
      Type.Literal("status"),
      Type.Literal("send"),
      Type.Literal("issue_pair"),
      Type.Literal("list_messages"),
      Type.Literal("slack_manifest")
    ]),
    platform: Type.Optional(Type.String({ description: "Platform identifier (telegram, slack, discord, signal, whatsapp_baileys, whatsapp_cloud)" })),
    channelId: Type.Optional(Type.String({ description: "Target chat/channel ID or E.164 phone" })),
    text: Type.Optional(Type.String({ description: "Outbound message body" }))
  });

  const SwarmParams = Type.Object({
    action: Type.Union([
      Type.Literal("list_personas"),
      Type.Literal("run_dag"),
      Type.Literal("run_supervisor"),
      Type.Literal("run_debate"),
      Type.Literal("run_map_reduce")
    ]),
    goal: Type.Optional(Type.String({ description: "High-level goal for supervisor or debate" })),
    nodes: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
    debatePersonas: Type.Optional(Type.Array(Type.String())),
    shards: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown())))
  });

  const PluginManagerParams = Type.Object({
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("audit"),
      Type.Literal("install"),
      Type.Literal("call_tool"),
      Type.Literal("enable"),
      Type.Literal("disable")
    ]),
    sourceDir: Type.Optional(Type.String({ description: "Filesystem directory for audit/install" })),
    pluginId: Type.Optional(Type.String({ description: "Installed plugin ID" })),
    toolName: Type.Optional(Type.String({ description: "Plugin tool name for call_tool" })),
    args: Type.Optional(Type.Record(Type.String(), Type.Unknown()))
  });

  const LearningLedgerParams = Type.Object({
    action: Type.Union([
      Type.Literal("list"),
      Type.Literal("verify"),
      Type.Literal("record"),
      Type.Literal("outcome"),
      Type.Literal("rollback"),
      Type.Literal("materialize")
    ]),
    kind: Type.Optional(Type.String({ description: "experience_cue | review_rule | memory_fact | skill_draft | routing_hint" })),
    domain: Type.Optional(Type.String()),
    cue: Type.Optional(Type.String()),
    lesson: Type.Optional(Type.String()),
    evidence: Type.Optional(Type.String()),
    entryId: Type.Optional(Type.String()),
    helped: Type.Optional(Type.Boolean()),
    reason: Type.Optional(Type.String())
  });

  return (pi) => {
    const emitReport = (
      ctx: ExtensionContext,
      commandName: string,
      markdown: string,
      details: unknown,
      level: "info" | "warning" | "error" = "info"
    ) => {
      if (ctx.hasUI) {
        ctx.ui.notify(markdown, level);
      }
      if (ctx.mode === "print") {
        process.stdout.write(`${markdown.trimEnd()}\n`);
      }
      pi.sendMessage(
        {
          customType: "pi-apex-command",
          content: markdown,
          display: true,
          details: {
            command: commandName,
            ...(typeof details === "object" && details !== null
              ? (details as object)
              : { value: details })
          }
        },
        { triggerTurn: false }
      );
      bridge.onCommandOutput?.(commandName, markdown, details);
    };

    // 1. Deferred `gateway_dispatch` tool
    pi.registerTool({
      name: "gateway_dispatch",
      label: "Omni-Channel Messaging Gateway",
      description:
        "Inspect gateway status, issue 6-digit pairing tokens, generate Slack App Manifest, or send outbound notifications across WhatsApp, Telegram, Discord, Slack, and Signal.",
      parameters: GatewayParams,
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const gw = bridge.getGateway();
        let payload: unknown;
        if (params.action === "status") {
          payload = gw.getStatusSummary();
        } else if (params.action === "issue_pair") {
          payload = gw.issuePairingCode((params.platform ?? "telegram") as GatewayPlatform);
        } else if (params.action === "list_messages") {
          payload = gw.listRecentMessages(25);
        } else if (params.action === "slack_manifest") {
          payload = generateSlackAppManifest({ slashCommands: bridge.getAllSlashCommands() });
        } else {
          if (!params.platform || !params.channelId || !params.text) {
            throw new Error("gateway_dispatch send requires platform, channelId, and text.");
          }
          payload = await gw.send({
            platform: params.platform as GatewayPlatform,
            channelId: params.channelId,
            text: params.text
          });
        }
        const content: TextContent[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
        return { content, details: payload };
      }
    });

    // 2. Deferred `swarm_orchestrate` tool
    pi.registerTool({
      name: "swarm_orchestrate",
      label: "Multi-Agent DAG & Swarm Orchestrator",
      description:
        "List custom/built-in agent personas or execute multi-agent DAG, Supervisor, Debate, and Map-Reduce workflows across isolated Git worktrees.",
      parameters: SwarmParams,
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const orch = bridge.getOrchestrator();
        let payload: unknown;
        if (params.action === "list_personas") {
          payload = orch.listPersonas();
        } else if (params.action === "run_dag") {
          payload = await orch.runOrchestration({
            topology: "dag",
            nodes: (params.nodes ?? []) as unknown as DagNodeSpec[]
          });
        } else if (params.action === "run_supervisor") {
          payload = await orch.runOrchestration({
            topology: "supervisor",
            goal: params.goal ?? ""
          });
        } else if (params.action === "run_debate") {
          payload = await orch.runOrchestration({
            topology: "debate",
            goal: params.goal ?? "",
            debatePersonas: params.debatePersonas
          });
        } else {
          payload = await orch.runOrchestration({
            topology: "map_reduce",
            shards: (params.shards ?? []) as Array<{
              id: string;
              scopePath: string;
              question: string;
            }>
          });
        }
        const content: TextContent[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
        return { content, details: payload };
      }
    });

    // 3. Deferred `plugin_manager` tool
    pi.registerTool({
      name: "plugin_manager",
      label: "Quarantine-Scanned External Plugin Host",
      description:
        "Audit, install, enable, disable, or invoke external plugins in QuickJS Codemode with zero active schema bloat.",
      parameters: PluginManagerParams,
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const host = bridge.getPluginHost();
        let payload: unknown;
        if (params.action === "list") {
          payload = host.listPlugins();
        } else if (params.action === "audit") {
          if (!params.sourceDir) throw new Error("plugin_manager audit requires sourceDir.");
          payload = host.auditPluginDirectory(params.sourceDir);
        } else if (params.action === "install") {
          if (!params.sourceDir) throw new Error("plugin_manager install requires sourceDir.");
          payload = await host.installAndLoadPlugin(params.sourceDir);
        } else if (params.action === "enable") {
          if (!params.pluginId) throw new Error("plugin_manager enable requires pluginId.");
          payload = await host.enablePlugin(params.pluginId);
        } else if (params.action === "disable") {
          if (!params.pluginId) throw new Error("plugin_manager disable requires pluginId.");
          payload = host.disablePlugin(params.pluginId);
        } else {
          if (!params.pluginId || !params.toolName) {
            throw new Error("plugin_manager call_tool requires pluginId and toolName.");
          }
          payload = await host.invokePluginTool(
            params.pluginId,
            params.toolName,
            params.args ?? {}
          );
        }
        const content: TextContent[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
        return { content, details: payload };
      }
    });

    // 4. Deferred `learning_ledger` tool
    pi.registerTool({
      name: "learning_ledger",
      label: "Hash-Chained Self-Learning Ledger",
      description:
        "Query, verify SHA-256 chain integrity, record lessons, track outcomes, rollback, or materialize next-boot EXPERIENCE.md & REVIEW_RULES.md.",
      parameters: LearningLedgerParams,
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const ledger = bridge.getLedger();
        let payload: unknown;
        if (params.action === "list") {
          payload = ledger.listEntries({ limit: 30 });
        } else if (params.action === "verify") {
          payload = ledger.verifyIntegrity();
        } else if (params.action === "record") {
          payload = ledger.recordLesson({
            sourceEvent: "manual_operator" as LearningSourceEvent,
            kind: ((params.kind ?? "experience_cue") as Exclude<LearningEntryKind, "tombstone">),
            domain: params.domain,
            cue: params.cue ?? "",
            lesson: params.lesson ?? "",
            evidence: params.evidence
          });
        } else if (params.action === "outcome") {
          if (!params.entryId || typeof params.helped !== "boolean") {
            throw new Error("learning_ledger outcome requires entryId and helped:boolean.");
          }
          payload = ledger.recordOutcome(params.entryId, params.helped);
        } else if (params.action === "rollback") {
          if (!params.entryId) throw new Error("learning_ledger rollback requires entryId.");
          payload = ledger.rollbackEntry(params.entryId, params.reason);
        } else {
          payload = ledger.materializeSurfaces({ surfacesDir: bridge.getSurfacesDir() });
        }
        const content: TextContent[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
        return { content, details: payload };
      }
    });

    // Slash Command 1: `/gateway`
    pi.registerCommand("gateway", {
      description:
        "Manage Omni-Channel Messaging Gateway: /gateway [status|pair <platform>|whatsapp [phone]|slack-manifest|approvals]",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const gw = bridge.getGateway();
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "status").toLowerCase();

        if (sub === "pair") {
          const platform = (parts[1] ?? "telegram") as GatewayPlatform;
          const tok = gw.issuePairingCode(platform);
          emitReport(
            ctx,
            "gateway",
            `# Gateway Pairing Code (${tok.platform})\n- **One-Time Code:** \`${tok.code}\` (send \`/pair ${tok.code}\` from your ${tok.platform} DM within 10 minutes)`,
            tok
          );
          return;
        }
        if (sub === "whatsapp") {
          const st = gw.initWhatsAppBaileysPairing(parts[1]);
          emitReport(
            ctx,
            "gateway",
            `# WhatsApp Personal Bridge (Baileys Multi-Device)\n- **8-Char Link Code:** \`${st.eightCharLinkCode}\`\n- **QR URI:** \`${st.qrPayload}\`\n- **Connected:** \`${st.connected}\` (${st.pairedPhoneE164 ?? "scan QR or pass E.164"})`,
            st
          );
          return;
        }
        if (sub === "slack-manifest") {
          const manifest = generateSlackAppManifest({
            slashCommands: bridge.getAllSlashCommands()
          });
          emitReport(
            ctx,
            "gateway",
            `# Slack App Manifest (${bridge.getAllSlashCommands().length} Native Commands)\n\`\`\`json\n${JSON.stringify(manifest, null, 2)}\n\`\`\``,
            manifest
          );
          return;
        }
        if (sub === "approvals") {
          const list = gw.listApprovals();
          const lines =
            list.length === 0
              ? ["- (no remote approvals queued)"]
              : list.map(
                  (a) =>
                    `- **\`${a.approvalId}\`** [${a.status}] ${a.platform}/${a.senderId}: ${a.actionSummary}`
                );
          emitReport(ctx, "gateway", `# Remote Channel Approvals (${list.length})\n${lines.join("\n")}`, {
            approvals: list
          });
          return;
        }

        const st = gw.getStatusSummary();
        const lines = st.platforms.map(
          (p) => `- **\`${p.platform}\`** [${p.configured ? "READY" : "UNCONFIGURED"}]: ${p.mode}`
        );
        emitReport(
          ctx,
          "gateway",
          `# Omni-Channel Messaging Gateway (Paired Senders: ${st.allowedSendersCount})\n${lines.join("\n")}`,
          st
        );
      }
    });

    // Slash Command 2: `/send` (`hermes send` port)
    pi.registerCommand("send", {
      description:
        "Send a zero-LLM notification to a messaging platform: /send <platform> <channelId> <message...>",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const match = /^(\S+)\s+(\S+)\s+([\s\S]+)$/.exec(args.trim());
        if (!match) {
          emitReport(
            ctx,
            "send",
            "Usage: `/send <telegram|discord|slack|signal|whatsapp_baileys|whatsapp_cloud> <channelId> <message>`",
            { error: "MISSING_ARGS" },
            "warning"
          );
          return;
        }
        const receipt = await bridge.getGateway().send({
          platform: match[1]! as GatewayPlatform,
          channelId: match[2]!,
          text: match[3]!
        });
        emitReport(
          ctx,
          "send",
          `Delivered \`${receipt.deliveryId}\` to **${receipt.platform}** (\`${receipt.channelId}\`, transport=\`${receipt.transportDetail}\`).`,
          receipt
        );
      }
    });

    // Slash Command 3: `/agents`
    pi.registerCommand("agents", {
      description: "List built-in & custom `.agents/agents/*.md` subagent personas",
      handler: async (_args: string, ctx: ExtensionCommandContext) => {
        const personas = bridge.getOrchestrator().listPersonas();
        const lines = personas.map(
          (p) =>
            `- **\`${p.name}\`** [${p.role} | ${p.source}] tools=\`${p.tools.join(",")}\` — ${p.description}`
        );
        emitReport(
          ctx,
          "agents",
          `# Registered Multi-Agent Personas (${personas.length})\n${lines.join("\n")}`,
          { personas }
        );
      }
    });

    // Slash Command 4: `/swarm`
    pi.registerCommand("swarm", {
      description:
        "Run Multi-Agent Orchestrator: /swarm [runs | debate <goal> | supervisor <goal>]",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const orch = bridge.getOrchestrator();
        const trimmed = args.trim();
        if (!trimmed || trimmed === "runs") {
          const runs = orch.getRecentRuns();
          const lines =
            runs.length === 0
              ? ["- (no multi-agent orchestration runs yet — try `/swarm debate <goal>`)"]
              : runs.map(
                  (r) =>
                    `- **\`${r.runId}\`** [${r.topology}] waves=${r.wavesExecuted}, nodes=${r.nodes.length} (${r.elapsedMs} ms)`
                );
          emitReport(
            ctx,
            "swarm",
            `# Multi-Agent Orchestration Runs (${runs.length})\n${lines.join("\n")}`,
            { runs }
          );
          return;
        }
        const m = /^(debate|supervisor)\s+([\s\S]+)$/i.exec(trimmed);
        const topology = (m ? m[1]!.toLowerCase() : "debate") as "debate" | "supervisor";
        const goal = m ? m[2]! : trimmed;
        const res = await orch.runOrchestration({ topology, goal });
        emitReport(
          ctx,
          "swarm",
          `# Swarm Orchestration Complete (\`${res.runId}\` | ${res.topology})\n- **Waves:** ${res.wavesExecuted} | **Nodes:** ${res.nodes.length} | **Blackboard Facts:** ${res.blackboardFacts.length}\n\n${res.winningSummary ?? ""}`,
          res
        );
      }
    });

    // Slash Command 5: `/plugin`
    pi.registerCommand("plugin", {
      description:
        "Manage external plugins: /plugin [list | audit <dir> | install <dir> | run <cmd> [args] | enable <id> | disable <id>]",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const host = bridge.getPluginHost();
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "list").toLowerCase();

        if (sub === "audit" && parts[1]) {
          const report = host.auditPluginDirectory(parts[1]);
          emitReport(
            ctx,
            "plugin",
            `# Plugin Security Audit (\`${report.pluginId}\`)\n- **Verdict:** \`${report.scanVerdict}\` (allowed=${report.allowed})\n- **Findings (${report.findings.length}):** ${report.findings.join("; ") || "none"}`,
            report,
            report.allowed ? "info" : "error"
          );
          return;
        }
        if (sub === "install" && parts[1]) {
          const installed = await host.installAndLoadPlugin(parts[1]);
          emitReport(
            ctx,
            "plugin",
            `Installed external plugin **\`${installed.id}@${installed.version}\`** (tools=${installed.tools.length}, commands=${installed.commands.length}, activeSchemaDelta=+0 tokens).`,
            installed
          );
          return;
        }
        if (sub === "enable" && parts[1]) {
          const p = await host.enablePlugin(parts[1]);
          emitReport(ctx, "plugin", `Enabled plugin \`${p.id}\`.`, p);
          return;
        }
        if (sub === "disable" && parts[1]) {
          const p = host.disablePlugin(parts[1]);
          emitReport(ctx, "plugin", `Disabled plugin \`${p.id}\`.`, p);
          return;
        }
        if (sub === "run" && parts[1]) {
          const out = await host.invokePluginCommand(parts[1], parts.slice(2).join(" "));
          emitReport(ctx, "plugin", out, { command: parts[1], output: out });
          return;
        }

        const list = host.listPlugins();
        const lines =
          list.length === 0
            ? ["- (no external plugins installed — run `/plugin install <dir>`)"]
            : list.map(
                (p) =>
                  `- **\`${p.id}@${p.version}\`** [${p.enabled ? "ENABLED" : "DISABLED"} | scan=${p.scanVerdict}] tools=${p.tools.map((t) => t.qualifiedName).join(",") || "none"}`
              );
        emitReport(ctx, "plugin", `# Installed External Plugins (${list.length})\n${lines.join("\n")}`, {
          plugins: list
        });
      }
    });

    // Slash Command 6: `/ledger`
    pi.registerCommand("ledger", {
      description:
        "Manage Hash-Chained Self-Learning Ledger: /ledger [list | verify | record <cue> :: <lesson> | rollback <entryId> | materialize]",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const ledger = bridge.getLedger();
        const trimmed = args.trim();

        if (trimmed === "verify") {
          const rep = ledger.verifyIntegrity();
          emitReport(
            ctx,
            "ledger",
            `# Self-Learning Ledger Integrity — ${rep.valid ? "VERIFIED" : "TAMPER DETECTED"}\n- **Entries:** ${rep.totalEntries} (active=${rep.activeEntries}, quarantined=${rep.quarantinedEntries}, rolledBack=${rep.rolledBackEntries})\n- **Tip SHA-256:** \`${rep.headHash.slice(0, 16)}...\`\n- **JSONL Mirror Matches SQLite:** \`${rep.jsonlMatchesDb}\``,
            rep,
            rep.valid ? "info" : "error"
          );
          return;
        }
        if (trimmed.startsWith("record ")) {
          const body = trimmed.slice("record ".length);
          const sepIdx = body.indexOf("::");
          if (sepIdx === -1) {
            emitReport(ctx, "ledger", "Usage: `/ledger record <cue> :: <lesson>`", {}, "warning");
            return;
          }
          const entry = ledger.recordLesson({
            sourceEvent: "manual_operator",
            kind: "experience_cue",
            cue: body.slice(0, sepIdx),
            lesson: body.slice(sepIdx + 2)
          });
          emitReport(
            ctx,
            "ledger",
            `Appended ledger entry **\`${entry.entryId}\`** (seq=${entry.seq}, status=\`${entry.status}\`, hash=\`${entry.entryHash.slice(0, 16)}...\`).`,
            entry
          );
          return;
        }
        if (trimmed.startsWith("rollback ")) {
          const targetId = trimmed.slice("rollback ".length).trim();
          const res = ledger.rollbackEntry(targetId, "operator /ledger rollback");
          emitReport(
            ctx,
            "ledger",
            `Rolled back \`${res.rolledBack.entryId}\` via append-only tombstone \`${res.tombstone.entryId}\` (hash=\`${res.tombstone.entryHash.slice(0, 16)}...\`).`,
            res
          );
          return;
        }
        if (trimmed === "materialize") {
          const mat = ledger.materializeSurfaces({ surfacesDir: bridge.getSurfacesDir() });
          emitReport(
            ctx,
            "ledger",
            `# Ledger Materialized for Next Boot (\`0\` Live Prefix Drift)\n- **EXPERIENCE.md:** ${mat.experienceCount} cues (${mat.experienceTokens}/220 \`o200k_base\` tokens)\n- **REVIEW_RULES.md:** ${mat.reviewRulesCount} rules`,
            mat
          );
          return;
        }

        const entries = ledger.listEntries({ limit: 20 });
        const rep = ledger.verifyIntegrity();
        const lines =
          entries.length === 0
            ? ["- (ledger empty — self-heals, debates, or `/ledger record <cue> :: <lesson>` populate this chain)"]
            : entries.map(
                (e) =>
                  `- **#${e.seq} \`${e.entryId}\`** [${e.status} | ${e.kind} | conf=${e.confidence}] ${e.cue} -> ${e.lesson} (\`${e.entryHash.slice(0, 10)}\`)`
              );
        emitReport(
          ctx,
          "ledger",
          `# Self-Learning Ledger (${entries.length} shown, chainValid=${rep.valid})\n${lines.join("\n")}`,
          { entries, integrity: rep }
        );
      }
    });
  };
}
