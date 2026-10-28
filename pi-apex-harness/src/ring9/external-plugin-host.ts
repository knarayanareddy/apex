/**
 * Ring 9 — Quarantine-Scanned External Plugin Host (`src/ring9/external-plugin-host.ts`).
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 * 1. `@earendil-works/pi-coding-agent@1.4.0` — Extension & Package manifest architecture (MIT).
 * 2. `openclaw/openclaw` — Capability-manifest plugin hub (`codemodeTools`, `slashCommands`,
 *    `gatewayPlatforms`, explicit OS capability flags, MIT).
 * 3. `NousResearch/hermes-agent` @ `765c6463009f` — `skills-guard-v10` static threat scanner (MIT).
 *
 * SECURITY & SCHEMA INVARIANTS:
 * - Every external plugin directory is statically audited BEFORE `import()` is ever executed:
 *   1. Symlinks escaping the plugin directory are rejected (`PLUGIN_SYMLINK_ESCAPE_BLOCKED`).
 *   2. `skills-guard-v10` scans `apex-plugin.json` and all `.js`/`.mjs`/`.cjs`/`.ts` files
 *      (`PLUGIN_QUARANTINE_BLOCKED`).
 *   3. Static capability conformance rejects undeclared `child_process`, `process.env` harvesting,
 *      and `eval()` / `new Function()` (`PLUGIN_UNDECLARED_CAPABILITY`).
 * - Plugin tools are invoked through the deferred `plugin_manager` tool inside QuickJS WASM
 *   `codemode`, adding **ZERO** tokens (`1,073 === 1,073` `o200k_base`) to the active LLM schema!
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { GuardDeniedError } from "../core/monotonic-guard.ts";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import type { SandboxMode } from "../types.ts";
import { scanSkillBundle, type SkillVerdict } from "../ring3/skills-guard-quarantine.ts";
import type { GatewayPlatformAdapter, OmniChannelGateway } from "./messaging-gateway.ts";

export interface ApexPluginCapabilities {
  codemodeTools?: string[];
  slashCommands?: string[];
  gatewayPlatforms?: string[];
  allowChildProcess?: boolean;
  allowEnvRead?: boolean;
}

export interface ApexPluginManifest {
  id: string;
  name: string;
  version: string;
  description: string;
  entry: string;
  capabilities: ApexPluginCapabilities;
}

export interface ExternalPluginToolDef {
  name: string;
  description: string;
  execute: (args: Record<string, unknown>) => Promise<unknown> | unknown;
  readOnly?: boolean;
  mutabilityClass?: string;
}

export interface ExternalPluginCommandDef {
  name: string;
  description: string;
  execute: (args: string) => Promise<string> | string;
}

export interface ExternalPluginRegistrationApi {
  registerTool(def: ExternalPluginToolDef): void;
  registerCommand(def: ExternalPluginCommandDef): void;
  registerGatewayAdapter(adapter: GatewayPlatformAdapter): void;
}

export interface PluginAuditReport {
  pluginId: string;
  manifest: ApexPluginManifest;
  scanVerdict: SkillVerdict;
  findings: string[];
  allowed: boolean;
}

export interface InstalledPluginSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  scanVerdict: SkillVerdict;
  tools: Array<{ qualifiedName: string; toolName: string; description: string }>;
  commands: Array<{ name: string; description: string }>;
  gatewayPlatforms: string[];
  installedPath: string;
  restoreState?: "loaded" | "stored-not-loaded" | "changed-on-disk" | "audit-blocked";
}

interface LoadedPluginRecord {
  manifest: ApexPluginManifest;
  installedPath: string;
  scanVerdict: SkillVerdict;
  enabled: boolean;
  tools: Map<string, ExternalPluginToolDef>;
  commands: Map<string, ExternalPluginCommandDef>;
  gatewayPlatforms: Array<`plugin:${string}`>;
}

const VALID_PLUGIN_ID_RE = /^[a-z0-9][a-z0-9_-]{1,48}$/;

function collectPluginSourceFiles(pluginDir: string): Record<string, string> {
  const realRoot = fs.realpathSync(pluginDir);
  const files: Record<string, string> = {};

  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".git") continue;
      const full = path.join(dir, entry);
      const lstat = fs.lstatSync(full);
      if (lstat.isSymbolicLink()) {
        const resolved = fs.realpathSync(full);
        if (resolved !== realRoot && !resolved.startsWith(`${realRoot}${path.sep}`)) {
          throw new Error(
            `PLUGIN_SYMLINK_ESCAPE_BLOCKED: symlink '${entry}' escapes plugin directory.`
          );
        }
      }
      if (lstat.isDirectory()) {
        walk(full);
      } else if (/\.(?:m?js|cjs|ts|json|md)$/i.test(entry)) {
        const rel = path.relative(realRoot, full).replace(/\\/g, "/");
        files[rel] = fs.readFileSync(full, "utf8");
      }
    }
  };

  walk(realRoot);
  return files;
}

export interface PluginMutationAdmission {
  assertAllowed(action: string): void;
}

export interface ExternalPluginHostOptions {
  workspaceRoot: string;
  getGateway?: () => OmniChannelGateway;
  sandboxMode?: SandboxMode;
  mutationAdmission?: PluginMutationAdmission | ((action: string) => void);
  isPlanModeActive?: () => boolean;
}

export class ExternalPluginHost {
  private readonly workspaceRoot: string;
  private readonly pluginsStoreDir: string;
  private readonly getGateway?: () => OmniChannelGateway;
  private readonly sandboxMode: SandboxMode;
  private readonly isPlanModeActive?: () => boolean;
  private readonly mutationAdmission?: PluginMutationAdmission | ((action: string) => void);
  private readonly plugins = new Map<string, LoadedPluginRecord>();

  private hashPluginDirectory(dir:string):string {
    const files=collectPluginSourceFiles(dir);const hash=crypto.createHash("sha256");
    for(const name of Object.keys(files).sort())hash.update(name).update("\0").update(files[name]!).update("\0");
    return hash.digest("hex");
  }

  constructor(opts: ExternalPluginHostOptions) {
    this.workspaceRoot = path.resolve(opts.workspaceRoot);
    this.pluginsStoreDir = path.join(this.workspaceRoot, ".harness", "plugins");
    this.getGateway = opts.getGateway;
    this.sandboxMode = opts.sandboxMode ?? "workspace-write";
    this.isPlanModeActive = opts.isPlanModeActive;
    this.mutationAdmission = opts.mutationAdmission;
    fs.mkdirSync(this.pluginsStoreDir, { recursive: true, mode: 0o700 });
  }

  public getSandboxMode(): SandboxMode {
    return this.sandboxMode;
  }

  private checkMutationAllowed(action: string): void {
    if (this.sandboxMode === "read-only") {
      throw new GuardDeniedError(
        `ExternalPluginHost: cannot ${action} in read-only sandbox mode`
      );
    }
    if (this.isPlanModeActive?.()) {
      throw new GuardDeniedError(
        `ExternalPluginHost: cannot ${action} while Plan Mode is active`
      );
    }
    if (typeof this.mutationAdmission === "function") {
      this.mutationAdmission(action);
    } else if (this.mutationAdmission && typeof this.mutationAdmission.assertAllowed === "function") {
      this.mutationAdmission.assertAllowed(action);
    }
  }

  /**
   * Statically audits an external plugin directory (`apex-plugin.json` + JS/TS sources)
   * BEFORE importing or executing a single line of plugin code.
   */
  public auditPluginDirectory(sourceDir: string): PluginAuditReport {
    const absDir = path.resolve(sourceDir);
    const manifestPath = path.join(absDir, "apex-plugin.json");
    if (!fs.existsSync(manifestPath)) {
      throw new Error(`PLUGIN_MANIFEST_MISSING: no apex-plugin.json found in '${absDir}'.`);
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as ApexPluginManifest;
    if (!manifest.id || !VALID_PLUGIN_ID_RE.test(manifest.id)) {
      throw new Error(
        `PLUGIN_INVALID_ID: '${String(manifest.id)}' must match ${VALID_PLUGIN_ID_RE}.`
      );
    }
    if (!manifest.entry || manifest.entry.includes("..")) {
      throw new Error(`PLUGIN_INVALID_ENTRYPOINT: '${String(manifest.entry)}'`);
    }

    const files = collectPluginSourceFiles(absDir);
    if (!(manifest.entry in files)) {
      throw new Error(`PLUGIN_ENTRYPOINT_MISSING: '${manifest.entry}' not found in plugin bundle.`);
    }

    const scan = scanSkillBundle({
      skillName: `plugin-${manifest.id}`,
      files,
      source: absDir,
      trustLevel: "community"
    });

    const findings = scan.findings.map(
      (f) => `[${f.severity}] ${f.file}:${f.line} ${f.patternId} (${f.description})`
    );

    const caps = manifest.capabilities ?? {};
    for (const [relFile, code] of Object.entries(files)) {
      if (!/\.(?:m?js|cjs|ts)$/i.test(relFile)) continue;

      if (!caps.allowChildProcess && /\b(?:node:)?child_process\b/.test(code)) {
        findings.push(
          `[critical] ${relFile}: PLUGIN_UNDECLARED_CAPABILITY (imports child_process while allowChildProcess=false)`
        );
      }
      if (!caps.allowEnvRead && /\bprocess\.env\b/.test(code)) {
        findings.push(
          `[critical] ${relFile}: PLUGIN_UNDECLARED_CAPABILITY (reads process.env while allowEnvRead=false)`
        );
      }
      if (/\beval\s*\(|\bnew\s+Function\s*\(/.test(code)) {
        findings.push(
          `[critical] ${relFile}: PLUGIN_DYNAMIC_CODE_EXEC_BLOCKED (eval / new Function prohibited)`
        );
      }
    }

    const hasCapabilityViolation = findings.some(
      (f) =>
        f.includes("PLUGIN_UNDECLARED_CAPABILITY") ||
        f.includes("PLUGIN_DYNAMIC_CODE_EXEC_BLOCKED")
    );
    const effectiveVerdict: SkillVerdict =
      scan.verdict === "dangerous" || hasCapabilityViolation ? "dangerous" : scan.verdict;

    return {
      pluginId: manifest.id,
      manifest,
      scanVerdict: effectiveVerdict,
      findings,
      allowed: effectiveVerdict !== "dangerous"
    };
  }

  /**
   * Audits, copies into `.harness/plugins/<id>`, dynamically loads, and registers tools/commands/adapters.
   */
  public async installAndLoadPlugin(
    sourceDir: string,
    opts?: { allowCaution?: boolean }
  ): Promise<InstalledPluginSummary> {
    this.checkMutationAllowed("install or modify plugins");
    const audit = this.auditPluginDirectory(sourceDir);
    if (!audit.allowed || (audit.scanVerdict === "caution" && opts?.allowCaution !== true)) {
      throw new Error(
        `PLUGIN_QUARANTINE_BLOCKED (${audit.pluginId}, verdict=${audit.scanVerdict}): ${audit.findings.join("; ")}`
      );
    }

    const destDir = path.join(this.pluginsStoreDir, audit.manifest.id);
    if(path.resolve(sourceDir)===path.resolve(destDir)){
      const marker=path.join(destDir,".apex-installed-sha256");
      if(!fs.existsSync(marker)||fs.readFileSync(marker,"utf8").trim()!==this.hashPluginDirectory(destDir))throw new Error("PLUGIN_CHANGED_SINCE_INSTALL: stored plugin bytes changed; remove and reinstall after review.");
    }else{
      fs.rmSync(destDir, { recursive: true, force: true });
      fs.cpSync(path.resolve(sourceDir), destDir, { recursive: true, dereference: false });
      fs.writeFileSync(path.join(destDir,".apex-installed-sha256"),this.hashPluginDirectory(destDir)+"\n",{mode:0o600});
    }

    const entryAbs = path.join(destDir, audit.manifest.entry);
    const cacheBustUrl = `${pathToFileURL(entryAbs).href}?v=${crypto.randomBytes(4).toString("hex")}`;
    const mod = (await import(cacheBustUrl)) as {
      default?: (api: ExternalPluginRegistrationApi) => Promise<void> | void;
      activate?: (api: ExternalPluginRegistrationApi) => Promise<void> | void;
    };

    const activateFn = mod.activate ?? mod.default;
    if (typeof activateFn !== "function") {
      throw new Error(
        `PLUGIN_ACTIVATE_MISSING (${audit.pluginId}): entrypoint must export activate(api) or default(api).`
      );
    }

    const declaredTools = new Set(audit.manifest.capabilities?.codemodeTools ?? []);
    const declaredCommands = new Set(audit.manifest.capabilities?.slashCommands ?? []);
    const declaredPlatforms = new Set(audit.manifest.capabilities?.gatewayPlatforms ?? []);

    const tools = new Map<string, ExternalPluginToolDef>();
    const commands = new Map<string, ExternalPluginCommandDef>();
    const gatewayPlatforms: Array<`plugin:${string}`> = [];

    const api: ExternalPluginRegistrationApi = {
      registerTool: (def) => {
        if (!declaredTools.has(def.name)) {
          throw new Error(
            `PLUGIN_UNDECLARED_TOOL (${audit.pluginId}): tool '${def.name}' not listed in apex-plugin.json capabilities.codemodeTools.`
          );
        }
        tools.set(def.name, def);
      },
      registerCommand: (def) => {
        if (!declaredCommands.has(def.name)) {
          throw new Error(
            `PLUGIN_UNDECLARED_COMMAND (${audit.pluginId}): command '${def.name}' not listed in apex-plugin.json capabilities.slashCommands.`
          );
        }
        commands.set(def.name, def);
      },
      registerGatewayAdapter: (adapter) => {
        const expectedPlatform = `plugin:${audit.pluginId}:${adapter.platform.replace(/^plugin:/, "")}` as `plugin:${string}`;
        const shortName = adapter.platform.replace(/^plugin:/, "");
        if (!declaredPlatforms.has(shortName) && !declaredPlatforms.has(adapter.platform)) {
          throw new Error(
            `PLUGIN_UNDECLARED_GATEWAY (${audit.pluginId}): platform '${adapter.platform}' not listed in capabilities.gatewayPlatforms.`
          );
        }
        const wrapped: GatewayPlatformAdapter = {
          platform: expectedPlatform,
          send: adapter.send.bind(adapter)
        };
        gatewayPlatforms.push(expectedPlatform);
        this.getGateway?.().registerAdapter(wrapped);
      }
    };

    await activateFn(api);

    const record: LoadedPluginRecord = {
      manifest: audit.manifest,
      installedPath: destDir,
      scanVerdict: audit.scanVerdict,
      enabled: true,
      tools,
      commands,
      gatewayPlatforms
    };
    this.plugins.set(audit.manifest.id, record);
    return this.summarize(record);
  }

  public disablePlugin(pluginId: string): InstalledPluginSummary {
    const rec = this.plugins.get(pluginId);
    if (!rec) throw new Error(`PLUGIN_NOT_FOUND: '${pluginId}'`);
    rec.enabled = false;
    for (const p of rec.gatewayPlatforms) {
      this.getGateway?.().unregisterAdapter(p);
    }
    return this.summarize(rec);
  }

  public async enablePlugin(pluginId: string): Promise<InstalledPluginSummary> {
    this.checkMutationAllowed("enable or activate plugins");
    const rec = this.plugins.get(pluginId);
    if(!VALID_PLUGIN_ID_RE.test(pluginId))throw new Error("PLUGIN_INVALID_ID");
    if (rec) { const installedDir=rec.installedPath;for(const p of rec.gatewayPlatforms)this.getGateway?.().unregisterAdapter(p);this.plugins.delete(pluginId);return await this.installAndLoadPlugin(installedDir); }
    const installedDir=path.join(this.pluginsStoreDir,pluginId);
    if(!fs.existsSync(installedDir))throw new Error(`PLUGIN_NOT_FOUND: '${pluginId}'`);
    return await this.installAndLoadPlugin(installedDir);
  }

  public removePlugin(pluginId:string):{id:string;removed:boolean}{
    this.checkMutationAllowed("remove plugins");
    if(!VALID_PLUGIN_ID_RE.test(pluginId))throw new Error("PLUGIN_INVALID_ID");
    const rec=this.plugins.get(pluginId);if(rec){for(const p of rec.gatewayPlatforms)this.getGateway?.().unregisterAdapter(p);this.plugins.delete(pluginId);}
    const dir=path.join(this.pluginsStoreDir,pluginId);
    if(fs.existsSync(dir)){const st=fs.lstatSync(dir);if(st.isSymbolicLink()||!st.isDirectory())throw new Error("PLUGIN_REMOVE_PATH_UNSAFE");fs.rmSync(dir,{recursive:true,force:true});return {id:pluginId,removed:true};}
    return {id:pluginId,removed:Boolean(rec)};
  }

  public async invokePluginTool(
    pluginId: string,
    toolName: string,
    args: Record<string, unknown> = {}
  ): Promise<{ pluginId: string; toolName: string; output: unknown }> {
    const rec = this.plugins.get(pluginId);
    if (!rec) throw new Error(`PLUGIN_NOT_FOUND: '${pluginId}'`);
    if (!rec.enabled) throw new Error(`PLUGIN_DISABLED: '${pluginId}' is currently disabled.`);
    const tool = rec.tools.get(toolName);
    if (!tool) {
      throw new Error(`PLUGIN_TOOL_NOT_FOUND: '${toolName}' on plugin '${pluginId}'.`);
    }
    const isSafeRead = tool.readOnly === true || tool.mutabilityClass === "PURE_READ";
    if (!isSafeRead) {
      this.checkMutationAllowed(`invoke non-read-only tool '${toolName}'`);
    }
    const raw = await tool.execute(args);
    const scrubbed =
      typeof raw === "string"
        ? scrubSecretsInfallible(raw)
        : JSON.parse(scrubSecretsInfallible(JSON.stringify(raw ?? null)));
    return {
      pluginId,
      toolName,
      output: scrubbed
    };
  }

  public async invokePluginCommand(pluginIdOrCmd: string, rawArgs = ""): Promise<string> {
    for (const rec of this.plugins.values()) {
      if (!rec.enabled) continue;
      const cmd = rec.commands.get(pluginIdOrCmd);
      if (cmd) {
        const out = await cmd.execute(rawArgs);
        return scrubSecretsInfallible(String(out));
      }
    }
    throw new Error(`PLUGIN_COMMAND_NOT_FOUND: '${pluginIdOrCmd}'`);
  }

  public listPlugins(): InstalledPluginSummary[] {
    const result:InstalledPluginSummary[]=Array.from(this.plugins.values()).map((r) => ({...this.summarize(r),restoreState:"loaded"}));
    const loaded=new Set(result.map(p=>p.id));
    let dirs:string[]=[];try{dirs=fs.readdirSync(this.pluginsStoreDir);}catch{}
    for(const id of dirs){if(loaded.has(id)||!VALID_PLUGIN_ID_RE.test(id))continue;const dir=path.join(this.pluginsStoreDir,id);try{
      if(fs.lstatSync(dir).isSymbolicLink()||!fs.lstatSync(dir).isDirectory())continue;
      const audit=this.auditPluginDirectory(dir);const marker=path.join(dir,".apex-installed-sha256");
      const storedHash=fs.existsSync(marker)?fs.readFileSync(marker,"utf8").trim():"";const currentHash=this.hashPluginDirectory(dir);const hashMatches=storedHash===currentHash;
      result.push({id:audit.pluginId,name:audit.manifest.name,version:audit.manifest.version,description:audit.manifest.description,enabled:false,scanVerdict:audit.scanVerdict,tools:[],commands:[],gatewayPlatforms:[],installedPath:dir,restoreState:!hashMatches?"changed-on-disk":!audit.allowed?"audit-blocked":"stored-not-loaded"});
    }catch{result.push({id,name:id,version:"unknown",description:"Stored plugin could not be audited.",enabled:false,scanVerdict:"dangerous",tools:[],commands:[],gatewayPlatforms:[],installedPath:dir,restoreState:"audit-blocked"});}}
    return result;
  }

  private summarize(r: LoadedPluginRecord): InstalledPluginSummary {
    return {
      id: r.manifest.id,
      name: r.manifest.name,
      version: r.manifest.version,
      description: r.manifest.description,
      enabled: r.enabled,
      scanVerdict: r.scanVerdict,
      tools: Array.from(r.tools.values()).map((t) => ({
        qualifiedName: `plugin_${r.manifest.id}_${t.name}`,
        toolName: t.name,
        description: t.description
      })),
      commands: Array.from(r.commands.values()).map((c) => ({
        name: c.name,
        description: c.description
      })),
      gatewayPlatforms: [...r.gatewayPlatforms],
      installedPath: r.installedPath
    };
  }
}
