import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { RaftCluster } from "../src/cluster.ts";

describe("Distributed Raft Consensus & Linearizability Suite", () => {
  let cluster: RaftCluster;
  let testDataDir: string;

  before(async () => {
    testDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "raft-cluster-test-"));
    cluster = new RaftCluster({
      nodes: [
        { id: "node-1", port: 19101, clientPort: 19201, dataDir: path.join(testDataDir, "node-1") },
        { id: "node-2", port: 19102, clientPort: 19202, dataDir: path.join(testDataDir, "node-2") },
        { id: "node-3", port: 19103, clientPort: 19203, dataDir: path.join(testDataDir, "node-3") }
      ]
    });
    await cluster.start();
  });

  after(async () => {
    if (cluster) {
      await cluster.stop();
    }
    if (testDataDir) {
      await fs.rm(testDataDir, { recursive: true, force: true });
    }
  });

  test("1. Leader election elects exactly one leader with monotonic term advancement", async () => {
    // Wait for initial election
    const leader = await cluster.waitForLeader(5000);
    assert.ok(leader, "Cluster must elect an initial leader");
    
    const term = leader.getCurrentTerm();
    assert.ok(term >= 1, "Leader term must be monotonically positive");

    // Assert only one leader exists in the cluster
    const leaders = cluster.getLeaders();
    assert.equal(leaders.length, 1, "There must be exactly one active leader in term " + term);
  });

  test("2. Replicates log to strict majority before committing client command", async () => {
    const leader = await cluster.waitForLeader(2000);
    assert.ok(leader, "Must have an active leader");

    // Execute write through leader client API
    const writeResult = await leader.executeCommand({ type: "SET", key: "cluster_health", value: "optimal" });
    assert.equal(writeResult.status, "committed", "Write must be committed by quorum");
    assert.ok(writeResult.index >= 1, "Committed log index must be >= 1");

    // Verify linearizable read on all quorum nodes
    const aliveNodes = cluster.getNodes();
    let replicatedCount = 0;
    for (const node of aliveNodes) {
      const val = await node.readState("cluster_health");
      if (val === "optimal") replicatedCount++;
    }
    assert.ok(replicatedCount >= 2, "State machine update must be committed to strict majority (>= 2 nodes)");
  });

  test("3. Partitions minority node: minority rejects writes, majority continues committing", async () => {
    const leader = await cluster.waitForLeader(2000);
    assert.ok(leader, "Leader must be active before partition");

    const follower = cluster.getFollowers()[0];
    assert.ok(follower, "Must identify a follower to isolate");

    // Isolate follower
    await cluster.isolateNode(follower.getId());

    // Majority (2 nodes) must still accept writes
    const majorityWrite = await leader.executeCommand({ type: "SET", key: "majority_key", value: "active" });
    assert.equal(majorityWrite.status, "committed", "Majority partition must continue committing writes");

    // Isolated node must fail write
    await assert.rejects(
      follower.executeCommand({ type: "SET", key: "minority_key", value: "stale" }, 800),
      /NOT_LEADER|QUORUM_UNAVAILABLE|TIMED_OUT/,
      "Isolated follower must not commit writes without quorum"
    );

    // Reconnect follower
    await cluster.reconnectNode(follower.getId());
    await cluster.waitForSync(follower.getId(), 3000);

    // Assert reconnected follower catches up to canonical state
    const syncedVal = await follower.readState("majority_key");
    assert.equal(syncedVal, "active", "Healed follower must sync canonical state machine values");
  });

  test("4. Recovers canonical state from persistent disk logs across ungraceful node crash", async () => {
    const leader = await cluster.waitForLeader(2000);
    assert.ok(leader, "Active leader required");

    // Commit a durable key
    await leader.executeCommand({ type: "SET", key: "durable_marker", value: "persisted_value" });

    // Crash the leader ungracefully (kill)
    const crashedId = leader.getId();
    await cluster.crashNode(crashedId);

    // Remaining 2 nodes must elect a new leader and continue
    const newLeader = await cluster.waitForLeader(5000);
    assert.ok(newLeader, "Cluster must elect a new leader following crash");
    assert.notEqual(newLeader.getId(), crashedId, "New leader cannot be the crashed node");

    // Revive the crashed node
    await cluster.restartNode(crashedId);
    await cluster.waitForSync(crashedId, 4000);

    const revived = cluster.getNode(crashedId);
    assert.ok(revived, "Revived node must exist in cluster");
    const recoveredVal = await revived.readState("durable_marker");
    assert.equal(recoveredVal, "persisted_value", "Node restarted from disk must recover committed state");
  });
});
