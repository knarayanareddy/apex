/**
 * Ring 4, Ring 6 & Ring 7 — `AgentSessionRuntime` Host Bridge & Unified Ring 0–7 Harness Composer
 * (`src/ring4/ring4-runtime.ts`).
 *
 * UPSTREAM OSS PROVENANCE:
 *  - `@earendil-works/pi-coding-agent@1.4.0` (`createAgentSessionRuntime`, `AgentSessionRuntime`,
 *    `SessionManager`, `ModelRuntime`, `resolveCliModel`, MIT)
 *  - `@earendil-works/pi-mcp@1.4.0` (`McpClient`, `StdioTransport`, `StreamableHttpTransport`, MIT).
 *
 * LIFECYCLE GUARANTEES:
 *  - Composes `createRing3Harness` + `createRing4SlashCommandsExtension` + `createRing6Extension`
 *    + `createRing7Extension` (`+0` active schema tokens: `1,073 === 1,073 o200k_base` tokens;
 *    `0` live static-prefix SHA-256 drift across all 14 deferred tools & 13 slash commands).
 *  - Hooks `session_shutdown` idempotently so `runtimeHost.newSession()`, `switchSession()`,
 *    `switchWorkspace()`, `fork()`, and `dispose()` cleanly close `ConfinedMcpHub`,
 *    `AgentBrowserController.closeCdp()`, `PtyLeaseManager`, `WorktreeSubagentPool`,
 *    `LspClientManager`, and `StateDb` BEFORE a replacement session opens `.harness/state.db`!
 */

