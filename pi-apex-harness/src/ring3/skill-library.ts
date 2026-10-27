import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import { getLinuxFsBridge } from "../core/linux-fs-bridge.ts";
import { validateSkillFrontmatter } from "./skills-guard-quarantine.ts";

const SOURCE_DIRS = [".agents/skills", ".opencode/skills", ".claude/skills"] as const;
const MAX_DEPTH = 6;
const MAX_FILES = 200;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", ".venv", ".harness"]);

function safeReadText(file:string,maxBytes=MAX_FILE_BYTES):string{
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>maxBytes)throw new Error("SKILL_FILE_LIMIT_OR_TYPE");return fs.readFileSync(fd,"utf8");}finally{fs.closeSync(fd);}
}

export interface SkillLibraryEntry {
  id: string;
  name: string;
  description: string;
  source: string;
  sourceKind: "canonical" | "compatible" | "quarantine" | "archive";
  status: "active" | "stale" | "quarantined" | "archived" | "external" | "invalid";
  scanVerdict?: string;
  contentSha256: string;
  managed: boolean;
  files: string[];
  warnings: string[];
  pathLabel: string;
}

function safeWalkFiles(dir: string, depth = 0, total = { bytes: 0 }, out: string[] = []): string[] {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let st: fs.Stats;
    try { st = fs.lstatSync(full); } catch { continue; }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) safeWalkFiles(full, depth + 1, total, out);
    else if (st.isFile() && st.size <= MAX_FILE_BYTES && total.bytes + st.size <= MAX_TOTAL_BYTES) {
      total.bytes += st.size;
      out.push(full);
    }
    if (out.length >= MAX_FILES) break;
  }
  return out;
}

function parseSkill(dir: string, root: string, source: string, sourceKind: SkillLibraryEntry["sourceKind"], ledger: Map<string, {status:string;scanVerdict:string;contentSha256:string}>): SkillLibraryEntry | null {
  const mdPath = path.join(dir, "SKILL.md");
  let st: fs.Stats;
  try { st = fs.lstatSync(mdPath); } catch { return null; }
  if (!st.isFile() || st.isSymbolicLink() || st.size > MAX_FILE_BYTES) return null;
  let content = "";
  try { content = safeReadText(mdPath); } catch { return null; }
  const checked = validateSkillFrontmatter(content);
  const parsed = checked.valid ? checked.parsed : null;
  const folderName = path.basename(dir);
  const name = parsed?.name ?? folderName;
  const description = parsed?.description ?? "Invalid or missing SKILL.md frontmatter";
  const files = safeWalkFiles(dir).map(file => path.relative(dir, file).replace(/\\/g, "/")).sort();
  if (!files.includes("SKILL.md")) files.unshift("SKILL.md");
  const rel = path.relative(root, dir).replace(/\\/g, "/");
  const id = createHash("sha256").update(`${source}\0${dir}`).digest("hex").slice(0, 24);
  const rec = ledger.get(name);
  const warnings: string[] = [];
  if (!checked.valid) warnings.push(checked.error || "Invalid frontmatter");
  if (parsed && parsed.name !== folderName) warnings.push(`Skill name '${parsed.name}' does not match directory '${folderName}'.`);
  return {
    id, name, description, source, sourceKind,
    status: !checked.valid ? "invalid" : sourceKind === "quarantine" ? "quarantined" : sourceKind === "archive" ? "archived" : rec?.status === "active" ? "active" : rec?.status === "stale" ? "stale" : rec?.status === "quarantined" ? "quarantined" : rec?.status === "archived" ? "archived" : sourceKind === "canonical" ? "active" : "external",
    ...(rec?.scanVerdict ? { scanVerdict: rec.scanVerdict } : {}),
    contentSha256: rec?.contentSha256 || createHash("sha256").update(content).digest("hex"),
    managed: Boolean(rec) || sourceKind === "quarantine" || sourceKind === "archive",
    files, warnings, pathLabel: rel || "."
  };
}

