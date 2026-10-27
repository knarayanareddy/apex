import fs from "node:fs";
import path from "node:path";
import { scrubSecretsInfallible } from "../core/spill-store.ts";
import { getLinuxFsBridge } from "../core/linux-fs-bridge.ts";

const MAX_DEPTH=8;
const MAX_RESULTS=20;
const MAX_FILE_BYTES=256*1024;
const MAX_SCAN_BYTES=8*1024*1024;

function assertMarkdownRelPath(rel:string):string {
  if(!rel||rel.includes("\\")||path.posix.isAbsolute(rel)||rel.split("/").some(part=>!part||part==="."||part===".."||part.startsWith(".")))throw new Error("OBSIDIAN_PATH_INVALID");
  if(path.posix.extname(rel).toLowerCase()!==".md")throw new Error("OBSIDIAN_MARKDOWN_ONLY");
  return rel;
}

export class ObsidianVaultReader {
  readonly root:string;
  private readonly rootFd:number;
  private closed=false;
  constructor(rootPath:string){
    const st=fs.lstatSync(rootPath);
    if(st.isSymbolicLink()||!st.isDirectory())throw new Error("OBSIDIAN_VAULT_ROOT_INVALID");
    this.root=fs.realpathSync(rootPath);
    this.rootFd=getLinuxFsBridge().openRootDir(this.root);
  }
  dispose():void{if(!this.closed){fs.closeSync(this.rootFd);this.closed=true;}}
  private assertOpen():void{if(this.closed)throw new Error("OBSIDIAN_VAULT_CLOSED");}
  status():{enabled:true;readOnly:true;markdownOnly:true}{return {enabled:true,readOnly:true,markdownOnly:true};}
  private walk():Array<{path:string;absolute:string;size:number}>{
    const found:Array<{path:string;absolute:string;size:number}>=[];let totalBytes=0;
    const visit=(dir:string,depth:number)=>{
      if(depth>MAX_DEPTH||found.length>=1000)return;
      let entries:fs.Dirent[];try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch{return;}
      for(const entry of entries){
        if(entry.name.startsWith(".")||entry.name===".obsidian"||entry.name===".trash"||entry.name==="node_modules")continue;
        const abs=path.join(dir,entry.name);let st:fs.Stats;try{st=fs.lstatSync(abs);}catch{continue;}
        if(st.isSymbolicLink())continue;
        if(st.isDirectory()){visit(abs,depth+1);continue;}
        if(!st.isFile()||path.extname(entry.name).toLowerCase()!==".md"||st.size>MAX_FILE_BYTES||totalBytes+st.size>MAX_SCAN_BYTES)continue;
        totalBytes+=st.size;found.push({path:path.relative(this.root,abs).split(path.sep).join("/"),absolute:abs,size:st.size});
        if(found.length>=1000)break;
      }
    };
    visit(this.root,0);return found.sort((a,b)=>a.path.localeCompare(b.path));
  }
  list(limit=MAX_RESULTS):Array<{path:string;sizeBytes:number}>{
    const bounded=Math.max(1,Math.min(MAX_RESULTS,Math.floor(limit)||1));
    return this.walk().slice(0,bounded).map(x=>({path:x.path,sizeBytes:x.size}));
  }
  read(rel:string):{path:string;content:string;sizeBytes:number}{
    this.assertOpen();const safeRel=assertMarkdownRelPath(rel);
    const fd=getLinuxFsBridge().openBeneath(this.rootFd,safeRel,fs.constants.O_RDONLY,0);
    try{const st=fs.fstatSync(fd);if(!st.isFile()||st.size>MAX_FILE_BYTES)throw new Error("OBSIDIAN_FILE_LIMIT_OR_TYPE");const content=fs.readFileSync(fd,"utf8");return {path:safeRel,content:scrubSecretsInfallible(content),sizeBytes:st.size};}finally{fs.closeSync(fd);}
  }
  search(query:string,limit=10):Array<{path:string;excerpt:string}>{
    const terms=[...new Set((query.normalize("NFKC").match(/[\p{L}\p{N}_-]{2,64}/gu)??[]).slice(0,8).map(s=>s.toLocaleLowerCase()))];
    if(!terms.length)throw new Error("OBSIDIAN_QUERY_NO_SEARCHABLE_TERMS");
    const bounded=Math.max(1,Math.min(MAX_RESULTS,Math.floor(limit)||1));const matches:Array<{path:string;excerpt:string}>=[];
    for(const entry of this.walk()){
      if(matches.length>=bounded)break;
      let text:string;try{text=this.read(entry.path).content;}catch{continue;}
      const lower=text.toLocaleLowerCase();if(!terms.some(term=>lower.includes(term)))continue;
      const at=Math.max(0,Math.min(...terms.map(term=>{const i=lower.indexOf(term);return i<0?Number.POSITIVE_INFINITY:i})));
      const excerpt=text.slice(Math.max(0,at-180),Math.min(text.length,at+420)).replace(/\s+/g," ");
      matches.push({path:entry.path,excerpt:scrubSecretsInfallible(excerpt)});
    }
    return matches;
  }
}
