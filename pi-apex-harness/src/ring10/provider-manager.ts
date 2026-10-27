import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { isPublicUnicastAddress } from "./safe-network.ts";
import type { ModelRuntime, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import type { OnboardingVault } from "./onboarding-vault.ts";

export type CompatibleAdapter = "openai-compatible" | "anthropic-compatible";
export interface CustomModelDefinition {
  id: string;
  name: string;
  input?: Array<"text" | "image">;
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
}
export interface ProviderConnection {
  id: string;
  name: string;
  adapter: CompatibleAdapter;
  baseUrl: string;
  models: CustomModelDefinition[];
  enabled?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
}
interface Store { version: 1; connections: ProviderConnection[]; favorites?: string[]; recent?: string[] }
export interface RemoteCatalogModel { provider: string; providerName: string; id: string; name: string; supportsImage: boolean; reasoning: boolean; contextWindow: number; maxTokens: number }
interface RemoteCatalogStore { version: 1; refreshedAtMs: number; models: RemoteCatalogModel[] }

const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,159}$/;
const ID_RE = /^[a-z][a-z0-9-]{1,47}$/;
const API_BY_ADAPTER = {
  "openai-compatible": "openai-completions",
  "anthropic-compatible": "anthropic-messages"
} as const;

function isBlockedIp(ip: string): boolean { return !isPublicUnicastAddress(ip); }

export async function validateProviderBaseUrl(input: string): Promise<string> {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error("PROVIDER_URL_INVALID"); }
  if (url.username || url.password || url.search || url.hash) throw new Error("PROVIDER_URL_INVALID: credentials, query and fragment are not allowed in endpoint URLs.");
  if (!url.hostname || url.protocol !== "https:" && url.protocol !== "http:") throw new Error("PROVIDER_URL_SCHEME_INVALID");
  const hostname=url.hostname.toLowerCase();const hostNoBrackets=hostname.replace("[","").replace("]","");
  const local = ["localhost", "127.0.0.1", "::1"].includes(hostNoBrackets);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error("PROVIDER_HTTPS_REQUIRED");
  if (local) return url.toString().replace(/\/$/, "");
  if (isIP(hostNoBrackets)) {
    if (isBlockedIp(hostNoBrackets)) throw new Error("PROVIDER_PRIVATE_ADDRESS_BLOCKED");
  } else {
    let records: Array<{ address: string }>;
    try { records = await dns.lookup(url.hostname, { all: true, verbatim: true }); } catch { throw new Error("PROVIDER_HOST_LOOKUP_FAILED"); }
    if (!records.length || records.some(r => isBlockedIp(r.address))) throw new Error("PROVIDER_PRIVATE_ADDRESS_BLOCKED");
  }
  return url.toString().replace(/\/$/, "");
}

