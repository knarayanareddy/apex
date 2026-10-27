/**
 * Ring 6 — Deferred `mcp_hub` Specialist Tool + `/mcp` & `/router` Slash Commands
 * (`src/ring6/ring6-extension.ts`).
 *
 * PRESERVED INVARIANTS:
 *  - `mcp_hub` registers with `exposure: "deferred"` (`+0` active schema tokens: `1,073 === 1,073`).
 *  - `/mcp` and `/router` register via `ExtensionAPI.registerCommand` (`+0` active schema tokens).
 *  - `session_shutdown` closes all active MCP transports (`mcpHub.closeAll()`) cleanly.
 */

import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Ring3HarnessInstance } from "../ring3/ring3-extension.ts";
import { ConfinedMcpHub } from "./mcp-confined-hub.ts";
import {
  type ApexAutoRouterConfig,
  ApexProviderRouterController,
  computeSessionUsageTelemetry
} from "./provider-router.ts";

export interface Ring6Options {
  workspaceTrusted?: boolean;
  autoConnectWorkspaceMcp?: boolean;
  autoRouter?: ApexAutoRouterConfig;
}

export const RING6_SLASH_COMMANDS = ["mcp", "router"] as const;

export function createRing6Extension(bridge: {
  getHarness: () => Ring3HarnessInstance | null;
  getMcpHub: () => ConfinedMcpHub;
  getRouter: () => ApexProviderRouterController;
  onCommandOutput?: (commandName: string, markdown: string, details: unknown) => void;
}): ExtensionFactory {
  const McpHubParams = Type.Object({
    action: Type.Union([
      Type.Literal("list_servers"),
      Type.Literal("list_tools"),
      Type.Literal("call_tool"),
      Type.Literal("list_resources"),
      Type.Literal("read_resource"),
      Type.Literal("connect_workspace_config")
    ]),
    serverName: Type.Optional(Type.String({ description: "Connected MCP server name" })),
    toolName: Type.Optional(Type.String({ description: "MCP tool name for call_tool" })),
    args: Type.Optional(
      Type.Record(Type.String(), Type.Unknown(), {
        description: "JSON object arguments for call_tool"
      })
    ),
    uri: Type.Optional(Type.String({ description: "Resource URI for read_resource" })),
    query: Type.Optional(Type.String({ description: "Optional search filter for list_tools" })),
    includePoisoned: Type.Optional(
      Type.Boolean({ description: "Include skills-guard-v10 quarantined MCP tools in listing" })
    )
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

    // Register deferred `mcp_hub` specialist tool (+0 active schema tokens!)
    pi.registerTool({
      name: "mcp_hub",
      label: "Confined MCP Hub",
      description:
        "Discover and invoke tools or read resources from connected Model Context Protocol (MCP) servers with skills-guard-v10 poisoning protection and secret scrubbing.",
      parameters: McpHubParams,
      exposure: "deferred",
      async execute(
        toolCallId,
        params
      ): Promise<{ content: Array<TextContent | ImageContent>; details: unknown }> {
        const hub = bridge.getMcpHub();
        switch (params.action) {
          case "list_servers": {
            const servers = hub.listServers();
            return {
              content: [{ type: "text", text: JSON.stringify({ servers }, null, 2) }],
              details: { servers }
            };
          }
          case "list_tools": {
            const tools = hub.listTools({
              serverName: params.serverName,
              query: params.query,
              includePoisoned: params.includePoisoned
            });
            return {
              content: [{ type: "text", text: JSON.stringify({ tools }, null, 2) }],
              details: { tools }
            };
          }
          case "call_tool": {
            if (!params.serverName || !params.toolName) {
              throw new Error("mcp_hub call_tool requires both serverName and toolName.");
            }
            const res = await hub.callTool({
              serverName: params.serverName,
              toolName: params.toolName,
              args: params.args,
              toolCallId
            });
            return {
              content: res.content,
              details: {
                serverName: res.serverName,
                toolName: res.toolName,
                isError: res.isError
              }
            };
          }
          case "list_resources": {
            if (!params.serverName) {
              throw new Error("mcp_hub list_resources requires serverName.");
            }
            const resources = await hub.listResources(params.serverName);
            return {
              content: [{ type: "text", text: JSON.stringify({ resources }, null, 2) }],
              details: { resources }
            };
          }
          case "read_resource": {
            if (!params.serverName || !params.uri) {
              throw new Error("mcp_hub read_resource requires serverName and uri.");
            }
            const resource = await hub.readResource({
              serverName: params.serverName,
              uri: params.uri
            });
            return {
              content: [{ type: "text", text: JSON.stringify(resource, null, 2) }],
              details: resource
            };
          }
          case "connect_workspace_config": {
            const connected = await hub.connectWorkspaceConfigServers();
            return {
              content: [{ type: "text", text: JSON.stringify({ connected }, null, 2) }],
              details: { connected }
            };
          }
        }
      }
    });

    // Slash Command 8: `/mcp [status | tools [query] | connect-stdio <name> <cmd> [args...] | disconnect <name> | resources <server>]`
    pi.registerCommand("mcp", {
      description:
        "Inspect connected @earendil-works/pi-mcp servers, audit skills-guard-v10 tool scans, or connect/disconnect servers",
      getArgumentCompletions: (prefix) => {
        const opts = ["status", "tools", "connect-stdio ", "disconnect ", "resources "];
        return opts
          .filter((o) => o.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value.trim() }));
      },
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const hub = bridge.getMcpHub();
        const parts = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
        const sub = (parts[0] ?? "status").toLowerCase();

        if (sub === "status" || sub === "servers") {
          const servers = hub.listServers();
          const lines = [
            `# Confined MCP Hub Status (workspaceTrusted=${hub.isWorkspaceTrusted()})`,
            servers.length === 0
              ? "- No MCP servers currently connected."
              : servers
                  .map(
                    (s) =>
                      `- **${s.name}** [${s.transportKind} | ${s.source}] tools=${s.safeTools} safe / ${s.poisonedTools} poisoned (instructions=${s.instructionsVerdict})`
                  )
                  .join("\n")
          ];
          emitReport(ctx, "mcp", lines.join("\n"), {
            workspaceTrusted: hub.isWorkspaceTrusted(),
            servers
          });
          return;
        }

        if (sub === "tools") {
          const query = parts.slice(1).join(" ") || undefined;
          const tools = hub.listTools({ query, includePoisoned: true });
          const lines = [
            `# Audited MCP Tools (${tools.length})`,
            ...(tools.length === 0
              ? ["- (none)"]
              : tools.map(
                  (t) =>
                    `- \`${t.serverName}/${t.name}\` [scan=${t.scanVerdict}${t.poisoned ? " BLOCKED" : ""}] — ${t.description}`
                ))
          ];
          emitReport(ctx, "mcp", lines.join("\n"), { tools });
          return;
        }

        if (sub === "connect-stdio") {
          const name = parts[1];
          const command = parts[2];
          const args = parts.slice(3);
          if (!name || !command) {
            emitReport(
              ctx,
              "mcp",
              "Usage: `/mcp connect-stdio <name> <command> [args...]`",
              { error: "missing_args" },
              "warning"
            );
            return;
          }
          const summary = await hub.connectStdioServer({
            name,
            command,
            args,
            source: "operator"
          });
          emitReport(
            ctx,
            "mcp",
            `Connected MCP server \`${summary.name}\` (${summary.safeTools} safe tools, ${summary.poisonedTools} poisoned blocked).`,
            summary
          );
          return;
        }

        if (sub === "disconnect") {
          const name = parts[1];
          if (!name) {
            emitReport(ctx, "mcp", "Usage: `/mcp disconnect <name>`", { error: "missing_name" }, "warning");
            return;
          }
          const removed = await hub.disconnectServer(name);
          emitReport(
            ctx,
            "mcp",
            removed ? `Disconnected MCP server \`${name}\`.` : `MCP server \`${name}\` was not connected.`,
            { name, removed }
          );
          return;
        }

        if (sub === "resources") {
          const serverName = parts[1];
          if (!serverName) {
            emitReport(ctx, "mcp", "Usage: `/mcp resources <serverName>`", { error: "missing_server" }, "warning");
            return;
          }
          const resources = await hub.listResources(serverName);
          emitReport(
            ctx,
            "mcp",
            `# MCP Resources on \`${serverName}\` (${resources.length})\n` +
              (resources.length === 0
                ? "- (none)"
                : resources.map((r) => `- \`${r.uri}\` (${r.name})`).join("\n")),
            { serverName, resources }
          );
          return;
        }

        emitReport(
          ctx,
          "mcp",
          "Unknown `/mcp` subcommand. Supported: `status`, `tools`, `connect-stdio`, `disconnect`, `resources`.",
          { sub },
          "warning"
        );
      }
    });

    // Slash Command 9: `/router [status | use-auto | ollama <modelId> [baseUrl] | usage]`
    pi.registerCommand("router", {
      description:
        "Inspect or configure the cache-preserving apex/auto virtual model router, local Ollama models, and prompt-cache telemetry",
      getArgumentCompletions: (prefix) => {
        const opts = ["status", "use-auto", "ollama ", "usage"];
        return opts
          .filter((o) => o.startsWith(prefix.toLowerCase()))
          .map((value) => ({ value, label: value.trim() }));
      },
      handler: async (rawArgs: string, ctx: ExtensionCommandContext) => {
        const h = bridge.getHarness();
        const router = bridge.getRouter();
        const parts = rawArgs.trim() ? rawArgs.trim().split(/\s+/) : [];
        const sub = (parts[0] ?? "status").toLowerCase();

        if (sub === "status" || sub === "usage") {
          const targets = router.getAutoTargets();
          const usage = computeSessionUsageTelemetry(
            (h?.session.state.messages ?? []) as ReadonlyArray<{ role?: string }>
          );
          const curModel = h?.session.model
            ? `${h.session.model.provider}/${h.session.model.id}`
            : "none";
          const report = [
            `# Apex Model Router & Prompt-Cache Telemetry`,
            `- **Active Session Model**: \`${curModel}\``,
            `- **\`apex/auto\` Targets**: planning=\`${targets.planningModel ? `${targets.planningModel.provider}/${targets.planningModel.id}` : "catalog-default"}\` -> implementation=\`${targets.implementationModel ? `${targets.implementationModel.provider}/${targets.implementationModel.id}` : "catalog-fast"}\``,
            `- **Prompt-Cache Hit Rate**: ${usage.cacheHitRatePct}% (cacheRead=${usage.cacheReadTokens}, input=${usage.inputTokens}, output=${usage.outputTokens})`,
            `- **Cumulative Session Cost**: $${usage.totalCostUsd.toFixed(6)} across ${usage.assistantTurns} assistant turn(s)`
          ].join("\n");
          emitReport(ctx, "router", report, {
            activeModel: curModel,
            targets,
            usage,
            routeHistory: router.getRouteHistory()
          });
          return;
        }

        if (sub === "use-auto") {
          if (!h) throw new Error("Harness not ready.");
          const autoModel = h.modelRuntime.getModel("apex", "auto");
          if (!autoModel) throw new Error("Virtual model apex/auto is not registered.");
          await h.session.setModel(autoModel);
          emitReport(
            ctx,
            "router",
            "Switched active session model to `apex/auto` (Plan-Strong -> Implement-Fast, max 1 cache transition per branch).",
            { activeModel: "apex/auto" }
          );
          return;
        }

        if (sub === "ollama") {
          const modelId = parts[1] ?? "qwen2.5-coder:32b";
          const baseUrl = parts[2];
          const reg = await router.registerLocalOllamaProvider({
            baseUrl,
            models: [{ id: modelId }]
          });
          emitReport(
            ctx,
            "router",
            `Registered local Ollama model \`${reg.registeredModels[0]}\` (${reg.baseUrl}).`,
            reg
          );
          return;
        }

        emitReport(
          ctx,
          "router",
          "Unknown `/router` subcommand. Supported: `status`, `use-auto`, `ollama <modelId> [baseUrl]`, `usage`.",
          { sub },
          "warning"
        );
      }
    });
  };
}
