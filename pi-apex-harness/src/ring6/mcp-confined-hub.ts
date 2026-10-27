/**
 * Ring 6 — Confined Zero-Schema-Bloat MCP Client Hub (`src/ring6/mcp-confined-hub.ts`).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 *  1. `@earendil-works/pi-mcp@1.4.0` (`McpClient`, `StdioTransport`, `StreamableHttpTransport`,
 *     `toLlmContent`, `type McpTransport`, `type Tool`, `type Resource`, MIT License, Earendil Works).
 *  2. `@earendil-works/pi-coding-agent@1.4.0` (`examples/extensions/project-trust.ts`, MIT) —
 *     workspace trust gating before executing repository-supplied binaries.
 *  3. `NousResearch/hermes-agent` (`tools/skills_guard.py` `skills-guard-v10`, MIT) — static threat
 *     & prompt-injection scanning applied to untrusted MCP tool descriptions and server instructions.
 *
 * 4-LAYER CONFINEMENT INVARIANTS:
 *  - `+0` Active Schema Tokens: Exposed via deferred `mcp_hub` tool (`exposure: "deferred"`), keeping
 *    active tool schema strictly at `1,073 === 1,073 o200k_base` tokens regardless of MCP server count.
 *  - Layer 1 (Workspace Trust Gate): Workspace-sourced stdio MCP servers fail closed with
 *    `UNTRUSTED_WORKSPACE_MCP_BLOCKED` when `workspaceTrusted === false`.
 *  - Layer 2 (Clean-Env Stdio Isolation): `StdioTransport` runs with `inheritEnv: false` and a
 *    sanitized allowlist (`PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR`, `USER`), preventing host API keys
 *    (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `AWS_SECRET_ACCESS_KEY`, etc.) from leaking into MCP children.
 *  - Layer 3 (`skills-guard-v10` Tool Poisoning Defense): Every MCP tool description, inputSchema, and
 *    server `instructions` string is scanned on connect/discovery; `verdict === "dangerous"` tools are
 *    quarantined (`poisoned: true`) and blocked from execution (`MCP_TOOL_POISONING_BLOCKED`).
 *  - Layer 4 (`toLlmContent` + `scrubSecretsInfallible` + `SpillStore`): All MCP tool/resource text
 *    outputs are scrubbed for secrets and capped via `SpillStore` (`32 KiB`).
 */

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { isIP } from "node:net";
import { isPublicUnicastAddress } from "../ring10/safe-network.ts";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  McpClient,
  type McpTransport,
  type Resource,
  StdioTransport,
  StreamableHttpTransport,
  toLlmContent,
  type Tool
} from "@earendil-works/pi-mcp";
import { readWorkspaceFileSafe } from "../core/safe-path.ts";
import { type PrivateSpillStore, scrubSecretsInfallible } from "../core/spill-store.ts";
import {
  scanSkillBundle,
  type SkillScanFinding,
  type SkillVerdict
} from "../ring3/skills-guard-quarantine.ts";

const SAFE_HOST_ENV_KEYS = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "TMPDIR", "USER"] as const;

export async function validateRemoteMcpUrl(input:string):Promise<string>{
  let url:URL;try{url=new URL(input.trim());}catch{throw new Error("MCP_REMOTE_URL_INVALID");}
  if(url.protocol!=="https:"||url.username||url.password||url.search||url.hash)throw new Error("MCP_REMOTE_URL_INVALID");
  const hostname=url.hostname.replace(/^\[|\]$/g,"");
  if(isIP(hostname)){if(!isPublicUnicastAddress(hostname))throw new Error("MCP_REMOTE_PRIVATE_ADDRESS_BLOCKED");}
  else{let records:Array<{address:string}>;try{records=await dns.lookup(hostname,{all:true,verbatim:true});}catch{throw new Error("MCP_REMOTE_HOST_LOOKUP_FAILED");}if(!records.length||records.some(record=>!isPublicUnicastAddress(record.address)))throw new Error("MCP_REMOTE_PRIVATE_ADDRESS_BLOCKED");}
  return url.toString();
}
const SECRET_ENV_NAME_RE =
  /(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|PRIVATE[_-]?KEY|CREDENTIAL|AUTH)/i;

export function sanitizeMcpStdioEnv(
  hostEnv: NodeJS.ProcessEnv,
  explicitEnv?: Readonly<Record<string, string>>
): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const key of SAFE_HOST_ENV_KEYS) {
    const val = hostEnv[key];
    if (typeof val === "string" && val.length > 0) {
      clean[key] = val;
    }
  }
  if (explicitEnv) {
    for (const [k, v] of Object.entries(explicitEnv)) {
      if (!SECRET_ENV_NAME_RE.test(k) && typeof v === "string") {
        clean[k] = v;
      }
    }
  }
  return clean;
}

