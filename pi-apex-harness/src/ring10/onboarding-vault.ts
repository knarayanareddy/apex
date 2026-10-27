/**
 * Ring 10 — 1-Click Cloud Provider, Local Ollama Auto-Discovery & Messaging Channel Onboarding Vault
 * (`src/ring10/onboarding-vault.ts`).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 * 1. `NousResearch/hermes-agent` @ `765c6463009f` (`hermes setup` unified personal onboarding wizard, MIT).
 * 2. `@earendil-works/pi-coding-agent@1.4.0` (`ModelRuntime.setRuntimeApiKey` & OpenAI-compat
 *    `registerProvider`, MIT).
 *
 * SECURITY INVARIANTS:
 * - Credentials persist strictly OUTSIDE `<workspaceRoot>` in `<agentDir>/apex-vault.json` with `0o600`
 *   permissions so Git snapshots, worktrees, and workspace tools can never read or commit them.
 * - Read APIs (`getVaultStatus`) return ONLY masked key previews (`sk-ant-...9f2a`) — never raw secrets.
 */

import fs from "node:fs";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ApexProviderRouterController } from "../ring6/provider-router.ts";
import type {
  GatewayPlatformCredentials,
  OmniChannelGateway
} from "../ring9/messaging-gateway.ts";

export type SupportedCloudProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "openrouter"
  | "groq"
  | "xai"
  | "mistral";

export const SUPPORTED_CLOUD_PROVIDERS: ReadonlyArray<{
  id: SupportedCloudProvider;
  label: string;
  keyPrefixHint: string;
}> = [
  { id: "anthropic", label: "Anthropic (Claude Sonnet / Opus)", keyPrefixHint: "sk-ant-..." },
  { id: "openai", label: "OpenAI (GPT-5 / Codex)", keyPrefixHint: "sk-proj-..." },
  { id: "google", label: "Google Gemini", keyPrefixHint: "AIza..." },
  { id: "openrouter", label: "OpenRouter (Multi-Model)", keyPrefixHint: "sk-or-..." },
  { id: "groq", label: "Groq (Ultra-Fast LPU)", keyPrefixHint: "gsk_..." },
  { id: "xai", label: "xAI (Grok)", keyPrefixHint: "xai-..." },
  { id: "mistral", label: "Mistral (Codestral)", keyPrefixHint: "..." }
];

interface StoredVaultData {
  version: 1;
  providers: Record<string, { apiKey: string; updatedAtMs: number }>;
  ollama?: {
    baseUrl: string;
    discoveredModels: string[];
    updatedAtMs: number;
  };
  channels: GatewayPlatformCredentials;
}

export interface MaskedVaultStatus {
  vaultPath: string;
  fileModeOctal: string;
  readinessScorePct: number;
  providers: Array<{
    id: string;
    label: string;
    configured: boolean;
    maskedKey: string | null;
    updatedAtMs: number | null;
  }>;
  ollama: {
    configured: boolean;
    baseUrl: string;
    discoveredModels: string[];
  };
  channels: Array<{
    platform: string;
    configured: boolean;
    maskedSummary: string | null;
  }>;
}

export function maskSecretValue(secret: string | undefined | null): string | null {
  if (!secret || !secret.trim()) return null;
  const s = secret.trim();
  if (s.length <= 8) {
    return `${s.slice(0, 2)}••••${s.slice(-2)}`;
  }
  return `${s.slice(0, 6)}••••${s.slice(-4)}`;
}

export class OnboardingVault {
  private readonly vaultFilePath: string;
  private readonly getModelRuntime: () => ModelRuntime;
  private readonly getRouter: () => ApexProviderRouterController;
  private readonly getGateway: () => OmniChannelGateway;