export class SkillLibrary {
  private readonly workspaceRoot: string;
  private readonly listLedger: () => Array<{name:string;status:string;lastScanVerdict:string;contentSha256:string}>;
  private readonly extraRoots: Array<{path:string;label:string;kind:SkillLibraryEntry["sourceKind"]}>;
  private locations = new Map<string, string>();
  private allowedRoots = new Set<string>();
  constructor(opts: {workspaceRoot:string;listLedger:()=>Array<{name:string;status:string;lastScanVerdict:string;contentSha256:string}>;extraRoots?:Array<{path:string;label:string;kind:SkillLibraryEntry["sourceKind"]}>}) {
    this.workspaceRoot = fs.realpathSync(opts.workspaceRoot);
    this.listLedger = opts.listLedger;
    this.extraRoots = opts.extraRoots ?? [];
  }
  list(): SkillLibraryEntry[] {
    this.locations = new Map();
    this.allowedRoots = new Set();
    const ledger = new Map(this.listLedger().map(row => [row.name,{status:row.status,scanVerdict:row.lastScanVerdict,contentSha256:row.contentSha256}]));
    const roots: Array<{path:string;label:string;kind:SkillLibraryEntry["sourceKind"]}> = [];
    let curr = this.workspaceRoot;
    for (;;) {
      for (const rel of SOURCE_DIRS) {
        const dir = path.join(curr, rel);
        if (fs.existsSync(dir)) roots.push({path:dir,label:path.relative(this.workspaceRoot,dir).startsWith("..") ? `ancestor/${path.relative(curr,dir)}` : path.relative(this.workspaceRoot,dir) || rel,kind:rel===".agents/skills"?"canonical":"compatible"});
      }
      if (fs.existsSync(path.join(curr,".git")) || path.dirname(curr)===curr) break;
      curr = path.dirname(curr);
    }
    for(const extra of this.extraRoots) if(fs.existsSync(extra.path)) roots.push(extra);
    const found: SkillLibraryEntry[] = [];
    const seen = new Set<string>();
    for (const root of roots) {
      let real: string;
      try { const rootStat=fs.lstatSync(root.path);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())continue;real = fs.realpathSync(root.path); } catch { continue; }
      this.allowedRoots.add(real);
      if (seen.has(real)) continue; seen.add(real);
      const walk = (dir:string,depth:number) => {
        if(depth>MAX_DEPTH) return;
        let entries:fs.Dirent[];try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
        for(const entry of entries){
          if(entry.name.startsWith(".")||SKIP_DIRS.has(entry.name)||entry.isSymbolicLink()||!entry.isDirectory())continue;
          const child=path.join(dir,entry.name);
          const skill=parseSkill(child,this.workspaceRoot,root.label,root.kind,ledger);
          if(skill){found.push(skill);this.locations.set(skill.id,child);continue;}
          walk(child,depth+1);
        }
      };
      walk(real,0);
    }
    return found.sort((a,b)=>a.name.localeCompare(b.name)||a.source.localeCompare(b.source));
  }
  read(id:string, requestedPaths?: readonly string[]): {entry:SkillLibraryEntry;files:Array<{path:string;content:string}>} {
    const entry=this.list().find(item=>item.id===id);if(!entry)throw new Error("SKILL_NOT_FOUND");
    const root=this.locations.get(id);
    if(!root) throw new Error("SKILL_PATH_UNSAFE");
    const realRoot=fs.realpathSync(root);
    if(![...this.allowedRoots].some(base=>realRoot.startsWith(base+path.sep))) throw new Error("SKILL_PATH_UNSAFE");
    const bundle=safeWalkFiles(realRoot);
    const available=new Map(bundle.map(file=>[path.relative(realRoot,file).replace(/\\/g,"/"),file]));
    const selectedPaths=requestedPaths??[...available.keys()].filter(rel=>/\.(?:md|txt|json|ya?ml|toml|ts|js|py|sh)$/i.test(rel));
    if(selectedPaths.length>10)throw new Error("SKILL_FILE_COUNT_LIMIT");
    const unique=[...new Set(selectedPaths)];
    const rootFd=getLinuxFsBridge().openRootDir(realRoot);
    let files:Array<{path:string;content:string}>;
    try{
      files=unique.map(rel=>{
        if(!rel||path.posix.isAbsolute(rel)||rel.split("/").some(part=>!part||part==="."||part==="..")||rel.includes("\\"))throw new Error("SKILL_FILE_PATH_INVALID");
        if(!/\.(?:md|txt|json|ya?ml|toml|ts|js|py|sh)$/i.test(rel))throw new Error("SKILL_FILE_NOT_TEXT");
        if(!available.has(rel))throw new Error("SKILL_FILE_NOT_FOUND");
        const fd=getLinuxFsBridge().openBeneath(rootFd,rel,fs.constants.O_RDONLY,0);
        try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>MAX_FILE_BYTES)throw new Error("SKILL_FILE_LIMIT_OR_TYPE");const body=fs.readFileSync(fd,"utf8");return {path:rel,content:scrubSecretsInfallible(body)};}finally{fs.closeSync(fd);}
      }).sort((a,b)=>a.path.localeCompare(b.path));
    }finally{fs.closeSync(rootFd);}
    if(!files.some(f=>f.path==="SKILL.md"))throw new Error("SKILL_FILE_MISSING");
    return {entry,files};
  }
}