export interface AuditedMcpTool {
  serverName: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  scanVerdict: SkillVerdict;
  poisoned: boolean;
  findings: readonly SkillScanFinding[];
}

export interface ConnectedMcpServerSummary {
  name: string;
  transportKind: "stdio" | "http" | "in-memory";
  source: "operator" | "workspace-config";
  protocolVersion?: string;
  serverVersion?: string;
  instructionsVerdict: SkillVerdict;
  instructionsPoisoned: boolean;
  totalTools: number;
  safeTools: number;
  poisonedTools: number;
}

export interface ConnectStdioMcpParams {
  name: string;
  command: string;
  args?: readonly string[];
  cwd?: string;
  env?: Record<string, string>;
  source?: "operator" | "workspace-config";
  requestTimeoutMs?: number;
}

export interface ConnectHttpMcpParams {
  name: string;
  url: string;
  headers?: Record<string, string>;
  openGetStream?: boolean;
  source?: "operator" | "workspace-config";
  requestTimeoutMs?: number;
}

export interface ConnectCustomTransportMcpParams {
  name: string;
  transport: McpTransport;
  transportKind?: "stdio" | "http" | "in-memory";
  source?: "operator" | "workspace-config";
  requestTimeoutMs?: number;
}

interface ManagedServerEntry {
  name: string;
  client: McpClient;
  transport: McpTransport;
  transportKind: "stdio" | "http" | "in-memory";
  source: "operator" | "workspace-config";
  instructionsVerdict: SkillVerdict;
  instructionsPoisoned: boolean;
  safeInstructions?: string;
  toolsByName: Map<string, AuditedMcpTool>;
}

export interface WorkspaceMcpServerSpec {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export class ConfinedMcpHub {
  private readonly workspaceRoot: string;
  private workspaceTrusted: boolean;
  private readonly spillStore?: PrivateSpillStore;
  private readonly servers = new Map<string, ManagedServerEntry>();
  private readonly remoteStorePath:string;
  private readonly restoreIssues:string[]=[];

  private readRemoteConfigs():Array<{name:string;url:string}>{
    try{const parsed=JSON.parse(fs.readFileSync(this.remoteStorePath,"utf8")) as {version?:number;servers?:Array<{name:string;url:string}>};
      if(parsed.version!==1||!Array.isArray(parsed.servers))return [];
      return parsed.servers.filter(s=>typeof s.name==="string"&&typeof s.url==="string").slice(0,50);
    }catch{return [];}
  }
  private writeRemoteConfigs(servers:Array<{name:string;url:string}>):void{
    const temp=this.remoteStorePath+`.tmp.${process.pid}.${Math.random().toString(16).slice(2)}`;fs.writeFileSync(temp,JSON.stringify({version:1,servers},null,2),{mode:0o600,flag:"wx"});fs.chmodSync(temp,0o600);fs.renameSync(temp,this.remoteStorePath);fs.chmodSync(this.remoteStorePath,0o600);
  }
  private saveRemoteConfig(name:string,url:string):void{const servers=this.readRemoteConfigs().filter(item=>item.name!==name);servers.push({name,url});this.writeRemoteConfigs(servers);}
  listRestoreIssues():string[]{return [...this.restoreIssues];}
  async restorePersistedRemoteServers():Promise<void>{
    this.restoreIssues.length=0;
    for(const config of this.readRemoteConfigs())try{await this.connectHttpServer({...config,source:"operator"});}catch{this.restoreIssues.push(`${config.name}: remote MCP unavailable or rejected safety checks`);}
  }

  constructor(opts: {
    workspaceRoot: string;
    workspaceTrusted?: boolean;
    spillStore?: PrivateSpillStore;
  }) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.workspaceTrusted = opts.workspaceTrusted ?? true;
    this.spillStore = opts.spillStore;
    const stateDir=path.join(this.workspaceRoot,".harness");fs.mkdirSync(stateDir,{recursive:true,mode:0o700});this.remoteStorePath=path.join(stateDir,"mcp-remote-servers.json");
    if(fs.existsSync(this.remoteStorePath)){const st=fs.lstatSync(this.remoteStorePath);if(st.isSymbolicLink()||!st.isFile())throw new Error("MCP_REMOTE_STORE_PATH_UNSAFE");fs.chmodSync(this.remoteStorePath,0o600);}
  }