import fs from "node:fs";
import path from "node:path";
import {
  type AgentSessionRuntime,
  type AgentSessionServices,
  createAgentSessionRuntime,
  type CreateAgentSessionRuntimeFactory,
  type ExtensionFactory,
  getAgentDir,
  ModelRuntime,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import type { Ring0HarnessOptions } from "../core/ring0-session.ts";
import { GuardDeniedError } from "../core/monotonic-guard.ts";
import type { Ring1Options } from "../ring1/ring1-extension.ts";
import type { Ring2Options } from "../ring2/ring2-extension.ts";
import {
  createRing3Harness,
  type Ring3HarnessInstance,
  type Ring3Options
} from "../ring3/ring3-extension.ts";
import { ConfinedMcpHub } from "../ring6/mcp-confined-hub.ts";
import { ApexProviderRouterController } from "../ring6/provider-router.ts";
import {
  createRing6Extension,
  RING6_SLASH_COMMANDS,
  type Ring6Options
} from "../ring6/ring6-extension.ts";
import { AutonomousPrPipeline } from "../ring7/autonomous-pr-pipeline.ts";
import {
  BookmarkController,
  HandoffController,
  PresetController
} from "../ring7/handoff-presets-bookmarks.ts";
import {
  createRing7Extension,
  RING7_SLASH_COMMANDS,
  type Ring7Options
} from "../ring7/ring7-extension.ts";
import { GitHubIssueBridge } from "../ring8/github-issue-bridge.ts";
import {
  createRing8Extension,
  RING8_SLASH_COMMANDS,
  type Ring8Options
} from "../ring8/ring8-extension.ts";
import { ExternalPluginHost } from "../ring9/external-plugin-host.ts";
import { OmniChannelGateway } from "../ring9/messaging-gateway.ts";
import { MultiAgentOrchestrator } from "../ring9/multi-agent-orchestrator.ts";
import {
  createRing9Extension,
  RING9_SLASH_COMMANDS,
  type Ring9Options
} from "../ring9/ring9-extension.ts";
import { SelfLearningLedger } from "../ring9/self-learning-ledger.ts";
import { OnboardingVault } from "../ring10/onboarding-vault.ts";
import { ProviderManager } from "../ring10/provider-manager.ts";
import { installSafeNetworkDispatcher } from "../ring10/safe-network.ts";
import {
  createRing10Extension,
  RING10_SLASH_COMMANDS
} from "../ring10/ring10-extension.ts";
import { ExecutionModeController } from "../ring11/execution-mode-controller.ts";
import { loadVerifiedGuardrails } from "../core/guardrail-pin.ts";
import { createRing13Extension } from "../ring13/ring13-extension.ts";
import { SpeechIoService } from "../ring11/speech-io.ts";
import { createRing11Extension, RING11_SLASH_COMMANDS } from "../ring11/ring11-extension.ts";
import {
  createRing4SlashCommandsExtension,
  RING4_SLASH_COMMANDS
} from "./slash-commands-extension.ts";

export interface Ring4Options {
  onCommandOutput?: (commandName: string, markdown: string, details: unknown) => void;
}

export const ALL_APEX_SLASH_COMMANDS = [
  ...RING4_SLASH_COMMANDS,
  ...RING6_SLASH_COMMANDS,
  ...RING7_SLASH_COMMANDS,
  ...RING8_SLASH_COMMANDS,
  ...RING9_SLASH_COMMANDS,
  ...RING10_SLASH_COMMANDS,
  ...RING11_SLASH_COMMANDS
] as const;

export interface Ring4HarnessInstance extends Ring3HarnessInstance {
  readonly registeredSlashCommands: readonly string[];
  readonly mcpHub: ConfinedMcpHub;
  readonly routerController: ApexProviderRouterController;
  readonly prPipeline: AutonomousPrPipeline;
  readonly handoffController: HandoffController;
  readonly presetController: PresetController;
  readonly bookmarkController: BookmarkController;
  readonly issueBridge: GitHubIssueBridge;
  readonly gateway: OmniChannelGateway;
  readonly orchestrator: MultiAgentOrchestrator;
  readonly pluginHost: ExternalPluginHost;
  readonly learningLedger: SelfLearningLedger;
  readonly onboardingVault: OnboardingVault;
  readonly providerManager: ProviderManager;
  readonly interactionController: ExecutionModeController;
  readonly speechIo: SpeechIoService;
}

export type FullApexHarnessOptions = Ring0HarnessOptions & {
  ring1?: Ring1Options;
  ring2?: Ring2Options;
  ring3?: Ring3Options;
  ring4?: Ring4Options;
  ring6?: Ring6Options;
  ring7?: Ring7Options;
  ring8?: Ring8Options;
  ring9?: Ring9Options;
};

export async function createRing4Harness(
  opts: FullApexHarnessOptions
): Promise<Ring4HarnessInstance> {
  installSafeNetworkDispatcher();
  const resolvedWs = path.resolve(opts.workspaceRoot);
  const ring13Guardrails = loadVerifiedGuardrails(opts.guardrailsPath, opts.expectedGuardrailsSha256).config;
  const resolvedAgentDir = opts.agentDir ?? getAgentDir();

  // Ensure shared ModelRuntime exists so ApexProviderRouterController can register `apex/auto`
  const sharedModelRuntime =
    opts.modelRuntime ??
    (await ModelRuntime.create({
      authPath: path.join(resolvedAgentDir, "auth.json"),
      modelsPath: path.join(resolvedAgentDir, "models.json"),
      refreshOnCreate: false
    }));

  const routerController = new ApexProviderRouterController(
    sharedModelRuntime,
    opts.ring6?.autoRouter
  );

  const handoffController = new HandoffController();
  const presetController = new PresetController({
    cwd: resolvedWs,
    agentDir: resolvedAgentDir
  });
  const bookmarkController = new BookmarkController();

  const workspaceTrusted = opts.ring6?.workspaceTrusted ?? true;

  let activeHarnessRef: Ring3HarnessInstance | null = null;
  let mcpHubRef: ConfinedMcpHub | null = null;
  let prPipelineRef: AutonomousPrPipeline | null = null;
  let issueBridgeRef: GitHubIssueBridge | null = null;
  let gatewayRef: OmniChannelGateway | null = null;
  let orchestratorRef: MultiAgentOrchestrator | null = null;
  let pluginHostRef: ExternalPluginHost | null = null;
  let learningLedgerRef: SelfLearningLedger | null = null;
  let onboardingVaultRef: OnboardingVault | null = null;
  let providerManagerRef: ProviderManager | null = null;
  let speechIoRef: SpeechIoService | null = null;
  const interactionController = new ExecutionModeController({ workspaceRoot: resolvedWs, auditPath: path.join(resolvedAgentDir, "interaction-audit.jsonl") });
  let auxDisposed = false;

  const getOrCreateMcpHub = (): ConfinedMcpHub => {
    if (!mcpHubRef) {
      mcpHubRef = new ConfinedMcpHub({
        workspaceRoot: resolvedWs,
        workspaceTrusted,
        spillStore: activeHarnessRef?.spillStore
      });
    }
    return mcpHubRef;
  };

  const getPrPipeline = (): AutonomousPrPipeline => {
    if (!prPipelineRef) {
      throw new Error("AutonomousPrPipeline not initialized yet.");
    }
    return prPipelineRef;
  };

  const getIssueBridge = (): GitHubIssueBridge => {
    if (!issueBridgeRef) {
      issueBridgeRef = new GitHubIssueBridge({
        workspaceRoot: resolvedWs,
        db: activeHarnessRef?.stateDb.db,
        defaultApiBaseUrl: opts.ring8?.githubApiBaseUrl
      });
    }
    return issueBridgeRef;
  };

  const disposeAuxOnce = async () => {
    if (auxDisposed || !activeHarnessRef) return;
    auxDisposed = true;
    const h = activeHarnessRef;
    if (mcpHubRef) {
      await mcpHubRef.closeAll().catch(() => {});
    }
    await h.browserController.closeCdp().catch(() => {});
    h.ptyManager.dispose();
    h.subagentPool.dispose();
    await h.lspManager.shutdownAll().catch(() => {});
    try {
      h.stateDb.close();
    } catch {
      // already closed
    }
  };

  const lifecycleCleanupExtension: ExtensionFactory = (pi) => {
    pi.on("session_shutdown", async () => {
      await disposeAuxOnce();
    });
  };

  const slashExtension = createRing4SlashCommandsExtension({
    getHarness: () => activeHarnessRef,
    getWorkspaceRoot: () => resolvedWs,
    getGuardrailsPath: () => opts.guardrailsPath,
    getExpectedGuardrailsSha256: () => opts.expectedGuardrailsSha256,
    onCommandOutput: opts.ring4?.onCommandOutput
  });

  const ring6Extension = createRing6Extension({
    getHarness: () => activeHarnessRef,
    getMcpHub: () => getOrCreateMcpHub(),
    getRouter: () => routerController,
    onCommandOutput: opts.ring4?.onCommandOutput
  });

  const ring7Extension = createRing7Extension({
    getHarness: () => activeHarnessRef,
    getWorkspaceRoot: () => resolvedWs,
    getPrPipeline: () => getPrPipeline(),
    getHandoffController: () => handoffController,
    getPresetController: () => presetController,
    getBookmarkController: () => bookmarkController,
    onCommandOutput: opts.ring4?.onCommandOutput
  });

  const ring8Extension = createRing8Extension({
    getWorkspaceRoot: () => resolvedWs,
    getSurfacesDir: () => opts.surfacesDir,
    getIssueBridge: () => getIssueBridge(),
    onCommandOutput: opts.ring4?.onCommandOutput
  });

  const ring9Extension = createRing9Extension({
    getSurfacesDir: () => opts.surfacesDir,
    getAllSlashCommands: () => ALL_APEX_SLASH_COMMANDS,
    getGateway: () => {
      if (!gatewayRef) throw new Error("OmniChannelGateway not initialized yet.");
      return gatewayRef;
    },
    getOrchestrator: () => {
      if (!orchestratorRef) throw new Error("MultiAgentOrchestrator not initialized yet.");
      return orchestratorRef;
    },
    getPluginHost: () => {
      if (!pluginHostRef) throw new Error("ExternalPluginHost not initialized yet.");
      return pluginHostRef;
    },
    getLedger: () => {
      if (!learningLedgerRef) throw new Error("SelfLearningLedger not initialized yet.");
      return learningLedgerRef;
    },
    onCommandOutput: opts.ring4?.onCommandOutput
  });

  const ring10Extension = createRing10Extension({
    getOnboardingVault: () => {
      if (!onboardingVaultRef) throw new Error("OnboardingVault not initialized yet.");
      return onboardingVaultRef;
    },
    onCommandOutput: opts.ring4?.onCommandOutput
  });

  const ring11Extension = createRing11Extension({
    getSpeech: () => { if (!speechIoRef) throw new Error("SpeechIoService not initialized yet."); return speechIoRef; },
    getInteraction: () => interactionController
  });
  const ring13Extension = createRing13Extension({
    getWorkspaceRoot: () => resolvedWs,
    guardrails: ring13Guardrails,
    beforeAction: (tool, summary) => interactionController.beforeAction(tool, summary)
  });

  const ring3 = await createRing3Harness({
    ...opts,
    beforeAction: (tool, summary) => interactionController.beforeAction(tool, summary),
    modelRuntime: sharedModelRuntime,
    extraExtensions: [
      slashExtension,
      ring6Extension,
      ring7Extension,
      ring8Extension,
      ring9Extension,
      ring10Extension,
      ring11Extension,
      ring13Extension,
      lifecycleCleanupExtension,
      ...(opts.extraExtensions ?? [])
    ]
  });
  activeHarnessRef = ring3;

  // Bind SpillStore onto ConfinedMcpHub now that Ring 0 SpillStore is live
  mcpHubRef = new ConfinedMcpHub({
    workspaceRoot: resolvedWs,
    workspaceTrusted,
    spillStore: ring3.spillStore
  });

  issueBridgeRef = new GitHubIssueBridge({
    workspaceRoot: resolvedWs,
    db: ring3.stateDb.db,
    defaultApiBaseUrl: opts.ring8?.githubApiBaseUrl
  });

  learningLedgerRef = new SelfLearningLedger({
    workspaceRoot: resolvedWs,
    db: ring3.stateDb.db,
    durabilityMode: opts.durabilityMode ?? "crash-safe"
  });

  gatewayRef = new OmniChannelGateway({
    workspaceRoot: resolvedWs,
    db: ring3.stateDb.db,
    initialAllowedSenders: opts.ring9?.gatewayAllowedSenders,
    turnHandler: async ({ formattedPrompt }) => {
      const beforeLen = ring3.session.messages.length;
      await ring3.session.prompt(formattedPrompt);
      const added = ring3.session.messages.slice(beforeLen);
      for (let i = added.length - 1; i >= 0; i--) {
        const m = added[i] as unknown as Record<string, unknown>;
        if (m["role"] === "assistant" && Array.isArray(m["content"])) {
          const text = (m["content"] as Array<Record<string, unknown>>)
            .filter((b) => b["type"] === "text")
            .map((b) => String(b["text"] ?? ""))
            .join("\n")
            .trim();
          if (text) return text;
        }
        if (m["role"] === "custom" && typeof m["content"] === "string" && m["content"].trim()) {
          return m["content"].trim();
        }
      }
      return "Turn completed.";
    }
  });

  orchestratorRef = new MultiAgentOrchestrator({
    workspaceRoot: resolvedWs,
    getSubagentPool: () => ring3.subagentPool,
    getLedger: () => learningLedgerRef!,
    durabilityMode: opts.durabilityMode ?? "crash-safe"
  });

  pluginHostRef = new ExternalPluginHost({
    workspaceRoot: resolvedWs,
    getGateway: () => gatewayRef!,
    sandboxMode: opts.sandboxMode ?? "workspace-write",
    isPlanModeActive: () => ring3.trustArtifacts.isPlanModeActive(),
    mutationAdmission: {
      assertAllowed: (action: string) => {
        if ((opts.sandboxMode ?? "workspace-write") === "read-only") {
          throw new GuardDeniedError(`ExternalPluginHost: cannot ${action} in read-only sandbox mode`);
        }
        if (ring3.trustArtifacts.isPlanModeActive()) {
          throw new GuardDeniedError(`ExternalPluginHost: cannot ${action} while Plan Mode is active`);
        }
      }
    }
  });

  onboardingVaultRef = new OnboardingVault({
    agentDir: resolvedAgentDir,
    getModelRuntime: () => ring3.modelRuntime,
    getRouter: () => routerController,
    getGateway: () => gatewayRef!
  });
  await onboardingVaultRef.applyStoredVaultToRuntime();
  providerManagerRef = new ProviderManager({ agentDir: resolvedAgentDir, modelRuntime: ring3.modelRuntime, vault: onboardingVaultRef });
  await providerManagerRef.restore();
  speechIoRef = new SpeechIoService({
    vault: onboardingVaultRef,
    agentDir: resolvedAgentDir,
    cloudBaseUrl: process.env.PI_APEX_OPENAI_AUDIO_BASE_URL,
    localSttBinary: process.env.PI_APEX_WHISPER_CPP_BIN,
    localSttModel: process.env.PI_APEX_WHISPER_CPP_MODEL,
    localTtsBinary: process.env.PI_APEX_PIPER_BIN,
    localTtsModel: process.env.PI_APEX_PIPER_MODEL
  });

  prPipelineRef = new AutonomousPrPipeline({
    workspaceRoot: resolvedWs,
    db: ring3.stateDb.db,
    trustArtifacts: ring3.trustArtifacts,
    subagentPool: ring3.subagentPool,
    bugBotCi: ring3.bugBotCi,
    durabilityMode: opts.durabilityMode ?? "crash-safe",
    sandboxMode: opts.sandboxMode ?? "workspace-write",
    modelRuntime: ring3.modelRuntime,
    getActiveModel: () => ring3.session.model,
    issueBridge: issueBridgeRef,
    learningLedger: learningLedgerRef,
    experienceSurfacePath: path.join(path.resolve(opts.surfacesDir), "EXPERIENCE.md")
  });

  if (opts.ring7?.initialPreset) {
    await presetController.applyPresetToSession(
      opts.ring7.initialPreset,
      ring3.session,
      ring3.modelRuntime
    );
  }

  await mcpHubRef.restorePersistedRemoteServers();
  if (opts.ring6?.autoConnectWorkspaceMcp) {
    await mcpHubRef.connectWorkspaceConfigServers();
  }

  return {
    ...ring3,
    registeredSlashCommands: ALL_APEX_SLASH_COMMANDS,
    mcpHub: mcpHubRef,
    routerController,
    prPipeline: prPipelineRef,
    handoffController,
    presetController,
    bookmarkController,
    issueBridge: issueBridgeRef,
    gateway: gatewayRef,
    orchestrator: orchestratorRef,
    pluginHost: pluginHostRef,
    learningLedger: learningLedgerRef,
    onboardingVault: onboardingVaultRef,
    providerManager: providerManagerRef!,
    interactionController,
    speechIo: speechIoRef,
    dispose() {
      if (mcpHubRef) {
        void mcpHubRef.closeAll().catch(() => {});
      }
      void ring3.browserController.closeCdp().catch(() => {});
      ring3.ptyManager.dispose();
      ring3.subagentPool.dispose();
      void ring3.lspManager.shutdownAll().catch(() => {});
      if (!auxDisposed) {
        auxDisposed = true;
        ring3.dispose();
      } else {
        ring3.session.dispose();
      }
    },
    async disposeAsync() {
      await disposeAuxOnce();
      ring3.session.dispose();
    }
  };
}

export interface Ring4RuntimeController {
  readonly runtimeHost: AgentSessionRuntime;
  getCurrentHarness(): Ring4HarnessInstance;
  getActiveWorkspaceRoot(): string;
  listWorkspaces(): Array<{ path: string; active: boolean }>;
  registerWorkspace(workspaceRoot: string): string;
  switchWorkspace(workspaceRoot: string): Promise<{
    workspaceRoot: string;
    sessionId: string;
    cancelled: boolean;
  }>;
  onHarnessSwitch(listener: (harness: Ring4HarnessInstance) => void): () => void;
  dispose(): Promise<void>;
}

/**
 * Wraps `createRing4Harness` inside `@earendil-works/pi-coding-agent`'s `AgentSessionRuntime`,
 * powering `InteractiveMode` (`@earendil-works/pi-tui`), `runPrintMode` (`text` & `json`),
 * `runRpcMode` (`RpcClient`), `MissionControlServer` (`--web`), live `/new` / `/resume` / `/fork`,
 * and Ring 7 multi-repo `switchWorkspace()`.
 */
export async function createRing4Runtime(
  opts: Omit<FullApexHarnessOptions, "workspaceRoot"> & {
    workspaceRoot?: string;
    surfacesDir: string;
  }
): Promise<Ring4RuntimeController> {
  let activeWorkspaceRoot = path.resolve(opts.workspaceRoot ?? process.cwd());
  const registeredWorkspaces = new Set<string>([activeWorkspaceRoot]);
  const agentDir = opts.agentDir ?? getAgentDir();
  const initialSessionManager =
    opts.sessionManager ??
    SessionManager.create(
      activeWorkspaceRoot,
      path.join(activeWorkspaceRoot, ".harness", "sessions")
    );

  let currentHarness: Ring4HarnessInstance | null = null;
  const switchListeners = new Set<(harness: Ring4HarnessInstance) => void>();

  const createRuntime: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir: runtimeAgentDir,
    sessionManager,
    sessionStartEvent
  }) => {
    const resolvedCwd = path.resolve(cwd);
    activeWorkspaceRoot = resolvedCwd;
    registeredWorkspaces.add(resolvedCwd);

    const harness = await createRing4Harness({
      ...opts,
      workspaceRoot: resolvedCwd,
      agentDir: runtimeAgentDir,
      sessionManager,
      sessionStartEvent,
      // Reuse modelRuntime across `/new`, `/resume` & `switchWorkspace` so credentials/Ollama/`apex/auto` persist!
      modelRuntime: currentHarness?.modelRuntime ?? opts.modelRuntime
    });
    const isReplacement = currentHarness !== null;
    currentHarness = harness;
    if (isReplacement) {
      for (const listener of switchListeners) {
        listener(harness);
      }
    }

    const services: AgentSessionServices = {
      cwd: resolvedCwd,
      agentDir: harness.agentDir,
      modelRuntime: harness.modelRuntime,
      settingsManager: harness.settingsManager,
      resourceLoader: harness.resourceLoader,
      diagnostics: []
    };

    return {
      session: harness.session,
      extensionsResult: harness.extensionsResult,
      modelFallbackMessage: harness.modelFallbackMessage,
      services,
      diagnostics: []
    };
  };

  const runtimeHost = await createAgentSessionRuntime(createRuntime, {
    cwd: activeWorkspaceRoot,
    agentDir,
    sessionManager: initialSessionManager
  });

  return {
    runtimeHost,
    getCurrentHarness(): Ring4HarnessInstance {
      if (!currentHarness) {
        throw new Error("No active Ring 4–7 harness instance.");
      }
      return currentHarness;
    },
    getActiveWorkspaceRoot(): string {
      return activeWorkspaceRoot;
    },
    listWorkspaces(): Array<{ path: string; active: boolean }> {
      return [...registeredWorkspaces].map((p) => ({
        path: p,
        active: p === activeWorkspaceRoot
      }));
    },
    registerWorkspace(workspaceRoot: string): string {
      const resolved = path.resolve(workspaceRoot);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`WORKSPACE_NOT_FOUND: '${resolved}' is not an existing directory.`);
      }
      registeredWorkspaces.add(resolved);
      return resolved;
    },
    async switchWorkspace(workspaceRoot: string) {
      const resolved = path.resolve(workspaceRoot);
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
        throw new Error(`WORKSPACE_NOT_FOUND: '${resolved}' is not an existing directory.`);
      }
      registeredWorkspaces.add(resolved);
      const targetSessionDir = path.join(resolved, ".harness", "sessions");
      fs.mkdirSync(targetSessionDir, { recursive: true });
      const existing = await SessionManager.list(resolved, targetSessionDir);
      let targetSessionFile: string | undefined = existing[0]?.path;
      if (!targetSessionFile) {
        const bootstrapSm = SessionManager.create(resolved, targetSessionDir);
        bootstrapSm.appendSessionInfo(`Workspace: ${path.basename(resolved)}`);
        bootstrapSm.appendMessage({
          role: "user",
          content: [{ type: "text", text: `Initialized workspace session for ${path.basename(resolved)}.` }],
          timestamp: Date.now()
        });
        targetSessionFile = bootstrapSm.getSessionFile();
      }
      if (!targetSessionFile) {
        throw new Error("WORKSPACE_SESSION_BOOT_FAILED: Could not materialize workspace session file.");
      }

      const sw = await runtimeHost.switchSession(targetSessionFile, {
        cwdOverride: resolved
      });

      return {
        workspaceRoot: activeWorkspaceRoot,
        sessionId: runtimeHost.session.sessionManager.getSessionId(),
        cancelled: sw.cancelled
      };
    },
    onHarnessSwitch(listener: (harness: Ring4HarnessInstance) => void): () => void {
      switchListeners.add(listener);
      return () => {
        switchListeners.delete(listener);
      };
    },
    async dispose(): Promise<void> {
      switchListeners.clear();
      await runtimeHost.dispose();
      if (currentHarness) {
        await currentHarness.disposeAsync();
      }
    }
  };
}
