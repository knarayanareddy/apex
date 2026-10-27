import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import { clearTimeout } from "node:timers";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, openSync, closeSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const docker = process.argv.includes("--docker") || process.env.RAFT_MODE === "docker";
const root = mkdtempSync(join(tmpdir(), "raft-jepsen-"));
const project = `raft-jepsen-${process.pid}`;
const agent = new http.Agent({ keepAlive: false, maxSockets: 64 });
const children = new Map();
const expected = new Map();
const nodes = [];
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let cleaning;
let abort = false;
let monitor;
let monitorStopped = false;
let monitorError;
let committedPrefix = [];
const environment = { ...process.env, RAFT_DATA_ROOT: root, RAFT_FAULT_INJECTION: "1" };
function compose(...args) {
  return execFileSync("docker", ["compose", "-p", project, "-f", "docker-compose.cluster.yml", ...args], { env: environment, stdio: "pipe", timeout: 120000 }).toString();
}
async function freePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
function call(node, route, body = {}, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(new URL(route, node.client), {
      method: "POST", agent, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
    }, res => {
      let data = "";
      res.on("data", chunk => { data += chunk; });
      res.on("error", reject);
      res.on("end", () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode !== 200) reject(new Error(result.error)); else resolve(result);
        } catch (error) { reject(error); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error("CLIENT_TIMED_OUT")), timeout);
    req.on("close", () => clearTimeout(timer)); req.on("error", reject); req.end(payload);
  });
}
async function until(fn, message, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let error;
  while (!abort && Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (e) { error = e; }
    await sleep(40);
  }
  throw new Error(`${message}: ${error?.message ?? "deadline expired"}`);
}
async function leader(candidates = nodes) {
  return until(async () => {
    const statuses = await Promise.all(candidates.map(async node => {
      try { return { node, status: await call(node, "/health", {}, 600) }; } catch { return null; }
    }));
    const leaders = statuses.filter(item => item?.status.role === "leader");
    // Election safety is checked per term, including old minority leaders.
    const terms = new Set();
    for (const item of leaders) { assert(!terms.has(item.status.term), "two leaders in the same term"); terms.add(item.status.term); }
    return leaders.sort((a, b) => b.status.term - a.status.term)[0]?.node;
  }, "leader election failed");
}
async function start(node) {
  if (docker) { compose("up", "-d", node.id); return; }
  const fd = openSync(join(root, `${node.id}.out`), "a");
  try {
    const child = spawn(process.execPath, ["packages/consensus/src/server.ts"], {
      env: { ...environment, RAFT_ID: node.id, RAFT_PORT: String(node.port), RAFT_CLIENT_PORT: String(node.clientPort), RAFT_URL: node.rpc, RAFT_PEERS: nodes.filter(n => n !== node).map(n => n.rpc).join(","), RAFT_DATA_DIR: join(root, node.id) },
      stdio: ["ignore", fd, fd]
    });
    const exited = new Promise(resolve => { child.once("exit", resolve); child.once("error", resolve); });
    children.set(node.id, { child, exited });
  } finally { closeSync(fd); }
}
async function kill(node) {
  if (docker) { compose("kill", "-s", "SIGKILL", node.id); return; }
  const item = children.get(node.id);
  item.child.kill("SIGKILL"); await item.exited; children.delete(node.id);
}
async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    monitorStopped = true;
    agent.destroy();
    if (monitor) await monitor;
    if (docker) compose("down", "--volumes", "--remove-orphans", "--timeout", "3");
    else {
      for (const { child } of children.values()) child.kill("SIGKILL");
      await Promise.all([...children.values()].map(item => item.exited));
      children.clear();
    }
    if (process.env.KEEP_RAFT_ARTIFACTS === "1") console.log(`Artifacts: ${root}`);
    else rmSync(root, { recursive: true, force: true });
  })();
  return cleaning;
}
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  abort = true;
  void cleanup().then(() => process.exit(128 + (signal === "SIGINT" ? 2 : 15)), () => process.exit(1));
});
function record(event) { appendFileSync(join(root, "history.jsonl"), JSON.stringify({ time: Date.now(), ...event }) + "\n"); }
async function write(node, key, value, timeoutMs = 1800) {
  record({ event: "invoke", node: node.id, key, value });
  try {
    const result = await call(node, "/command", { command: { type: "SET", key, value }, timeoutMs });
    assert.equal(result.status, "committed");
    record({ event: "ok", node: node.id, key, index: result.index });
    return result;
  } catch (error) { record({ event: "fail", node: node.id, key, error: error.message }); throw error; }
}
function monitorSafety() {
  const leadersByTerm = new Map();
  const previous = new Map();
  return (async () => {
    while (!monitorStopped) {
      const statuses = await Promise.all(nodes.map(async node => {
        try { return await call(node, "/health", {}, 600); } catch { return null; }
      }));
      for (const status of statuses.filter(Boolean)) {
        const prior = previous.get(status.id);
        if (prior) {
          assert(status.term >= prior.term, `${status.id} term regressed`);
          assert(status.commitIndex >= prior.commitIndex, `${status.id} durable commit index regressed`);
        }
        previous.set(status.id, status);
        if (status.role === "leader") {
          const elected = leadersByTerm.get(status.term);
          assert(!elected || elected === status.id, `leaders ${elected} and ${status.id} in term ${status.term}`);
          if (!elected) record({ event: "leader", node: status.id, term: status.term });
          leadersByTerm.set(status.term, status.id);
        }
      }
      await sleep(50);
    }
  })().catch(error => { monitorError = error; });
}
async function converged(alive) {
  return until(async () => {
    const statuses = await Promise.all(alive.map(node => call(node, "/status")));
    assert.ifError(monitorError);
    const canonical = statuses[0];
    for (const status of statuses) {
      if (status.lastIndex !== status.commitIndex || status.applied !== status.commitIndex) return false;
      if (JSON.stringify(status.entries) !== JSON.stringify(canonical.entries)) return false;
      assert.deepEqual(status.state, canonical.state);
      for (const [key, value] of expected) assert.equal(status.state[key], value, `lost acknowledged write ${key} on ${status.id}`);
      for (const key of Object.keys(status.state)) assert(!key.startsWith("stale_"), `minority committed ${key}`);
    }
    assert.deepEqual(canonical.entries.slice(0, committedPrefix.length), committedPrefix, "committed log prefix was overwritten");
    committedPrefix = canonical.entries;
    return statuses;
  }, "canonical logs/state did not converge", 20000);
}
try {
  for (let i = 1; i <= 3; i++) {
    const port = await freePort(), clientPort = await freePort();
    nodes.push({ id: `node-${i}`, port, clientPort, rpc: docker ? `http://node-${i}:19101` : `http://127.0.0.1:${port}`, client: `http://127.0.0.1:${clientPort}` });
    environment[`RAFT_NODE${i}_PORT`] = String(clientPort);
    mkdirSync(join(root, `node-${i}`));
  }
  console.log(`Starting ${docker ? "Docker" : "native child-process"} Raft cluster`);
  await Promise.all(nodes.map(start));
  monitor = monitorSafety();
  await leader();
  // Select node-1 as the initial leader without changing the randomized election protocol.
  for (let attempt = 0; (await leader()).id !== "node-1"; attempt++) {
    assert(attempt < 12, "could not arrange node-1 initial leadership");
    await Promise.all(nodes.slice(1).map(node => call(node, "/fault", { isolated: true })));
    await sleep(500);
    await Promise.all(nodes.slice(1).map(node => call(node, "/fault", { isolated: false })));
    await sleep(350);
  }
  const initial = nodes[0];
  console.log("Phase A: 1,000 sequential SETs, each followed by a linearizable read");
  let linearLeader = initial;
  for (let i = 0; i < 1000; i++) {
    const key = `key_${i}`, value = `val_${i}`;
    await until(async () => {
      try { await write(linearLeader, key, value); return true; }
      catch { linearLeader = await leader(); return false; }
    }, `linear write ${key}`);
    expected.set(key, value);
    record({ event: "read-invoke", key });
    const read = await until(async () => {
      try { return await call(linearLeader, "/read", { key }); }
      catch { linearLeader = await leader(); return null; }
    }, `linear read ${key}`);
    assert.equal(read.value, value);
    record({ event: "read-ok", key, value: read.value });
  }
  await converged(nodes);
  for (let attempt = 0; (await leader()).id !== initial.id; attempt++) {
    assert(attempt < 20, "could not restore node-1 leadership before partition");
    await Promise.all(nodes.slice(1).map(node => call(node, "/fault", { isolated: true })));
    await sleep(500);
    await Promise.all(nodes.slice(1).map(node => call(node, "/fault", { isolated: false })));
    await sleep(350);
  }
  await converged(nodes);
  const oldTerm = (await call(initial, "/status")).term;
  console.log("Phase B: directed asymmetric cut (majority drops node-1 RPCs); 500 + 500 concurrent writes");
  const majority = nodes.slice(1);
  // Drop only node-1 -> majority. Reverse-direction traffic remains permitted.
  await Promise.all(majority.map(node => call(node, "/fault", { blocked: [initial.id] })));
  const stale = Promise.allSettled(Array.from({ length: 500 }, (_, i) => write(initial, `stale_${i}`, "must_not_commit", 900)));
  const fresh = (async () => {
    const next = await leader(majority);
    assert((await call(next, "/status")).term > oldTerm);
    await Promise.all(Array.from({ length: 500 }, async (_, i) => {
      const key = `majority_${i}`, value = `value_${i}`;
      await until(async () => {
        try { await write(next, key, value); return true; }
        catch { const current = await leader(majority); await write(current, key, value); return true; }
      }, `majority write ${key}`);
      expected.set(key, value);
    }));
    return leader(majority);
  })();
  const [staleResults, elected] = await Promise.all([stale, fresh]);
  assert(staleResults.every(result => result.status === "rejected"), "isolated old leader acknowledged a write");
  for (const node of nodes) {
    const status = await call(node, "/status");
    assert(!Object.keys(status.state).some(key => key.startsWith("stale_")), "minority command reached state machine");
  }
  console.log(`Phase C: heal, immediately SIGKILL ${elected.id}, verify survivor election and canonical replay`);
  await Promise.all(majority.map(node => call(node, "/fault", { blocked: [] })));
  await kill(elected);
  const survivors = nodes.filter(node => node !== elected);
  const survivor = await leader(survivors);
  await write(survivor, "post_crash", "durable"); expected.set("post_crash", "durable");
  await converged(survivors);
  await start(elected);
  await converged(nodes);
  console.log("Phase D: 900ms durable-I/O stall, quorum progress, then full-cluster SIGKILL/restart");
  const active = await leader();
  const laggard = nodes.find(node => node !== active);
  await call(laggard, "/fault", { diskDelayMs: 900 });
  await write(active, "during_fsync_stall", "durable"); expected.set("during_fsync_stall", "durable");
  await converged(nodes);
  const stalledLeader = await leader();
  await call(stalledLeader, "/fault", { diskDelayMs: 900 });
  const available = nodes.filter(node => node !== stalledLeader);
  await until(async () => {
    const current = await leader(available);
    await write(current, "after_leader_stall", "durable");
    return true;
  }, "majority progress during leader fsync stall");
  expected.set("after_leader_stall", "durable");
  await converged(nodes);
  await Promise.all(nodes.map(kill));
  await Promise.all(nodes.map(start));
  const recovered = await leader();
  assert.equal((await call(recovered, "/read", { key: "post_crash" })).value, "durable");
  await converged(nodes);
  assert.ifError(monitorError);
  console.log(`PASS: ${expected.size} acknowledged keys survive partitions, fsync stalls, and SIGKILL; all logs and states agree`);
} catch (error) {
  console.error(error);
  if (docker) { try { console.error(compose("logs", "--no-color", "--tail", "60")); } catch { /* daemon unavailable */ } }
  else for (const node of nodes) { try { console.error(`${node.id}: ${readFileSync(join(root, `${node.id}.out`), "utf8")}`); } catch { /* startup failed */ } }
  process.exitCode = 1;
} finally { await cleanup(); }