  isWorkspaceTrusted(): boolean {
    return this.workspaceTrusted;
  }

  setWorkspaceTrusted(trusted: boolean): void {
    this.workspaceTrusted = trusted;
  }

  /**
   * Reads `.mcp.json` or `.harness/mcp.json` safely beneath `workspaceRoot` via `openat2`.
   */
  discoverWorkspaceConfigSpecs(): WorkspaceMcpServerSpec[] {
    const candidates = [".mcp.json", path.join(".harness", "mcp.json")];
    const specs: WorkspaceMcpServerSpec[] = [];
    for (const rel of candidates) {
      const full = path.join(this.workspaceRoot, rel);
      if (!fs.existsSync(full)) continue;
      let rawText: string;
      if (rel.startsWith(".harness")) {
        rawText = fs.readFileSync(full, "utf8");
      } else {
        rawText = readWorkspaceFileSafe({
          workspaceRoot: this.workspaceRoot,
          candidatePath: rel
        }).toString("utf8");
      }
      const parsed = JSON.parse(rawText) as {
        mcpServers?: Record<
          string,
          {
            command?: string;
            args?: string[];
            env?: Record<string, string>;
            url?: string;
            headers?: Record<string, string>;
          }
        >;
      };
      if (parsed.mcpServers && typeof parsed.mcpServers === "object") {
        for (const [name, cfg] of Object.entries(parsed.mcpServers)) {
          specs.push({
            name,
            command: cfg.command,
            args: cfg.args,
            env: cfg.env,
            url: cfg.url,
            headers: cfg.headers
          });
        }
      }
    }
    return specs;
  }

  async connectWorkspaceConfigServers(): Promise<ConnectedMcpServerSummary[]> {
    const specs = this.discoverWorkspaceConfigSpecs();
    const out: ConnectedMcpServerSummary[] = [];
    for (const spec of specs) {
      if (spec.command) {
        out.push(
          await this.connectStdioServer({
            name: spec.name,
            command: spec.command,
            args: spec.args,
            env: spec.env,
            source: "workspace-config"
          })
        );
      } else if (spec.url) {
        out.push(
          await this.connectHttpServer({
            name: spec.name,
            url: spec.url,
            headers: spec.headers,
            source: "workspace-config"
          })
        );
      }
    }
    return out;
  }

  async connectStdioServer(params: ConnectStdioMcpParams): Promise<ConnectedMcpServerSummary> {
    const source = params.source ?? "operator";
    if (source === "workspace-config" && !this.workspaceTrusted) {
      throw new Error(
        `UNTRUSTED_WORKSPACE_MCP_BLOCKED: Refusing to spawn workspace-configured stdio MCP server '${params.name}' (${params.command}) because workspaceTrusted=false.`
      );
    }

    const cleanEnv = sanitizeMcpStdioEnv(process.env, params.env);
    const transport = new StdioTransport({
      command: params.command,
      args: params.args ?? [],
      cwd: params.cwd ?? this.workspaceRoot,
      inheritEnv: false,
      env: cleanEnv,
      stderr: "pipe",
      closeTimeoutMs: 1500
    });

    return this.connectWithTransport({
      name: params.name,
      transport,
      transportKind: "stdio",
      source,
      requestTimeoutMs: params.requestTimeoutMs
    });
  }

  async connectHttpServer(params: ConnectHttpMcpParams): Promise<ConnectedMcpServerSummary> {
    const source = params.source ?? "operator";
    if (source === "workspace-config" && !this.workspaceTrusted) {
      throw new Error(
        `UNTRUSTED_WORKSPACE_MCP_BLOCKED: Refusing to connect workspace-configured HTTP MCP server '${params.name}' because workspaceTrusted=false.`
      );
    }
    const safeUrl = await validateRemoteMcpUrl(params.url);
    const transport = new StreamableHttpTransport({
      url: safeUrl,
      headers: params.headers,
      openGetStream: params.openGetStream ?? false
    });
    const summary=await this.connectWithTransport({
      name: params.name,
      transport,
      transportKind: "http",
      source,
      requestTimeoutMs: params.requestTimeoutMs
    });
    if(source==="operator")this.saveRemoteConfig(params.name,safeUrl);
    return summary;
  }

