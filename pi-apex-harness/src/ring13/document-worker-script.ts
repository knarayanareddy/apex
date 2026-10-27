// This source is executed only inside the Linux bubblewrap namespace. Keep its input/output protocol
// deliberately small: bytes and plain, bounded JSON only; never pass filesystem paths or URLs.
export const DOCUMENT_WORKER_SCRIPT = String.raw`
import { OfficeParser } from "officeparser";
const MAX_TEXT = 100000;
const MAX_SEGMENTS = 5000;
const MAX_OUTPUT_BYTES = 24 * 1024 * 1024;
const inputChunks=[]; let inputBytes=0;
for await (const chunk of process.stdin) { inputBytes+=chunk.length; if(inputBytes>38*1024*1024) throw new Error("worker input limit exceeded"); inputChunks.push(chunk); }
const request=JSON.parse(Buffer.concat(inputChunks).toString("utf8"));
const config={
  ocr:false, extractAttachments:false, includeRawContent:false, ignoreComments:true,
  ignoreHeadersAndFooters:true, ignoreSlideMasters:true, ignoreInternalLinks:true,
  decompressionLimits:{maxZipEntries:2000,maxUncompressedBytes:100*1024*1024,maxXmlElements:300000,maxTableCells:100000,maxRawContentLength:0,maxRepeatedContent:200000},
  pdfParserConfig:{separateProcess:true,processMemoryMb:1024,pageRange:"1-251",maxTextItems:500000,maxOperators:2000000,maxTimeMs:10000},
};
function safeWarn(v){const text=v&&typeof v==="object"?String(v.code??v.type??"ISSUE")+": "+String(v.message??""):String(v??"");return text.replace(/[\u0000-\u001f\u007f]/g," ").slice(0,500)}
function preflightZip(data,format){
  if(data.length<22||data[0]!==0x50||data[1]!==0x4b) throw new Error("invalid OOXML ZIP signature");
  const min=Math.max(0,data.length-65557); let eocd=-1;
  for(let i=data.length-22;i>=min;i--){if(data.readUInt32LE(i)===0x06054b50){eocd=i;break;}}
  if(eocd<0) throw new Error("malformed ZIP central directory");
  const disk=data.readUInt16LE(eocd+4), cDisk=data.readUInt16LE(eocd+6), diskCount=data.readUInt16LE(eocd+8), entries=data.readUInt16LE(eocd+10), cdSize=data.readUInt32LE(eocd+12), cdOffset=data.readUInt32LE(eocd+16);
  if(disk!==0||cDisk!==0||diskCount!==entries||entries===0xffff||cdSize===0xffffffff||cdOffset===0xffffffff||entries>2000||cdOffset+cdSize>eocd) throw new Error("unsupported or oversized ZIP central directory");
  const names=new Set(); let p=cdOffset,total=0; const required=new Set(); let slides=0,sheets=0;
  for(let n=0;n<entries;n++){
    if(p+46>eocd||data.readUInt32LE(p)!==0x02014b50) throw new Error("malformed ZIP entry record");
    const flags=data.readUInt16LE(p+8), method=data.readUInt16LE(p+10), compressed=data.readUInt32LE(p+20), expanded=data.readUInt32LE(p+24), nameLen=data.readUInt16LE(p+28), extraLen=data.readUInt16LE(p+30), commentLen=data.readUInt16LE(p+32), diskStart=data.readUInt16LE(p+34), local=data.readUInt32LE(p+42);
    if((flags&1)||(flags&64)||diskStart!==0||![0,8].includes(method)||expanded===0xffffffff||compressed===0xffffffff||local===0xffffffff) throw new Error("encrypted, ZIP64, or unsupported ZIP entry");
    const end=p+46+nameLen+extraLen+commentLen; if(end>eocd) throw new Error("truncated ZIP directory entry");
    if(local+30>cdOffset||data.readUInt32LE(local)!==0x04034b50) throw new Error("invalid ZIP local file header");
    const localName=data.readUInt16LE(local+26),localExtra=data.readUInt16LE(local+28);
    if(localName!==nameLen||local+30+localName+localExtra+compressed>cdOffset) throw new Error("truncated ZIP local file data");
    if(!data.subarray(local+30,local+30+localName).equals(data.subarray(p+46,p+46+nameLen))) throw new Error("ZIP local and central names differ");
    const name=data.subarray(p+46,p+46+nameLen).toString("utf8");
    if(!name||name.includes("\\")||name.startsWith("/")||name.split("/").includes("..")||name.split("/").includes(".")) throw new Error("unsafe ZIP entry path");
    if(names.has(name)) throw new Error("duplicate ZIP entry name"); names.add(name);
    total+=expanded; if(total>100*1024*1024||expanded>64*1024*1024||(compressed===0&&expanded>0)||(compressed>0&&expanded/compressed>1000)) throw new Error("ZIP expansion limit exceeded");
    if(name==="[Content_Types].xml") required.add("types");
    if(format==="docx"&&name==="word/document.xml") required.add("main");
    if(format==="pptx"&&name==="ppt/presentation.xml") required.add("main");
    if(format==="pptx"&&/^ppt\/slides\/slide\d+\.xml$/.test(name)) slides++;
    if(format==="xlsx"&&name==="xl/workbook.xml") required.add("main");
    if(format==="xlsx"&&/^xl\/worksheets\/sheet\d+\.xml$/.test(name)) sheets++;
    p=end;
  }
  if(p!==cdOffset+cdSize) throw new Error("ZIP central directory length mismatch");
  if(!required.has("types")||!required.has("main")||(format==="pptx"&&!slides)||(format==="xlsx"&&!sheets)) throw new Error("ZIP contents do not match the declared Office format");
  if(format==="pptx"&&slides>200) throw new Error("document exceeds the 200-slide limit");
  if(format==="xlsx"&&sheets>25) throw new Error("document exceeds the 25-sheet limit");
}
function extractPlainText(data,format){
  const source=data.toString("utf8").replaceAll("\r\n","\n").replaceAll("\r","\n");
  const clipped=source.length>MAX_TEXT; const text=source.slice(0,MAX_TEXT); const lines=text.split("\n");
  const segments=[]; let offset=0; let collapsed=false;
  for(let index=0;index<lines.length;index++){
    const line=lines[index]; const lineStart=offset; offset+=line.length+1;
    if(!line.trim())continue;
    if(segments.length>=MAX_SEGMENTS-1){segments.push({kind:"other",locator:{},text:text.slice(lineStart)});collapsed=true;break;}
    const trimmed=line.trimStart(); let hashes=0; while(hashes<trimmed.length&&hashes<7&&trimmed[hashes]==="#")hashes++;
    const isHeading=format==="md"&&hashes>0&&hashes<=6&&trimmed[hashes]===" ";
    const kind=isHeading?"heading":line.startsWith(String.fromCharCode(96,96,96))||line.startsWith("    ")?"code":"paragraph";
    segments.push({kind,locator:{line:index+1},text:line.slice(0,10000)});
    if(line.length>10000){segments.push({kind:"other",locator:{},text:text.slice(lineStart+10000)});collapsed=true;break;}
  }
  const warnings=[];if(clipped)warnings.push("Text extraction was capped at 100,000 characters.");if(collapsed)warnings.push("Remaining source text is included in a locator-unavailable segment because the line count exceeded the provenance limit.");
  return {format,text,segments:segments.slice(0,MAX_SEGMENTS),counts:{},warnings,truncated:clipped,parserVersion:"pi-apex-plain-text-adapter@1"};
}
function payload(value){
  if(value&&typeof value==="object"&&"value" in value) value=value.value;
  if(typeof value==="string") return Buffer.from(value,"utf8");
  if(Buffer.isBuffer(value)) return value;
  if(value instanceof Uint8Array) return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
  throw new Error("generator returned unsupported output");
}
function walk(nodes, inherited, out, counts, depth=0){
  if(!Array.isArray(nodes)||depth>80) return;
  for(const node of nodes){
    if(!node||typeof node!=="object") continue;
    const type=String(node.type??"").toLowerCase();
    const md=node.metadata&&typeof node.metadata==="object"?node.metadata:{};
    const loc={...inherited};
    if(type==="page"&&Number.isInteger(md.pageNumber)) loc.page=md.pageNumber;
    if(type==="slide"&&Number.isInteger(md.slideNumber)) loc.slide=md.slideNumber;
    if(type==="sheet"&&typeof md.sheetName==="string") loc.sheet=md.sheetName.slice(0,160);
    if(type==="cell"&&Number.isInteger(md.row)&&Number.isInteger(md.col)){loc.row=md.row+1;loc.column=md.col+1;counts.cells++;}
    const childNodes=Array.isArray(node.children)?node.children:[];
    const text=typeof node.text==="string"?node.text.trim():"";
    const eligible=["heading","paragraph","cell","code","note"].includes(type);
    if(text&&eligible&&!(type==="cell"&&childNodes.some(child=>["paragraph","heading","cell","table","row"].includes(String(child?.type??""))))&&out.length<MAX_SEGMENTS){
      const kind=type==="heading"?"heading":type==="cell"?"cell":type==="code"?"code":type==="note"?"note":"paragraph";
      if(!loc.page&&!loc.slide&&!loc.sheet) loc.block=out.length+1;
      out.push({kind,locator:loc,text:text.slice(0,10000)});
    }
    if(Array.isArray(node.children)) walk(node.children,loc,out,counts,depth+1);
  }
}
try {
if(request.action==="extract"){
  const data=Buffer.from(request.data,"base64");
  if(data.length>25*1024*1024) throw new Error("document exceeds 25 MiB");
  if(["docx","pptx","xlsx"].includes(request.format)) preflightZip(data,request.format);
  if(request.format==="pdf"&&!data.subarray(0,8).toString("ascii").startsWith("%PDF-")) throw new Error("PDF signature does not match the selected format");
  if(request.format==="md"||request.format==="txt"){
    process.stdout.write(JSON.stringify({ok:true,result:extractPlainText(data,request.format)}));
  }else{
  const ast=await OfficeParser.parseOffice(data,{...config,fileType:request.format});
  const converted=await ast.to("md");
  const text=typeof converted==="string"?converted:typeof converted?.value==="string"?converted.value:"";
  const segments=[]; const counts={cells:0}; walk(ast.content,{},segments,counts);
  const locatorFallback=segments.length===0&&Boolean(text.trim());
  if(locatorFallback)segments.push({kind:"other",locator:{},text:text.slice(0,MAX_TEXT)});
  const pages=ast.content?.filter(n=>n?.type==="page").length??0;
  const slides=ast.content?.filter(n=>n?.type==="slide").length??0;
  const sheets=ast.content?.filter(n=>n?.type==="sheet").length??0;
  if(pages>250||slides>200||sheets>25) throw new Error("document exceeds configured page, slide, or sheet limit");
  let segmentBudget=MAX_TEXT; const boundedSegments=[];
  for(const segment of segments){if(segmentBudget<=0)break;const part=segment.text.slice(0,segmentBudget);if(part){boundedSegments.push({...segment,text:part});segmentBudget-=part.length;}}
  const clipped=text.length>MAX_TEXT||boundedSegments.length<segments.length||segmentBudget===0&&segments.reduce((n,s)=>n+s.text.length,0)>MAX_TEXT;
  const warnings=Array.isArray(ast.warnings)?ast.warnings.slice(0,100).map(safeWarn):[];
  if(locatorFallback)warnings.push("Parser supplied no granular text-node locators; this excerpt's source position is unavailable.");
  if(warnings.some(w=>/TABLE_CELL_LIMIT_EXCEEDED|ZIP_ENTRY_LIMIT_EXCEEDED|ZIP_UNCOMPRESSED_LIMIT_EXCEEDED|XML_ELEMENT_LIMIT_EXCEEDED/.test(w)))throw new Error("document exceeds a structural parser limit");
  if(boundedSegments.length<segments.length||clipped&&segments.reduce((n,s)=>n+s.text.length,0)>MAX_TEXT)warnings.push("Source locator segments were capped at 100,000 characters.");
  if(request.format==="pdf"&&pages){const found=new Set(segments.map(s=>s.locator.page).filter(Number.isInteger));const empty=[];for(let p=1;p<=pages;p++)if(!found.has(p))empty.push(p);if(empty.length)warnings.push("No extractable text on PDF page(s) "+empty.slice(0,20).join(", ")+(empty.length>20?", …":"")+"; OCR is disabled.");}
  if(request.format==="xlsx")warnings.push("Spreadsheet formulas are not calculated; extraction preserves parser-provided cell text/values only, and formula text may be unavailable.");
  if(request.format==="pptx")warnings.push("Embedded images, charts and other media are not extracted; slide text may be incomplete.");
  const countsOut={cells:counts.cells};
  if(pages) countsOut.pages=pages; if(slides) countsOut.slides=slides; if(sheets) countsOut.sheets=sheets;
  process.stdout.write(JSON.stringify({ok:true,result:{format:request.format,text:text.slice(0,MAX_TEXT),segments:boundedSegments,counts:countsOut,warnings,truncated:clipped,parserVersion:"officeparser@8.3.0"}}));
  }
}else if(request.action==="selftest"){
  if(Number.isInteger(request.delayMs)&&request.delayMs>0&&request.delayMs<=10000)await new Promise(resolve=>setTimeout(resolve,request.delayMs));
  const fs=await import("node:fs"); const net=await import("node:net");
  const networkBlocked=await new Promise(resolve=>{const socket=net.createConnection({host:"1.1.1.1",port:443,timeout:1200});socket.once("connect",()=>{socket.destroy();resolve(false);});socket.once("error",()=>resolve(true));socket.once("timeout",()=>{socket.destroy();resolve(true);});});
  const limits=fs.readFileSync("/proc/self/limits","utf8");
  process.stdout.write(JSON.stringify({ok:true,result:{cwd:process.cwd(),home:process.env.HOME??null,envKeys:Object.keys(process.env).sort(),homeVisible:fs.existsSync("/home"),rootHomeVisible:fs.existsSync("/root"),parserModulesVisible:fs.existsSync("/app/node_modules/officeparser")&&fs.existsSync("/app/node_modules/pdf-lib"),unrelatedAppModulesHidden:!fs.existsSync("/app/node_modules/@earendil-works/pi-coding-agent"),networkBlocked,procEntries:fs.readdirSync("/proc").filter(x=>/^\d+$/.test(x)).length,tmpEntries:fs.readdirSync("/tmp"),limits}}));
}else if(request.action==="export"){
  if(typeof request.markdown!=="string"||request.markdown.length>100000) throw new Error("export content exceeds 100,000 characters");
  const ast=await OfficeParser.parseOffice(Buffer.from(request.markdown,"utf8"),{...config,fileType:"md"});
  const options=request.format==="pdf"?{pdfConfig:{engine:"native"}}:request.format==="html"?{htmlConfig:{standalone:{document:true,metaTags:false,styles:"full",scripts:false,headInjections:false,bodyInjections:false},gatedEmbeds:true,sourceAttributes:false}}:{};
  const bytes=payload(await ast.to(request.format,options));
  if(bytes.length>MAX_OUTPUT_BYTES) throw new Error("generated document exceeds 24 MiB");
  process.stdout.write(JSON.stringify({ok:true,result:{data:bytes.toString("base64"),bytes:bytes.length,format:request.format}}));
}else throw new Error("unsupported worker action");
}catch(error){
  const raw=safeWarn(error?.message??"parse failed").toLowerCase();
  const code=/password|encrypt/.test(raw)?"DOCUMENT_ENCRYPTED":/limit|exceed|too large/.test(raw)?"DOCUMENT_LIMIT":/signature|central directory|contents do not match|zip entry/.test(raw)?"DOCUMENT_INVALID":/cancel|abort/.test(raw)?"DOCUMENT_CANCELLED":"DOCUMENT_PARSE_FAILED";
  process.stdout.write(JSON.stringify({ok:false,code}));
}
`;