  constructor(opts: {
    agentDir: string;
    getModelRuntime: () => ModelRuntime;
    getRouter: () => ApexProviderRouterController;
    getGateway: () => OmniChannelGateway;
  }) {
    const dir = path.resolve(opts.agentDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.vaultFilePath = path.join(dir, "apex-vault.json");
    this.getModelRuntime = opts.getModelRuntime;
    this.getRouter = opts.getRouter;
    this.getGateway = opts.getGateway;
    this.ensureVaultFile();
  }

  public getVaultFilePath(): string {
    return this.vaultFilePath;
  }

  /** Backend-only credential access; never call from HTTP response, UI, extension tool, or Codemode. */
  public getProviderKeyForBackend(provider: string): string | null {
    const entry = this.readRawVault().providers[provider.trim().toLowerCase()];
    return entry?.apiKey ?? null;
  }

  public hasProviderKey(provider: string): boolean {
    return Boolean(this.getProviderKeyForBackend(provider));
  }

  private ensureVaultFile(): void {
    if (!fs.existsSync(this.vaultFilePath)) {
      const initial: StoredVaultData = {
        version: 1,
        providers: {},
        channels: {}
      };
      fs.writeFileSync(this.vaultFilePath, JSON.stringify(initial, null, 2), { mode: 0o600 });
      fs.chmodSync(this.vaultFilePath, 0o600);
    } else {
      fs.chmodSync(this.vaultFilePath, 0o600);
    }
  }

  private readRawVault(): StoredVaultData {
    this.ensureVaultFile();
    try {
      const parsed = JSON.parse(fs.readFileSync(this.vaultFilePath, "utf8")) as Partial<StoredVaultData>;
      return {
        version: 1,
        providers: parsed.providers ?? {},
        ollama: parsed.ollama,
        channels: parsed.channels ?? {}
      };
    } catch {
      return { version: 1, providers: {}, channels: {} };
    }
  }

  private writeRawVault(data: StoredVaultData): void {
    const tmpPath = `${this.vaultFilePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.chmodSync(tmpPath, 0o600);
    fs.renameSync(tmpPath, this.vaultFilePath);
    fs.chmodSync(this.vaultFilePath, 0o600);
  }

  /**
   * Re-hydrates stored API keys, local Ollama models, and messaging channel tokens into the live runtime.
   */
  public async applyStoredVaultToRuntime(): Promise<void> {
    const data = this.readRawVault();
    const mr = this.getModelRuntime();
    for (const [provider, entry] of Object.entries(data.providers)) {
      if (entry?.apiKey) {
          await mr.setRuntimeApiKey(provider as SupportedCloudProvider, entry.apiKey);
      }
    }
    if (data.ollama && data.ollama.discoveredModels.length > 0) {
      await this.getRouter().registerLocalOllamaProvider({
        baseUrl: `${data.ollama.baseUrl.replace(/\/+$/, "")}/v1`,
        models: data.ollama.discoveredModels.map((id) => ({ id }))
      });
    }
    if (Object.keys(data.channels).length > 0) {
      this.getGateway().updateCredentials(data.channels);
    }
  }

  /**
   * Saves a cloud LLM API key into `0600` `<agentDir>/apex-vault.json` and activates it immediately in `ModelRuntime`.
   */
  public async saveProviderKey(
    provider: string,
    apiKey: string
  ): Promise<{ provider: string; maskedKey: string }> {
    const cleanProvider = provider.trim().toLowerCase();
    const cleanKey = apiKey.trim();
    if (!cleanProvider || !cleanKey) {
      throw new Error("VAULT_INVALID_PROVIDER_KEY: provider and apiKey must be non-empty.");
    }
    const data = this.readRawVault();
    data.providers[cleanProvider] = {
      apiKey: cleanKey,
      updatedAtMs: Date.now()
    };
    this.writeRawVault(data);
    await this.getModelRuntime().setRuntimeApiKey(cleanProvider, cleanKey);
    return {
      provider: cleanProvider,
      maskedKey: maskSecretValue(cleanKey)!
    };
  }

  public removeProviderKey(provider: string): void {
    const cleanProvider = provider.trim().toLowerCase();
    const data = this.readRawVault();
    delete data.providers[cleanProvider];
    this.writeRawVault(data);
  }

  /**
   * 1-Click Local Ollama Auto-Discovery: queries `<host>/api/tags`, registers all discovered local models
   * into `ModelRuntime` via `ApexProviderRouterController`, and optionally binds `apex/auto`!
   */
  public async discoverAndRegisterOllama(opts?: {
    ollamaHostUrl?: string;
    bindApexAuto?: boolean;
  }): Promise<{
    ollamaHostUrl: string;
    discoveredModels: string[];
    registeredRefs: string[];
    boundAutoTargets?: { planning?: string; implementation?: string };
  }> {
    const rawHost = (opts?.ollamaHostUrl ?? "http://127.0.0.1:11434")
      .trim()
      .replace(/\/v1\/?$/, "")
      .replace(/\/+$/, "");

    const resp = await fetch(`${rawHost}/api/tags`);
    if (!resp.ok) {
      throw new Error(`OLLAMA_DISCOVERY_FAILED: HTTP ${resp.status} from ${rawHost}/api/tags`);
    }
    const payload = (await resp.json()) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const modelIds = Array.from(
      new Set(
        (payload.models ?? [])
          .map((m) => (m.name ?? m.model ?? "").trim())
          .filter(Boolean)
      )
    );
    if (modelIds.length === 0) {
      throw new Error(`OLLAMA_NO_MODELS_FOUND: ${rawHost}/api/tags returned 0 installed models.`);
    }

    const reg = await this.getRouter().registerLocalOllamaProvider({
      providerId: "ollama",
      baseUrl: `${rawHost}/v1`,
      models: modelIds.map((id) => ({ id }))
    });

    const data = this.readRawVault();
    data.ollama = {
      baseUrl: rawHost,
      discoveredModels: modelIds,
      updatedAtMs: Date.now()
    };
    this.writeRawVault(data);

    let boundAutoTargets: { planning?: string; implementation?: string } | undefined;
    if (opts?.bindApexAuto !== false) {
      const first = modelIds[0]!;
      const second = modelIds[1] ?? first;
      this.getRouter().configureAutoTargets({
        planningModel: { provider: "ollama", id: first },
        implementationModel: { provider: "ollama", id: second }
      });
      boundAutoTargets = {
        planning: `ollama/${first}`,
        implementation: `ollama/${second}`
      };
    }

    return {
      ollamaHostUrl: rawHost,
      discoveredModels: modelIds,
      registeredRefs: reg.registeredModels,
      boundAutoTargets
    };
  }

  /**
   * Saves messaging channel bot credentials into `0600` vault and hot-reloads `OmniChannelGateway` immediately.
   */
  public saveChannelCredentials(partial: Partial<GatewayPlatformCredentials>): MaskedVaultStatus {
    const data = this.readRawVault();
    if (partial.telegram) {
      data.channels.telegram = { ...data.channels.telegram, ...partial.telegram };
    }
    if (partial.discord) {
      data.channels.discord = { ...data.channels.discord, ...partial.discord };
    }
    if (partial.slack) {
      data.channels.slack = { ...data.channels.slack, ...partial.slack };
    }
    if (partial.signal) {
      data.channels.signal = { ...data.channels.signal, ...partial.signal };
    }
    if (partial.whatsappCloud) {
      data.channels.whatsappCloud = { ...data.channels.whatsappCloud, ...partial.whatsappCloud };
    }
    this.writeRawVault(data);
    this.getGateway().updateCredentials(partial);
    return this.getVaultStatus();
  }

  /**
   * Returns a strictly secret-masked readiness checklist safe for UI & `codemode` inspection.
   */
  public getVaultStatus(): MaskedVaultStatus {
    const data = this.readRawVault();
    const st = fs.statSync(this.vaultFilePath);
    const fileModeOctal = `0${(st.mode & 0o777).toString(8)}`;

    const providers: MaskedVaultStatus["providers"] = SUPPORTED_CLOUD_PROVIDERS.map((p) => {
      const entry = data.providers[p.id];
      return {
        id: p.id,
        label: p.label,
        configured: Boolean(entry?.apiKey),
        maskedKey: maskSecretValue(entry?.apiKey),
        updatedAtMs: entry?.updatedAtMs ?? null
      };
    });

    for (const [customId, entry] of Object.entries(data.providers)) {
      if (!providers.some((p) => p.id === customId)) {
        providers.push({
          id: customId,
          label: `${customId} (Custom)`,
          configured: Boolean(entry?.apiKey),
          maskedKey: maskSecretValue(entry?.apiKey),
          updatedAtMs: entry?.updatedAtMs ?? null
        });
      }
    }

    const gwStatus = this.getGateway().getStatusSummary();
    const channels = [
      {
        platform: "whatsapp_baileys",
        configured: gwStatus.baileys.connected,
        maskedSummary: gwStatus.baileys.connected
          ? `Paired (${gwStatus.baileys.pairedPhoneE164})`
          : `Link code ready (${gwStatus.baileys.eightCharLinkCode})`
      },
      {
        platform: "whatsapp_cloud",
        configured: Boolean(data.channels.whatsappCloud?.accessToken),
        maskedSummary: maskSecretValue(data.channels.whatsappCloud?.accessToken)
      },
      {
        platform: "telegram",
        configured: Boolean(data.channels.telegram?.botToken),
        maskedSummary: maskSecretValue(data.channels.telegram?.botToken)
      },
      {
        platform: "discord",
        configured: Boolean(data.channels.discord?.botToken),
        maskedSummary: maskSecretValue(data.channels.discord?.botToken)
      },
      {
        platform: "slack",
        configured: Boolean(data.channels.slack?.botToken),
        maskedSummary: maskSecretValue(data.channels.slack?.botToken)
      },
      {
        platform: "signal",
        configured: Boolean(data.channels.signal?.rpcUrl),
        maskedSummary: data.channels.signal?.accountE164 ?? null
      }
    ];

    const hasModelReady =
      providers.some((p) => p.configured) || Boolean(data.ollama?.discoveredModels.length);
    const hasChannelReady = channels.some((c) => c.configured);
    const readinessScorePct = (hasModelReady ? 60 : 20) + (hasChannelReady ? 40 : 0);

    return {
      vaultPath: this.vaultFilePath,
      fileModeOctal,
      readinessScorePct,
      providers,
      ollama: {
        configured: Boolean(data.ollama && data.ollama.discoveredModels.length > 0),
        baseUrl: data.ollama?.baseUrl ?? "http://127.0.0.1:11434",
        discoveredModels: data.ollama?.discoveredModels ?? []
      },
      channels
    };
  }
}
