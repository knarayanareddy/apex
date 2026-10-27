/** Ring 12 first slice: custom connection safety, runtime registration, secret separation, and catalog endpoints. */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createSharedModelRuntime } from "../../src/core/ring0-session.ts";
import { ProviderManager, validateProviderBaseUrl } from "../../src/ring10/provider-manager.ts";
import { createSafeDnsLookup, isPublicUnicastAddress } from "../../src/ring10/safe-network.ts";
import { SkillLibrary } from "../../src/ring3/skill-library.ts";
import { ConfinedMcpHub, validateRemoteMcpUrl } from "../../src/ring6/mcp-confined-hub.ts";

const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"pi-apex-r12-"));
try {
  assert.equal(await validateProviderBaseUrl("http://127.0.0.1:11434/v1"),"http://127.0.0.1:11434/v1");
  assert.equal(isPublicUnicastAddress("8.8.8.8"),true);for(const ip of ["127.0.0.1","10.0.0.1","169.254.169.254","::1","fc00::1","fe80::1","ff02::1","::ffff:192.168.1.10"])assert.equal(isPublicUnicastAddress(ip),false,`${ip} is not public unicast`);
  const runLookup=(lookup:ReturnType<typeof createSafeDnsLookup>,host:string,options:any={})=>new Promise<any[]>((resolve,reject)=>lookup(host,options,(error,...values)=>error?reject(error):resolve(values)));
  assert.deepEqual(await runLookup(createSafeDnsLookup(async()=>[{address:"8.8.8.8",family:4}]),"pin.example"),["8.8.8.8",4]);
  await assert.rejects(()=>runLookup(createSafeDnsLookup(async()=>[{address:"8.8.8.8",family:4},{address:"127.0.0.1",family:4}]),"rebind.example"),/OUTBOUND_ADDRESS_BLOCKED/);
  await assert.rejects(()=>runLookup(createSafeDnsLookup(async()=>[{address:"::ffff:169.254.169.254",family:6}]),"mapped-rebind.example"),/OUTBOUND_ADDRESS_BLOCKED/);
  assert.deepEqual(await runLookup(createSafeDnsLookup(async()=>[{address:"127.0.0.1",family:4}]),"localhost"),["127.0.0.1",4]);
  await assert.rejects(()=>validateProviderBaseUrl("http://8.8.8.8/v1"),/PROVIDER_HTTPS_REQUIRED/);
  await assert.rejects(()=>validateProviderBaseUrl("https://10.1.2.3/v1"),/PROVIDER_PRIVATE_ADDRESS_BLOCKED/);
  await assert.rejects(()=>validateProviderBaseUrl("https://user:pass@8.8.8.8/v1"),/PROVIDER_URL_INVALID/);
  assert.equal(await validateRemoteMcpUrl("https://8.8.8.8/mcp"),"https://8.8.8.8/mcp");
  await assert.rejects(()=>validateRemoteMcpUrl("http://8.8.8.8/mcp"),/MCP_REMOTE_URL_INVALID/);
  await assert.rejects(()=>validateRemoteMcpUrl("https://127.0.0.1/mcp"),/MCP_REMOTE_PRIVATE_ADDRESS_BLOCKED/);
  await assert.rejects(()=>validateRemoteMcpUrl("https://user:pass@8.8.8.8/mcp"),/MCP_REMOTE_URL_INVALID/);
  const skillWs=path.join(tmp,"skill-ws");fs.mkdirSync(path.join(skillWs,".agents","skills","manual-checklist","references"),{recursive:true});
  fs.writeFileSync(path.join(skillWs,".agents","skills","manual-checklist","SKILL.md"),"---\nname: manual-checklist\ndescription: A user-saved skill for manual review.\n---\n# Manual checklist\nUse this workflow.");
  fs.writeFileSync(path.join(skillWs,".agents","skills","manual-checklist","references","guide.md"),"<script>not executed</script>");
  fs.mkdirSync(path.join(skillWs,".opencode","skills","other-skill"),{recursive:true});fs.writeFileSync(path.join(skillWs,".opencode","skills","other-skill","SKILL.md"),"---\nname: other-skill\ndescription: OpenCode-compatible external skill.\n---\n# Details");
  fs.symlinkSync("/etc/passwd",path.join(skillWs,".agents","skills","manual-checklist","references","escape.md"));
  const skillLibrary=new SkillLibrary({workspaceRoot:skillWs,listLedger:()=>[]});const skillEntries=skillLibrary.list();
  assert.equal(skillEntries.length,2,"filesystem skill inventory finds saved canonical and OpenCode-compatible skills without ledger rows");
  const manual=skillEntries.find(s=>s.name==="manual-checklist")!;assert.equal(manual.status,"active");
  const manualDetail=skillLibrary.read(manual.id);assert.equal(manualDetail.files.some(f=>f.path==="references/guide.md"),true);assert.equal(manualDetail.files.some(f=>f.path==="references/escape.md"),false,"skill viewer refuses symlinked support files");assert.match(manualDetail.files.find(f=>f.path==="references/guide.md")!.content,/script/);
  const mcpHub=new ConfinedMcpHub({workspaceRoot:skillWs});let remoteMockCalled=0;(mcpHub as any).connectWithTransport=async(params:any)=>{remoteMockCalled++;return {name:params.name,transportKind:"http",source:params.source,instructionsVerdict:"safe",instructionsPoisoned:false,totalTools:1,safeTools:1,poisonedTools:0};};
  await mcpHub.connectHttpServer({name:"public-docs",url:"https://8.8.8.8/mcp"});const savedMcpConfig=path.join(skillWs,".harness","mcp-remote-servers.json");assert.equal((fs.statSync(savedMcpConfig).mode&0o777),0o600,"remote MCP metadata is private");assert.deepEqual(JSON.parse(fs.readFileSync(savedMcpConfig,"utf8")).servers,[{name:"public-docs",url:"https://8.8.8.8/mcp"}]);await mcpHub.restorePersistedRemoteServers();assert.equal(remoteMockCalled,2,"saved remote MCP endpoints are revalidated and restored");
  await mcpHub.closeAll();
  const runtime=await createSharedModelRuntime(path.join(tmp,"agent"));
  const keys=new Map<string,string>();
  const vault={
    getProviderKeyForBackend:(id:string)=>keys.get(id)??null,
    saveProviderKey:async(id:string,key:string)=>{keys.set(id,key);await runtime.setRuntimeApiKey(id,key);return {provider:id,maskedKey:"masked"};},
    removeProviderKey:(id:string)=>{keys.delete(id);}
  } as any;
  const manager=new ProviderManager({agentDir:path.join(tmp,"agent"),modelRuntime:runtime,vault});
  const savedComplete=runtime.complete.bind(runtime);let oneShotRequestSeen=false;let oneShotContext="";
  (runtime as any).complete=async(model:any,context:any,options:any)=>{oneShotRequestSeen=true;oneShotContext=JSON.stringify(context);assert.match(model.provider,/^oneshot-[a-f0-9]{32}$/);assert.equal(options.maxRetries,0);assert.equal(options.maxTokens,512);assert.equal(options.timeoutMs,20000);return {stopReason:"stop",content:[{type:"text",text:"pi-apex-openrouter-ok"}]};};
  const oneShotSecret="one-shot-secret-never-persist-this";const oneShot=await manager.oneShotOpenRouterTest(oneShotSecret,"sample/model:free");assert.equal(oneShot.ok,true);assert.equal(oneShot.reply,"pi-apex-openrouter-ok");assert.equal(oneShotRequestSeen,true);assert.equal(oneShotContext.includes(oneShotSecret),false);assert.equal(manager.list().some(c=>c.id.startsWith("oneshot-")),false);assert.equal(runtime.getRegisteredProviderIds().some(id=>id.startsWith("oneshot-")),false,"temporary provider removed on success");assert.equal([...keys.values()].includes(oneShotSecret),false);assert.equal(JSON.stringify(manager.getStorePath()).includes(oneShotSecret),false);
  (runtime as any).complete=async()=>{throw new Error(`secret-bearing fake failure ${oneShotSecret}`);};await assert.rejects(()=>manager.oneShotOpenRouterTest(oneShotSecret,"sample/model:free"),/ONE_SHOT_PROVIDER_FAILED/);assert.equal(runtime.getRegisteredProviderIds().some(id=>id.startsWith("oneshot-")),false,"temporary provider removed on failure");(runtime as any).complete=savedComplete;
  const fetchBeforeAuthMock=globalThis.fetch;globalThis.fetch=(async(_input:any,init:any)=>{assert.equal(init.redirect,"error");assert.equal(init.headers.authorization,"Bearer auth-check-only");return new Response("secretless fixture",{status:401});}) as typeof fetch;await assert.rejects(()=>manager.verifyOpenRouterKey("auth-check-only"),/ONE_SHOT_AUTH_REJECTED/);globalThis.fetch=fetchBeforeAuthMock;
  const originalVerify=manager.verifyOpenRouterKey.bind(manager);(manager as any).verifyOpenRouterKey=async()=>{};
  try{const ephemeral=await manager.beginEphemeralOpenRouterSession("ephemeral-memory-only-key","sample/model:free");assert.ok(runtime.getModel(ephemeral.providerId,ephemeral.modelId));assert.equal(runtime.getModel(ephemeral.providerId,ephemeral.modelId)?.maxTokens,1024,"temporary chat has a useful but bounded response budget");await assert.rejects(()=>manager.beginEphemeralOpenRouterSession("ephemeral-memory-only-key","sample/model"),/ONE_SHOT_FREE_MODEL_REQUIRED/);assert.equal(manager.list().some(c=>c.id===ephemeral.providerId),false,"ephemeral chat test never enters persistent connections");assert.equal([...keys.values()].includes("ephemeral-memory-only-key"),false,"ephemeral key never enters vault adapter");manager.endEphemeralOpenRouterSession(ephemeral.providerId);assert.equal(runtime.getProvider(ephemeral.providerId),undefined,"explicit end removes temporary runtime provider");}
  finally{(manager as any).verifyOpenRouterKey=originalVerify;}
  const secret="r12-provider-secret-not-for-ui";
  const connection=await manager.add({name:"Personal Gateway",adapter:"openai-compatible",baseUrl:"https://8.8.8.8/v1",apiKey:secret,models:[{id:"qwen-3-coder",name:"Qwen 3 Coder",input:["text","image"],reasoning:true,contextWindow:128000,maxTokens:8192}]});
  assert.match(connection.id,/^custom-personal-gateway$/);
  assert.equal(runtime.getModel(connection.id,"qwen-3-coder")?.input.includes("image"),true);
  assert.equal(runtime.hasConfiguredAuth(connection.id),true);
  const secondConnection=await manager.add({name:"Personal Gateway",adapter:"openai-compatible",baseUrl:"https://8.8.8.8/v1",apiKey:"second-isolated-key",models:[{id:"llama-test",name:"Llama Test"}]});assert.notEqual(secondConnection.id,connection.id);assert.equal(keys.get(secondConnection.id),"second-isolated-key");
  const modelRef=`${connection.id}/qwen-3-coder`;manager.setFavorite(modelRef,true);manager.recordRecent(modelRef);assert.deepEqual(manager.getModelPreferences(),{favorites:[modelRef],recent:[modelRef]});
  const realFetch=globalThis.fetch;
  const remoteFixture={openai:{id:"openai",name:"OpenAI",models:{"gpt-demo":{"id":"gpt-demo","name":"GPT Demo","reasoning":true,"attachment":true,"modalities":{"input":["text","image"]},"limit":{"context":128000,"output":16000}},"embed-demo":{"id":"embed-demo","type":"embedding","name":"Embedding Demo"}}}};
  globalThis.fetch=(async()=>new Response(JSON.stringify(remoteFixture),{status:200,headers:{"content-type":"application/json"}})) as typeof fetch;
  const refreshed=await manager.refreshRemoteCatalog();assert.equal(refreshed.modelCount,1);assert.equal(manager.getRemoteCatalog()?.models[0]?.supportsImage,true);
  assert.equal((fs.statSync(path.join(tmp,"agent","models-dev-cache.json")).mode&0o777),0o600);
  globalThis.fetch=(async()=>{throw new Error("offline");}) as typeof fetch;
  await assert.rejects(()=>manager.refreshRemoteCatalog(),/REMOTE_CATALOG_REFRESH_FAILED/);assert.equal(manager.getRemoteCatalog()?.models.length,1,"stale cache survives refresh failure");globalThis.fetch=realFetch;
  let capturedAuth="";const mockServer=http.createServer((req,res)=>{capturedAuth=String(req.headers.authorization??req.headers["x-api-key"]??"");res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({data:[{id:"served-model"},{id:"served-model"},{id:"bad id"},{id:"vision-model",name:"Vision Model"}]}));});await new Promise<void>(resolve=>mockServer.listen(0,"127.0.0.1",resolve));const mockPort=(mockServer.address() as {port:number}).port;const localBase=`http://127.0.0.1:${mockPort}/v1`;
  const discovered=await manager.discoverOpenAICompatibleModels(localBase,"discovery-only-key");assert.deepEqual(discovered,[{id:"served-model",name:"served-model"},{id:"vision-model",name:"Vision Model"}]);assert.equal(capturedAuth,"Bearer discovery-only-key");assert.equal(JSON.stringify(discovered).includes("discovery-only-key"),false);
  const keyless=await manager.add({name:"Keyless Local",adapter:"openai-compatible",baseUrl:localBase,apiKey:"",models:discovered.map(m=>({id:m.id,name:m.name}))});assert.equal(keys.has(keyless.id),false,"keyless local endpoint does not persist an empty credential");assert.equal(runtime.getModel(keyless.id,"served-model")?.input.includes("image"),false,"discovered IDs do not imply image support");assert.equal(runtime.getModel(keyless.id,"served-model")?.reasoning,false,"discovered IDs do not imply reasoning support");const keylessCheck=await manager.testConnection(keyless.id);assert.equal(keylessCheck.ok,true);assert.equal(capturedAuth,"","keyless loopback connection test sends no Authorization header");
  await assert.rejects(()=>manager.discoverOpenAICompatibleModels("https://8.8.8.8/v1",""),/PROVIDER_KEY_REQUIRED_FOR_REMOTE_ENDPOINT/);
  const testConn=await manager.add({name:"Test Endpoint",adapter:"openai-compatible",baseUrl:localBase,apiKey:"test-only-key",models:[{id:"test-model",name:"Test Model"}]});const testResult=await manager.testConnection(testConn.id);assert.equal(testResult.ok,true);assert.equal(testResult.httpStatus,200);assert.equal(capturedAuth,"Bearer test-only-key");assert.equal(JSON.stringify(testResult).includes("test-only-key"),false);await manager.remove(testConn.id);await manager.remove(keyless.id);await new Promise<void>(resolve=>mockServer.close(()=>resolve()));
  const raw=fs.readFileSync(manager.getStorePath(),"utf8");
  assert.equal((fs.statSync(manager.getStorePath()).mode&0o777),0o600);
  assert.equal(raw.includes(secret),false,"metadata store must not contain API key");
  assert.equal(JSON.stringify(manager.list()).includes(secret),false,"provider inventory must not expose key");
  await assert.rejects(()=>manager.add({name:"Bad endpoint",adapter:"openai-compatible",baseUrl:"http://10.0.0.1/v1",apiKey:"x",models:[{id:"x",name:"x"}]}),/PROVIDER_HTTPS_REQUIRED|PROVIDER_PRIVATE_ADDRESS_BLOCKED/);
  await assert.rejects(()=>manager.add({name:"Bad model",adapter:"openai-compatible",baseUrl:"https://8.8.8.8/v1",apiKey:"x",models:[{id:"bad id",name:"bad"}]}),/PROVIDER_MODEL_INVALID/);
  const restored=new ProviderManager({agentDir:path.join(tmp,"agent"),modelRuntime:runtime,vault});
  await restored.restore();
  assert.ok(runtime.getModel(connection.id,"qwen-3-coder"),"saved connection rehydrates into ModelRuntime");
  await restored.setEnabled(connection.id,false);assert.equal(runtime.getProvider(connection.id),undefined);assert.equal(keys.get(connection.id),secret,"disable retains the vaulted key for explicit re-enable");
  const afterDisabledRestart=new ProviderManager({agentDir:path.join(tmp,"agent"),modelRuntime:runtime,vault});await afterDisabledRestart.restore();assert.equal(runtime.hasConfiguredAuth(connection.id),false,"disabled connection does not rehydrate runtime credentials");
  await restored.setEnabled(connection.id,true);assert.ok(runtime.getModel(connection.id,"qwen-3-coder"),"re-enable restores model and credential");
  await restored.remove(connection.id);await restored.remove(secondConnection.id);
  assert.equal(runtime.getProvider(connection.id),undefined);assert.equal(runtime.getProvider(secondConnection.id),undefined);
  assert.equal(keys.has(connection.id),false);assert.equal(keys.has(secondConnection.id),false);assert.deepEqual(restored.getModelPreferences(),{favorites:[],recent:[]},"disconnect clears stale model preference references");
  console.log(JSON.stringify({ring12_unitPassed:true,checks:[
    "R12-0 Skills Library filesystem discovery/detail view, compatible folders, and symlink-safe reads: PASS",
    "R12-0 Remote MCP HTTPS/private-address validation, private metadata persistence, and revalidation on restore: PASS",
    "R12-1 compatible adapter/model validation and live ModelRuntime registration: PASS",
    "R12-6 bounded OpenAI-compatible model discovery, keyless loopback, and conservative unknown capabilities: PASS",
    "R12-2 metadata file mode 0600 and API key separated into vault adapter: PASS",
    "R12-4 HTTPS requirement, private-address, URL-credential, IPv4-mapped IPv6 and request-time DNS-rebinding rejection: PASS",
    "R12-3 models.dev metadata cache, chat-only filtering, 0600 permissions, bounded refresh and stale-cache fallback: PASS",
    "R12-5 saved custom connection restore and disconnect/key revocation: PASS",
    "R12 one-shot + ephemeral OpenRouter: auth preflight and rejected-key classification, no vault persistence, temporary chat provider cleanup and bounded output: PASS"
  ]},null,2));
} finally { fs.rmSync(tmp,{recursive:true,force:true}); }
