import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, appendFileSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { once } from "node:events";
import { Storage } from "../src/storage.ts";
import { RaftCluster } from "../src/cluster.ts";

async function temporary(work: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(join(tmpdir(), "raft-hardening-"));
  try { await work(dir); } finally { await fs.rm(dir, { recursive: true, force: true }); }
}
async function freePort(): Promise<number> {
  const server = net.createServer(); server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as net.AddressInfo;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

test("WAL replays committed state and term/vote; torn tail is discarded before further appends", async () => {
  await temporary(async dir => {
    let store = new Storage(dir);
    store.saveMeta({ currentTerm: 7, votedFor: "node-2" });
    store.suffix(1, [{ term: 7, command: { type: "SET", key: "durable", value: "yes" } }]);
    store.commit(1); store.close();
    const size = statSync(join(dir, "log.bin")).size;
    const partial = Buffer.alloc(40); partial.writeUInt32BE(200);
    appendFileSync(join(dir, "log.bin"), partial);
    store = new Storage(dir);
    try {
      assert.equal(statSync(join(dir, "log.bin")).size, size);
      assert.deepEqual(store.meta, { currentTerm: 7, votedFor: "node-2" });
      assert.equal(store.commitIndex, 1);
      assert.equal(store.entries[1].command?.value, "yes");
      store.suffix(2, [{ term: 8 }]); store.commit(2);
    } finally { store.close(); }
    store = new Storage(dir);
    try { assert.equal(store.commitIndex, 2); assert.equal(store.entries[2].term, 8); }
    finally { store.close(); }
  });
});

test("conflict repair is append-only and cannot change committed entries", async () => {
  await temporary(async dir => {
    let store = new Storage(dir);
    store.suffix(1, [{ term: 1 }, { term: 2 }, { term: 2 }]); store.commit(1);
    const size = statSync(join(dir, "log.bin")).size;
    assert.throws(() => store.suffix(1, [{ term: 3 }]), /COMMITTED_LOG_OVERWRITE/);
    assert.equal(statSync(join(dir, "log.bin")).size, size);
    store.suffix(2, [{ term: 3 }]);
    assert(statSync(join(dir, "log.bin")).size > size);
    store.close(); store = new Storage(dir);
    try { assert.deepEqual(store.entries.map(entry => entry.term), [0, 1, 3]); assert.equal(store.commitIndex, 1); }
    finally { store.close(); }
  });
});

test("checksum corruption fails closed instead of silently losing durable history", async () => {
  await temporary(async dir => {
    const store = new Storage(dir); store.suffix(1, [{ term: 1 }]); store.commit(1); store.close();
    const bytes = readFileSync(join(dir, "log.bin")); bytes[40] ^= 1;
    writeFileSync(join(dir, "log.bin"), bytes);
    assert.throws(() => new Storage(dir), /CORRUPT_WAL_CHECKSUM/);
  });
});

test("partitioned leader cannot acknowledge writes or reads; speculative suffix heals and DEL survives restart", async () => {
  await temporary(async dir => {
    const nodes = [];
    for (let i = 1; i <= 3; i++) nodes.push({ id: `node-${i}`, port: await freePort(), clientPort: await freePort(), dataDir: join(dir, `node-${i}`) });
    const cluster = new RaftCluster({ nodes });
    try {
      await cluster.start();
      const original = await cluster.waitForLeader();
      await original.executeCommand({ type: "SET", key: "keep", value: "persisted" });
      await original.executeCommand({ type: "SET", key: "remove", value: "temporary" });
      const committed = original.status().commitIndex;
      const oldTerm = original.getCurrentTerm();
      await cluster.isolateNode(original.id);
      const minority = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => original.executeCommand({ type: "SET", key: `stale_${i}`, value: "forbidden" }, 800)));
      assert(minority.every(result => result.status === "rejected"));
      assert.equal(original.status().commitIndex, committed);
      assert(original.status().lastIndex > committed, "minority must have speculative entries to repair");
      await assert.rejects(original.readState("keep"), /NOT_LEADER|QUORUM_UNAVAILABLE|TIMED_OUT/);
      const replacement = await cluster.waitForLeader();
      assert.notEqual(replacement.id, original.id);
      assert(replacement.getCurrentTerm() > oldTerm);
      await replacement.executeCommand({ type: "DEL", key: "remove" });
      await replacement.executeCommand({ type: "SET", key: "canonical", value: "majority" });
      await cluster.reconnectNode(original.id);
      for (const node of cluster.getNodes()) await cluster.waitForSync(node.id, 5000);
      const canonical = replacement.status();
      for (const node of cluster.getNodes()) {
        assert.deepEqual(node.status().state, canonical.state);
        assert.equal(node.status().lastIndex, canonical.lastIndex);
        assert(!Object.keys(node.status().state).some(key => key.startsWith("stale_")));
      }
      await cluster.stop(); await cluster.start();
      const recovered = await cluster.waitForLeader();
      assert.equal(await recovered.readState("keep"), "persisted");
      assert.equal(await recovered.readState("remove"), undefined);
      assert.equal(await recovered.readState("canonical"), "majority");
    } finally { await cluster.stop(); }
  });
});