export class ProviderManager {
  private readonly storePath: string;
  private readonly remoteCatalogPath: string;
  private readonly modelRuntime: ModelRuntime;
  private readonly vault: OnboardingVault;
  constructor(opts: { agentDir: string; modelRuntime: ModelRuntime; vault: OnboardingVault }) {
    const dir = path.resolve(opts.agentDir);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.storePath = path.join(dir, "provider-connections.json");
    this.remoteCatalogPath = path.join(dir, "models-dev-cache.json");
    this.modelRuntime = opts.modelRuntime;
    this.vault = opts.vault;
    this.ensureStore();
  }
  private ensureStore() {
    if (!fs.existsSync(this.storePath)) this.write({ version: 1, connections: [] });
    else fs.chmodSync(this.storePath, 0o600);
  }
  private read(): Store {
    this.ensureStore();
    try {
      const x = JSON.parse(fs.readFileSync(this.storePath, "utf8")) as Partial<Store>;
      return { version: 1, connections: Array.isArray(x.connections) ? x.connections : [], favorites:Array.isArray(x.favorites)?x.favorites.filter((v):v is string=>typeof v==="string").slice(0,500):[], recent:Array.isArray(x.recent)?x.recent.filter((v):v is string=>typeof v==="string").slice(0,50):[] };
    } catch { return { version: 1, connections: [], favorites:[], recent:[] }; }
  }
  private write(store: Store) {
    const tmp = `${this.storePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
    fs.chmodSync(tmp, 0o600); fs.renameSync(tmp, this.storePath); fs.chmodSync(this.storePath, 0o600);
  }
  list(): ProviderConnection[] { return this.read().connections.map(c => ({ ...c, enabled:c.enabled!==false, models: c.models.map(m => ({ ...m })) })); }
  getModelPreferences(): {favorites:string[];recent:string[]} { const s=this.read();return {favorites:s.favorites??[],recent:s.recent??[]}; }
  setFavorite(ref:string,favorite:boolean): {favorites:string[]} { const [provider,model]=ref.split("/");if(ref.split("/").length!==2||!provider||!model||!/^[a-z0-9._-]{1,64}$/i.test(provider)||!MODEL_ID_RE.test(model))throw new Error("MODEL_REFERENCE_INVALID");const s=this.read();const set=new Set(s.favorites??[]);if(favorite)set.add(ref);else set.delete(ref);s.favorites=[...set].slice(0,500);this.write(s);return {favorites:s.favorites}; }
  recordRecent(ref:string): void { const [provider,model]=ref.split("/");if(ref.split("/").length!==2||!provider||!model||!/^[a-z0-9._-]{1,64}$/i.test(provider)||!MODEL_ID_RE.test(model))return;const s=this.read();s.recent=[ref,...(s.recent??[]).filter(x=>x!==ref)].slice(0,50);this.write(s); }
  async restore(): Promise<void> {
    for (const connection of this.list()) {
      if(!connection.enabled){await this.modelRuntime.removeRuntimeApiKey(connection.id).catch(()=>{});continue;}
      this.register(connection);
      const key = this.vault.getProviderKeyForBackend(connection.id);
      if (key) await this.modelRuntime.setRuntimeApiKey(connection.id, key);
    }
  }
  private register(connection: ProviderConnection): void {
    const api = API_BY_ADAPTER[connection.adapter];
    const models: ProviderModelConfig[] = connection.models.map(m => ({
      type: "chat", id: m.id, name: m.name, api,
      baseUrl: connection.baseUrl,
      input: m.input ?? ["text"], reasoning: m.reasoning ?? false,
      contextWindow: m.contextWindow ?? 128_000, maxTokens: m.maxTokens ?? 16_384,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    }));
    const host = new URL(connection.baseUrl).hostname.replaceAll("[", "").replaceAll("]", "").toLowerCase();
    const localEndpoint = ["localhost", "127.0.0.1", "::1"].includes(host);
    this.modelRuntime.registerProvider(connection.id, { name: connection.name, api, baseUrl: connection.baseUrl, ...(localEndpoint ? { apiKey: "ollama-local" } : {}), models });
  }
  async discoverOpenAICompatibleModels(baseUrlInput: string, apiKeyInput = ""): Promise<Array<{ id: string; name: string }>> {
    const baseUrl = await validateProviderBaseUrl(baseUrlInput);
    const url = new URL(`${baseUrl}/models`);
    const local = ["localhost", "127.0.0.1", "::1"].includes(url.hostname.replaceAll("[", "").replaceAll("]", "").toLowerCase());
    const apiKey = String(apiKeyInput ?? "").trim();
    if (apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new Error("PROVIDER_KEY_INVALID");
    if (!apiKey && !local) throw new Error("PROVIDER_KEY_REQUIRED_FOR_REMOTE_ENDPOINT");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(url, { method: "GET", headers: { ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}), accept: "application/json" }, signal: controller.signal, redirect: "error" });
      if (!response.ok) { await response.body?.cancel().catch(() => {}); throw new Error("PROVIDER_DISCOVERY_HTTP_ERROR"); }
      const maxBytes = 2 * 1024 * 1024;
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (declared > maxBytes) { await response.body?.cancel().catch(() => {}); throw new Error("PROVIDER_DISCOVERY_SIZE_LIMIT"); }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("PROVIDER_DISCOVERY_RESPONSE_INVALID");
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > maxBytes) { await reader.cancel().catch(() => {}); throw new Error("PROVIDER_DISCOVERY_SIZE_LIMIT"); }
          chunks.push(part.value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = JSON.parse(text) as { data?: unknown };
      if (!Array.isArray(parsed.data) || parsed.data.length > 500) throw new Error("PROVIDER_DISCOVERY_RESPONSE_INVALID");
      const found = new Map<string, { id: string; name: string }>();
      for (const raw of parsed.data) {
        if (typeof raw !== "object" || raw === null) continue;
        const row = raw as Record<string, unknown>;
        const id = typeof row.id === "string" ? row.id.trim() : "";
        if (!MODEL_ID_RE.test(id)) continue;
        const name = typeof row.name === "string" && row.name.trim().length <= 120 ? row.name.trim() : id;
        found.set(id, { id, name: name || id });
      }
      return [...found.values()];
    } catch (error) {
      if (error instanceof Error && /^(PROVIDER_DISCOVERY_|PROVIDER_KEY_)/.test(error.message)) throw error;
      throw new Error("PROVIDER_DISCOVERY_FAILED: model list unavailable, malformed, or timed out.");
    } finally { clearTimeout(timeout); }
  }
  async add(input: {
    name: string; adapter: CompatibleAdapter; baseUrl: string; apiKey: string; models: CustomModelDefinition[];
  }): Promise<ProviderConnection> {
    const name = input.name.trim();
    if (!name || name.length > 80) throw new Error("PROVIDER_NAME_INVALID");
    if (!(input.adapter in API_BY_ADAPTER)) throw new Error("PROVIDER_ADAPTER_UNSUPPORTED");
    const key = input.apiKey.trim();
    if (key.length > 4096 || /[\r\n\0]/.test(key)) throw new Error("PROVIDER_KEY_INVALID");
    if (!Array.isArray(input.models) || input.models.length < 1 || input.models.length > 500) throw new Error("PROVIDER_MODELS_INVALID");
    const models: CustomModelDefinition[] = [];
    const seen = new Set<string>();
    for (const raw of input.models) {
      const id = String(raw.id ?? "").trim(); const modelName = String(raw.name ?? id).trim();
      if (!MODEL_ID_RE.test(id) || !modelName || modelName.length > 120 || seen.has(id)) throw new Error("PROVIDER_MODEL_INVALID");
      seen.add(id);
      const contextWindow = raw.contextWindow ?? 128_000, maxTokens = raw.maxTokens ?? 16_384;
      if (!Number.isSafeInteger(contextWindow) || contextWindow < 1024 || contextWindow > 2_000_000 || !Number.isSafeInteger(maxTokens) || maxTokens < 128 || maxTokens > 1_000_000) throw new Error("PROVIDER_MODEL_LIMIT_INVALID");
      const inputMods = raw.input ?? ["text"];
      if (!Array.isArray(inputMods) || !inputMods.length || inputMods.some(x => x !== "text" && x !== "image")) throw new Error("PROVIDER_MODEL_MODALITY_INVALID");
      models.push({ id, name: modelName, input: [...new Set(inputMods)], reasoning: raw.reasoning === true, contextWindow, maxTokens });
    }
    const idStem = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "provider";
    const store = this.read();
    let id = `custom-${idStem}`;
    let suffix = 2;
    while (store.connections.some(c => c.id === id) || this.modelRuntime.getProvider(id)) id = `custom-${idStem}-${suffix++}`;
    if (!ID_RE.test(id)) throw new Error("PROVIDER_CONNECTION_ID_INVALID");
    const baseUrl = await validateProviderBaseUrl(input.baseUrl);
    const endpointHost = new URL(baseUrl).hostname.replaceAll("[", "").replaceAll("]", "").toLowerCase();
    const localEndpoint = ["localhost", "127.0.0.1", "::1"].includes(endpointHost);
    if (!key && !localEndpoint) throw new Error("PROVIDER_KEY_REQUIRED_FOR_REMOTE_ENDPOINT");
    const now = Date.now();
    const connection: ProviderConnection = { id, name, adapter: input.adapter, baseUrl, models, enabled:true, createdAtMs: now, updatedAtMs: now };
    store.connections.push(connection);
    this.write(store);
    try {
      if (key) await this.vault.saveProviderKey(id, key);
      this.register(connection);
      return connection;
    } catch (error) {
      store.connections = store.connections.filter(c => c.id !== id); this.write(store);
      this.vault.removeProviderKey(id); this.modelRuntime.unregisterProvider(id);
      await this.modelRuntime.removeRuntimeApiKey(id).catch(() => {});
      throw error;
    }
  }
  async setEnabled(id:string,enabled:boolean):Promise<void>{
    const store=this.read();const connection=store.connections.find(c=>c.id===id);if(!connection)throw new Error("PROVIDER_CONNECTION_NOT_FOUND");
    if(enabled){this.register(connection);const key=this.vault.getProviderKeyForBackend(id);if(key)await this.modelRuntime.setRuntimeApiKey(id,key);connection.enabled=true;}
    else{this.modelRuntime.unregisterProvider(id);await this.modelRuntime.removeRuntimeApiKey(id).catch(()=>{});connection.enabled=false;}
    connection.updatedAtMs=Date.now();this.write(store);
  }
  /** Register an OpenRouter model only around one callback; the API key is never sent to the vault. */
  async withOneShotOpenRouterModel<T>(apiKeyInput: string, modelIdInput: string, run: (model: NonNullable<ReturnType<ModelRuntime["getModel"]>>) => Promise<T>): Promise<T> {
    const apiKey = apiKeyInput.trim();
    const modelId = modelIdInput.trim();
    if (!apiKey || apiKey.length > 4096 || /[\r\n\0]/.test(apiKey)) throw new Error("ONE_SHOT_CREDENTIAL_INVALID");
    if (!MODEL_ID_RE.test(modelId)) throw new Error("ONE_SHOT_MODEL_INVALID");
    const temporaryId = `oneshot-${randomUUID().replaceAll("-", "")}`;
    const modelConfig: ProviderModelConfig = {
      type: "chat", id: modelId, name: modelId, api: "openai-completions",
      baseUrl: "https://openrouter.ai/api/v1", input: ["text"], reasoning: false,
      contextWindow: 8192, maxTokens: 512,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
    try {
      this.modelRuntime.registerProvider(temporaryId, {
        name: "One-time OpenRouter probe", api: "openai-completions",
        baseUrl: "https://openrouter.ai/api/v1", apiKey, models: [modelConfig]
      });
      const model = this.modelRuntime.getModel(temporaryId, modelId);
      if (!model) throw new Error("ONE_SHOT_MODEL_UNAVAILABLE");
      return await run(model);
    } finally {
      this.modelRuntime.unregisterProvider(temporaryId);
    }
  }
  /** Validate the temporary credential against OpenRouter without retaining its response body. */
  async verifyOpenRouterKey(apiKey:string):Promise<void>{
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8_000);
    try{
      const response=await fetch("https://openrouter.ai/api/v1/models",{method:"GET",headers:{authorization:`Bearer ${apiKey}`,accept:"application/json"},signal:controller.signal,redirect:"error"});
      await response.body?.cancel().catch(()=>{});
      if(response.status===401||response.status===403)throw new Error("ONE_SHOT_AUTH_REJECTED");
      if(!response.ok)throw new Error("ONE_SHOT_PROVIDER_UNAVAILABLE");
    }catch(error){
      if(error instanceof Error&&["ONE_SHOT_AUTH_REJECTED","ONE_SHOT_PROVIDER_UNAVAILABLE"].includes(error.message))throw error;
      throw new Error("ONE_SHOT_PROVIDER_UNREACHABLE");
    }finally{clearTimeout(timeout);}
  }
  /** Temporarily register an OpenRouter model in RAM for a tightly bounded chat test. */
  async beginEphemeralOpenRouterSession(apiKeyInput:string,modelIdInput:string):Promise<{providerId:string;modelId:string}>{
    const apiKey=apiKeyInput.trim();const modelId=modelIdInput.trim();
    if(!apiKey||apiKey.length>4096||/[\r\n\0]/.test(apiKey))throw new Error("ONE_SHOT_CREDENTIAL_INVALID");
    if(!MODEL_ID_RE.test(modelId))throw new Error("ONE_SHOT_MODEL_INVALID");
    if(!modelId.toLowerCase().endsWith(":free"))throw new Error("ONE_SHOT_FREE_MODEL_REQUIRED");
    const providerId=`oneshot-${randomUUID().replaceAll("-","")}`;
    const model:ProviderModelConfig={type:"chat",id:modelId,name:modelId,api:"openai-completions",baseUrl:"https://openrouter.ai/api/v1",input:["text"],reasoning:false,contextWindow:8192,maxTokens:1024,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
    await this.verifyOpenRouterKey(apiKey);
    this.modelRuntime.registerProvider(providerId,{name:"Temporary OpenRouter chat test",api:"openai-completions",baseUrl:"https://openrouter.ai/api/v1",apiKey,models:[model]});
    if(!this.modelRuntime.getModel(providerId,modelId)){this.modelRuntime.unregisterProvider(providerId);throw new Error("ONE_SHOT_MODEL_UNAVAILABLE");}
    return {providerId,modelId};
  }
  endEphemeralOpenRouterSession(providerId:string):void{
    if(!/^oneshot-[a-f0-9]{32}$/.test(providerId))return;
    this.modelRuntime.unregisterProvider(providerId);
  }
  /** One bounded direct probe, isolated from the user's transcript and saved providers. */
  async oneShotOpenRouterTest(apiKeyInput: string, modelIdInput: string): Promise<{ ok: boolean; modelId: string; latencyMs: number; reply: string }> {
    const modelId = modelIdInput.trim();
    const started = Date.now();
    try {
      return await this.withOneShotOpenRouterModel(apiKeyInput, modelId, async model => {
        const response = await this.modelRuntime.complete(model, {
          messages: [{ role: "user", content: [{ type: "text", text: "Reply with exactly: pi-apex-openrouter-ok" }], timestamp: Date.now() }]
        }, { timeoutMs: 20_000, maxRetries: 0, maxTokens: 512 });
        if (response.stopReason !== "stop" && response.stopReason !== "length") throw new Error("ONE_SHOT_PROVIDER_REJECTED");
        const reply = response.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map(part => part.text).join(" ").trim().slice(0, 240);
        if (!reply) throw new Error("ONE_SHOT_PROVIDER_REJECTED");
        return { ok: true, modelId, latencyMs: Date.now() - started, reply };
      });
    } catch {
      // Never propagate SDK/network errors: they can contain request details or credential material.
      throw new Error("ONE_SHOT_PROVIDER_FAILED");
    }
  }
  async testConnection(id:string):Promise<{id:string;ok:boolean;httpStatus:number;latencyMs:number;modelsConfigured:number}>{
    if(!this.list().some(c=>c.id===id&&c.enabled!==false))throw new Error("PROVIDER_CONNECTION_DISABLED");
    const connection=this.list().find(c=>c.id===id);if(!connection)throw new Error("PROVIDER_CONNECTION_NOT_FOUND");
    const key=this.vault.getProviderKeyForBackend(id)??"";
    const base=await validateProviderBaseUrl(connection.baseUrl);const endpoint=new URL(`${base}/models`);
    const host=endpoint.hostname.replaceAll("[", "").replaceAll("]", "").toLowerCase();
    if(!key&&!["localhost","127.0.0.1","::1"].includes(host))throw new Error("PROVIDER_CREDENTIAL_MISSING");
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),8_000);const started=Date.now();
    try{
      const headers:Record<string,string>=connection.adapter==="anthropic-compatible"?{...(key?{"x-api-key":key}:{}),"anthropic-version":"2023-06-01",accept:"application/json"}:{...(key?{authorization:`Bearer ${key}`}:{ }),accept:"application/json"};
      const response=await fetch(endpoint,{method:"GET",headers,signal:controller.signal,redirect:"error"});
      await response.body?.cancel().catch(()=>{});
      return {id,ok:response.status>=200&&response.status<300,httpStatus:response.status,latencyMs:Date.now()-started,modelsConfigured:connection.models.length};
    }catch{throw new Error("PROVIDER_TEST_FAILED: endpoint unreachable or redirect rejected; no provider response body was retained.");}
    finally{clearTimeout(timeout);}
  }
  async remove(id: string): Promise<void> {
    if (!this.list().some(c => c.id === id)) throw new Error("PROVIDER_CONNECTION_NOT_FOUND");
    const store = this.read(); store.connections = store.connections.filter(c => c.id !== id);store.favorites=(store.favorites??[]).filter(ref=>!ref.startsWith(`${id}/`));store.recent=(store.recent??[]).filter(ref=>!ref.startsWith(`${id}/`));this.write(store);
    this.modelRuntime.unregisterProvider(id);
    this.vault.removeProviderKey(id);
    await this.modelRuntime.removeRuntimeApiKey(id).catch(() => {});
  }
  getRemoteCatalog(): RemoteCatalogStore | null {
    if (!fs.existsSync(this.remoteCatalogPath)) return null;
    try {
      fs.chmodSync(this.remoteCatalogPath,0o600);
      const parsed=JSON.parse(fs.readFileSync(this.remoteCatalogPath,"utf8")) as RemoteCatalogStore;
      if(parsed.version!==1||!Array.isArray(parsed.models)||!Number.isFinite(parsed.refreshedAtMs))return null;
      return parsed;
    } catch { return null; }
  }
  /** Fetch advisory model metadata from the public models.dev API (MIT-licensed catalog; no provider code is copied or executed). Operator-triggered only. */
  async refreshRemoteCatalog(): Promise<{ refreshedAtMs:number; modelCount:number }> {
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),10_000);
    try {
      const response=await fetch("https://models.dev/api.json",{signal:controller.signal,redirect:"error",headers:{accept:"application/json"}});
      if(!response.ok)throw new Error("REMOTE_CATALOG_HTTP_ERROR");
      const declared=Number(response.headers.get("content-length")??0);if(declared>12*1024*1024)throw new Error("REMOTE_CATALOG_SIZE_LIMIT");
      const text=await response.text();if(Buffer.byteLength(text)>12*1024*1024)throw new Error("REMOTE_CATALOG_SIZE_LIMIT");
      const source=JSON.parse(text) as Record<string,unknown>;const models:RemoteCatalogModel[]=[];
      for(const [providerId,rawProvider] of Object.entries(source)){
        if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(providerId)||typeof rawProvider!=="object"||rawProvider===null)continue;
        const p=rawProvider as Record<string,unknown>;const providerName=typeof p.name==="string"?p.name.slice(0,120):providerId;
        const rawModels=p.models;if(typeof rawModels!=="object"||rawModels===null)continue;
        for(const [modelId,rawModel] of Object.entries(rawModels as Record<string,unknown>)){
          if(models.length>=25_000)break;
          if(typeof rawModel!=="object"||rawModel===null||!MODEL_ID_RE.test(modelId))continue;
          const m=rawModel as Record<string,unknown>;
          if(typeof m.type==="string"&&m.type!=="chat")continue;
          const modality=(m.modalities&&typeof m.modalities==="object"?m.modalities as Record<string,unknown>:{});
          const input=Array.isArray(modality.input)?modality.input.filter(x=>typeof x==="string"):[];
          const limits=(m.limit&&typeof m.limit==="object"?m.limit as Record<string,unknown>:{});
          const context=Number(limits.context??0),output=Number(limits.output??0);
          models.push({provider:providerId,providerName,id:modelId,name:typeof m.name==="string"?m.name.slice(0,160):modelId,
            supportsImage:input.includes("image")||m.attachment===true,reasoning:m.reasoning===true,
            contextWindow:Number.isSafeInteger(context)&&context>0?Math.min(context,2_000_000):0,
            maxTokens:Number.isSafeInteger(output)&&output>0?Math.min(output,1_000_000):0});
        }
      }
      const cached:RemoteCatalogStore={version:1,refreshedAtMs:Date.now(),models};
      const tmp=`${this.remoteCatalogPath}.tmp.${process.pid}`;fs.writeFileSync(tmp,JSON.stringify(cached),{mode:0o600});fs.chmodSync(tmp,0o600);fs.renameSync(tmp,this.remoteCatalogPath);fs.chmodSync(this.remoteCatalogPath,0o600);
      return {refreshedAtMs:cached.refreshedAtMs,modelCount:models.length};
    } catch (error) {
      if(error instanceof Error&&error.message.startsWith("REMOTE_CATALOG_"))throw error;
      throw new Error("REMOTE_CATALOG_REFRESH_FAILED: cached catalog was left unchanged.");
    } finally {clearTimeout(timeout);}
  }
  getStorePath(): string { return this.storePath; }
}