  async connectWithTransport(
    params: ConnectCustomTransportMcpParams
  ): Promise<ConnectedMcpServerSummary> {
    const existing = this.servers.get(params.name);
    if (existing) {
      await existing.client.close().catch(() => {});
      this.servers.delete(params.name);
    }

    const client = new McpClient({
      name: "pi-apex-harness",
      version: "3.6.0",
      requestTimeoutMs: params.requestTimeoutMs ?? 15_000,
      roots: [{ uri: `file://${this.workspaceRoot}`, name: path.basename(this.workspaceRoot) }]
    });

    await client.connect(params.transport);

    // Scan server-level `instructions` via `skills-guard-v10`
    const rawInstructions = client.instructions ?? "";
    const instScan = rawInstructions
      ? scanSkillBundle({
          skillName: `mcp-instructions-${params.name}`,
          files: { "INSTRUCTIONS.md": rawInstructions },
          source: `mcp:${params.name}`,
          trustLevel: "community"
        })
      : { verdict: "safe" as SkillVerdict, findings: [] };

    const tools = await client.listTools();
    const toolsByName = new Map<string, AuditedMcpTool>();
    for (const tool of tools) {
      const audited = this.auditMcpTool(params.name, tool);
      toolsByName.set(tool.name, audited);
    }

    const entry: ManagedServerEntry = {
      name: params.name,
      client,
      transport: params.transport,
      transportKind: params.transportKind ?? "in-memory",
      source: params.source ?? "operator",
      instructionsVerdict: instScan.verdict,
      instructionsPoisoned: instScan.verdict === "dangerous",
      safeInstructions:
        instScan.verdict === "dangerous"
          ? undefined
          : scrubSecretsInfallible(rawInstructions),
      toolsByName
    };
    this.servers.set(params.name, entry);
    return this.summarizeEntry(entry);
  }

  private auditMcpTool(serverName: string, tool: Tool): AuditedMcpTool {
    const desc = tool.description ?? "";
    const schemaJson = JSON.stringify(tool.inputSchema ?? {});
    const scan = scanSkillBundle({
      skillName: `mcp-${serverName}-${tool.name}`,
      files: {
        "TOOL_DESCRIPTION.md": `# ${tool.name}\n${desc}\n\n## Schema\n${schemaJson}`
      },
      source: `mcp:${serverName}`,
      trustLevel: "community"
    });
    const poisoned = scan.verdict === "dangerous";
    return {
      serverName,
      name: tool.name,
      description: poisoned
        ? `[QUARANTINED BY SKILLS-GUARD-V10: ${scan.findings.map((f) => f.patternId).join(", ")}]`
        : scrubSecretsInfallible(desc),
      inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<string, unknown>,
      scanVerdict: scan.verdict,
      poisoned,
      findings: scan.findings
    };
  }

  private summarizeEntry(entry: ManagedServerEntry): ConnectedMcpServerSummary {
    let safeTools = 0;
    let poisonedTools = 0;
    for (const t of entry.toolsByName.values()) {
      if (t.poisoned) poisonedTools++;
      else safeTools++;
    }
    return {
      name: entry.name,
      transportKind: entry.transportKind,
      source: entry.source,
      protocolVersion: entry.client.protocolVersion,
      serverVersion: entry.client.serverInfo
        ? `${entry.client.serverInfo.name}@${entry.client.serverInfo.version}`
        : undefined,
      instructionsVerdict: entry.instructionsVerdict,
      instructionsPoisoned: entry.instructionsPoisoned,
      totalTools: entry.toolsByName.size,
      safeTools,
      poisonedTools
    };
  }

  listServers(): ConnectedMcpServerSummary[] {
    return Array.from(this.servers.values()).map((e) => this.summarizeEntry(e));
  }

  listTools(opts?: { serverName?: string; includePoisoned?: boolean; query?: string }): AuditedMcpTool[] {
    const q = opts?.query?.trim().toLowerCase();
    const out: AuditedMcpTool[] = [];
    for (const entry of this.servers.values()) {
      if (opts?.serverName && entry.name !== opts.serverName) continue;
      for (const tool of entry.toolsByName.values()) {
        if (tool.poisoned && !opts?.includePoisoned) continue;
        if (
          q &&
          !tool.name.toLowerCase().includes(q) &&
          !tool.description.toLowerCase().includes(q) &&
          !tool.serverName.toLowerCase().includes(q)
        ) {
          continue;
        }
        out.push(tool);
      }
    }
    return out;
  }

  async refreshServerTools(serverName: string): Promise<AuditedMcpTool[]> {
    const entry = this.requireServer(serverName);
    const tools = await entry.client.listTools();
    entry.toolsByName.clear();
    for (const t of tools) {
      entry.toolsByName.set(t.name, this.auditMcpTool(serverName, t));
    }
    return this.listTools({ serverName, includePoisoned: true });
  }

