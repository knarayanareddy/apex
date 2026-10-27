/**
 * Ring 10 — Deferred `onboarding_status` Specialist Tool + `/setup` Zero-Token Operator Slash Command
 * (`src/ring10/ring10-extension.ts`).
 *
 * PRESERVED INVARIANTS:
 * - `onboarding_status` registers with `exposure: "deferred"` (`+0` active schema tokens: `1,073 === 1,073`).
 * - `onboarding_status` exposes ONLY masked readiness status — raw keys never enter QuickJS `codemode`.
 * - `/setup` registers via `ExtensionAPI.registerCommand` (`+0` active schema tokens, `0` prefix drift).
 */

import type { TextContent } from "@earendil-works/pi-ai";
import type {
  ExtensionCommandContext,
  ExtensionContext,
  ExtensionFactory
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { OnboardingVault } from "./onboarding-vault.ts";

export const RING10_SLASH_COMMANDS = ["setup"] as const;

export function createRing10Extension(bridge: {
  getOnboardingVault: () => OnboardingVault;
  onCommandOutput?: (commandName: string, markdown: string, details: unknown) => void;
}): ExtensionFactory {
  const OnboardingStatusParams = Type.Object({
    action: Type.Union([Type.Literal("status"), Type.Literal("discover_ollama")]),
    ollamaHostUrl: Type.Optional(
      Type.String({ description: "Optional local Ollama URL (default http://127.0.0.1:11434)" })
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

    pi.registerTool({
      name: "onboarding_status",
      label: "Onboarding Readiness & Local Ollama Auto-Discovery",
      description:
        "Inspect masked provider/channel readiness or auto-discover local Ollama models without exposing raw API keys.",
      parameters: OnboardingStatusParams,
      exposure: "deferred",
      async execute(_toolCallId, params) {
        const vault = bridge.getOnboardingVault();
        const payload =
          params.action === "discover_ollama"
            ? await vault.discoverAndRegisterOllama({ ollamaHostUrl: params.ollamaHostUrl })
            : vault.getVaultStatus();
        const content: TextContent[] = [{ type: "text", text: JSON.stringify(payload, null, 2) }];
        return { content, details: payload };
      }
    });

    pi.registerCommand("setup", {
      description:
        "1-Click Onboarding Vault: /setup [status | key <provider> <apiKey> | ollama [url]]",
      handler: async (args: string, ctx: ExtensionCommandContext) => {
        const vault = bridge.getOnboardingVault();
        const parts = args.trim().split(/\s+/).filter(Boolean);
        const sub = (parts[0] ?? "status").toLowerCase();

        if (sub === "key" && parts[1] && parts[2]) {
          const saved = await vault.saveProviderKey(parts[1], parts[2]);
          emitReport(
            ctx,
            "setup",
            `Saved **${saved.provider}** key (\`${saved.maskedKey}\`) into \`0600\` vault and activated in \`ModelRuntime\`.`,
            saved
          );
          return;
        }

        if (sub === "ollama") {
          const disc = await vault.discoverAndRegisterOllama({ ollamaHostUrl: parts[1] });
          emitReport(
            ctx,
            "setup",
            `# Local Ollama Auto-Discovery (${disc.ollamaHostUrl})\n- **Discovered Models (${disc.discoveredModels.length}):** \`${disc.discoveredModels.join(", ")}\`\n- **Bound \`apex/auto\`:** \`${disc.boundAutoTargets?.planning}\` -> \`${disc.boundAutoTargets?.implementation}\``,
            disc
          );
          return;
        }

        const st = vault.getVaultStatus();
        const provLines = st.providers
          .filter((p) => p.configured)
          .map((p) => `- **${p.label}:** \`${p.maskedKey}\``);
        const chanLines = st.channels
          .filter((c) => c.configured)
          .map((c) => `- **${c.platform}:** \`${c.maskedSummary}\``);

        emitReport(
          ctx,
          "setup",
          [
            `# Pi-Apex Personal Onboarding Vault (Readiness: ${st.readinessScorePct}%, Mode: \`${st.fileModeOctal}\`)`,
            `- **Cloud Providers Configured (${provLines.length}):**`,
            ...(provLines.length > 0 ? provLines : ["  - (none yet — run `/setup key anthropic sk-ant-...` or click Quick Setup in Studio)"]),
            `- **Local Ollama (\`${st.ollama.baseUrl}\`):** ${st.ollama.configured ? st.ollama.discoveredModels.join(", ") : "not probed yet (`/setup ollama`)"}`,
            `- **Messaging Channels Configured (${chanLines.length}):**`,
            ...(chanLines.length > 0 ? chanLines : ["  - (use Quick Setup drawer or `/gateway whatsapp`) "])
          ].join("\n"),
          st
        );
      }
    });
  };
}
