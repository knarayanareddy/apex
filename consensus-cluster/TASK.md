# MISSION BRIEF: Distributed Consensus Engine Hardening & Jepsen Chaos Validation

Target: packages/consensus (Node.js/TypeScript), docker-compose.cluster.yml, and scripts/jepsen-verify.sh.

You are tasked with replacing a buggy, mock multi-master consensus engine with a fully conforming, 3-node Raft consensus cluster backed by persistent on-disk state. You must achieve zero-loss state replication across simulated asymmetric network partitions, disk fsync stalls, and ungraceful SIGKILL failovers.

### Invariants & Non-Negotiable Requirements:

1. Cluster Orchestration & Process Topology:
   - Configure `docker-compose.cluster.yml` to run a 3-node cluster (`node-1`, `node-2`, `node-3`) communicating over TCP/HTTP RPC on internal subnets with no shared memory.
   - Nodes must maintain an append-only write-ahead log under `/var/raft/log.bin` (or configurable dataDir path) and persistent metadata (`currentTerm`, `votedFor`) in `/var/raft/meta.json` (or `${dataDir}/meta.json`).

2. Raft Protocol Conformance:
   - Leader Election: Randomized election timeouts (150ms–300ms) with monotonic term advancement.
   - Log Replication: Heartbeats every 50ms. Strict majority quorum (2 of 3 nodes) required before committing any client command.
   - Safety Invariant: At most one leader per term. A leader must NEVER overwrite or truncate its own committed log entries.

3. Jepsen-Style Chaos Validation (`scripts/jepsen-verify.sh`):
   Your automated validation script must orchestrate the cluster and survive the following sequence:
   - Phase A (Linear Traffic): Ingest 1,000 sequential `SET key_{i} val_{i}` operations against the active leader with linearizable reads.
   - Phase B (Asymmetric Partition / Split-Brain Test):
     * Cut network connectivity between `node-1` (current leader) and the rest of the cluster using `iptables` or Docker network disconnect.
     * Continuously pipe 500 concurrent writes to `node-1` (stale leader) and 500 concurrent writes to `node-2`/`node-3` (majority partition).
     * Invariant: Writes to `node-1` must fail/timeout and NEVER reach state machine commit; `node-2`/`node-3` must elect a new leader and successfully commit writes.
   - Phase C (Heal & Re-convergence):
     * Reconnect `node-1`.
     * Inject an ungraceful crash (`kill -9`) into the newly elected leader.
     * Invariant: The cluster must elect a survivor, truncate uncommitted speculative entries from `node-1`, replay the canonical history, and achieve 100% data consistency across all alive nodes.

4. Deliverables & Strict Constraints:
   - Do NOT edit or weaken any test assertions in `packages/consensus/test/linearizability.spec.ts`.
   - The verify script must run end-to-end: `npm run build && bash scripts/jepsen-verify.sh`.
   - Zero orphaned child processes, zero lingering Docker networks, and zero leaked file descriptors upon test exit.