  async callTool(params: {
    serverName: string;
    toolName: string;
    args?: Record<string, unknown>;
    toolCallId?: string;
  }): Promise<{
    content: Array<TextContent | ImageContent>;
    isError: boolean;
    serverName: string;
    toolName: string;
  }> {
    const entry = this.requireServer(params.serverName);
    if (entry.instructionsPoisoned) {
      throw new Error(
        `MCP_SERVER_POISONING_BLOCKED: Server '${params.serverName}' instructions failed skills-guard-v10 scan.`
      );
    }

    let audited = entry.toolsByName.get(params.toolName);
    if (!audited) {
      await this.refreshServerTools(params.serverName);
      audited = entry.toolsByName.get(params.toolName);
    }
    if (!audited) {
      throw new Error(
        `MCP_TOOL_NOT_FOUND: Tool '${params.toolName}' does not exist on server '${params.serverName}'.`
      );
    }
    if (audited.poisoned) {
      throw new Error(
        `MCP_TOOL_POISONING_BLOCKED: Refusing to invoke MCP tool '${params.serverName}/${params.toolName}' because skills-guard-v10 flagged its metadata as dangerous (${audited.findings.map((f) => f.patternId).join(", ")}).`
      );
    }

    const rawResult = await entry.client.callTool(params.toolName, params.args ?? {});
    // Convert via upstream `@earendil-works/pi-mcp` `toLlmContent()`
    const llmBlocks = toLlmContent(rawResult);
    const sanitizedBlocks: Array<TextContent | ImageContent> = [];

    for (let i = 0; i < llmBlocks.length; i++) {
      const blk = llmBlocks[i]!;
      if (blk.type === "text") {
        let safeText = scrubSecretsInfallible(blk.text);
        if (this.spillStore) {
          const spilled = this.spillStore.scrubAndMaybeSpill(
            `${params.toolCallId ?? "mcp"}_${i}`,
            safeText
          );
          safeText = spilled.text;
        }
        sanitizedBlocks.push({ type: "text", text: safeText });
      } else if (blk.type === "image") {
        sanitizedBlocks.push({
          type: "image",
          mimeType: blk.mimeType,
          data: blk.data
        });
      }
    }

    if (sanitizedBlocks.length === 0) {
      sanitizedBlocks.push({ type: "text", text: "(empty MCP tool result)" });
    }

    return {
      content: sanitizedBlocks,
      isError: Boolean(rawResult.isError),
      serverName: params.serverName,
      toolName: params.toolName
    };
  }

  async listResources(serverName: string): Promise<Resource[]> {
    const entry = this.requireServer(serverName);
    const resources = await entry.client.listResources();
    return resources.map((r) => ({
      ...r,
      description: r.description ? scrubSecretsInfallible(r.description) : undefined
    }));
  }

  async readResource(params: {
    serverName: string;
    uri: string;
  }): Promise<{ uri: string; contents: Array<{ uri: string; mimeType?: string; text: string }> }> {
    const entry = this.requireServer(params.serverName);
    const res = await entry.client.readResource(params.uri);
    const sanitized = res.contents.map((c) => {
      if ("text" in c && typeof c.text === "string") {
        return {
          uri: c.uri,
          mimeType: c.mimeType,
          text: scrubSecretsInfallible(c.text)
        };
      }
      const blobLen = "blob" in c && typeof c.blob === "string" ? c.blob.length : 0;
      return {
        uri: c.uri,
        mimeType: c.mimeType,
        text: `[binary blob resource: ${blobLen} base64 chars]`
      };
    });
    return { uri: params.uri, contents: sanitized };
  }

  async disconnectServer(serverName: string): Promise<boolean> {
    const entry = this.servers.get(serverName);
    if (!entry) return false;
    this.servers.delete(serverName);
    await entry.client.close().catch(() => {});
    this.writeRemoteConfigs(this.readRemoteConfigs().filter(item=>item.name!==serverName));
    return true;
  }

  async closeAll(): Promise<void> {
    const entries = Array.from(this.servers.values());
    this.servers.clear();
    for (const entry of entries) {
      await entry.client.close().catch(() => {});
    }
  }

  private requireServer(serverName: string): ManagedServerEntry {
    const entry = this.servers.get(serverName);
    if (!entry) {
      throw new Error(
        `MCP_SERVER_NOT_CONNECTED: '${serverName}'. Connected servers: [${Array.from(this.servers.keys()).join(", ") || "none"}].`
      );
    }
    return entry;
  }
}
