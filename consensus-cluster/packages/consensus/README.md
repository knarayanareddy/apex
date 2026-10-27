# Persistent, fixed-membership Raft

Requires Node >=22.18. Every node owns its HTTP listeners, state machine, metadata,
and journal; all inter-node communication uses HTTP, including the in-process test
adapter (`RaftCluster`). No state or vote is shared between nodes.

## Run

```sh
npm run build
npm test
npm run lint
bash scripts/jepsen-verify.sh             # three independent native Node processes
bash scripts/jepsen-verify.sh --docker    # requires a real Docker daemon + Compose
# Or: RAFT_MODE=docker bash scripts/jepsen-verify.sh

docker compose -f docker-compose.cluster.yml up -d
# Client ports: localhost:19201, :19202, :19203
# Normal deployment cleanup (preserves .raft-data):
docker compose -f docker-compose.cluster.yml down --remove-orphans
```

`build` type-checks the actual consensus sources and tests. Node executes the
TypeScript directly using its built-in type stripping. Compose runs node-1,
node-2, and node-3 on an internal bridge network with separate `/var/raft` mounts.
There is no automatic restart after SIGKILL (the verifier explicitly restarts
nodes). Native mode uses fresh temporary directories and dynamically allocated
loopback ports. Docker verification uses a unique Compose project and temporary
volume directories, not a preexisting deployment.

## Protocol and durability

- Random election deadlines in [150, 300] ms; heartbeats scheduled every 50 ms.
  Terms and votes are persisted before voting or sending election requests.
- RequestVote checks last-log term/index. AppendEntries checks the preceding
  term/index and replaces only a conflicting **uncommitted** suffix. A candidate
  becomes leader only after a strict majority votes for it.
- Leaders track nextIndex/matchIndex independently per peer. Only a majority-
  replicated entry from the current term advances commitIndex; each election
  appends a no-op to establish that rule for inherited entries.
- Commands are applied and acknowledged only after durable quorum replication
  and a local durable commit record. Concurrent proposals are group-committed
  into one WAL record. A leader without recent quorum contact steps down.
- Reads use a newly committed no-op as a quorum barrier. Followers forward reads
  to their known leader; an isolated node cannot serve stale local values through
  the read API. `/status` is diagnostic, **not** a linearizable read API.
- `log.bin` is an append-only framed journal (length, SHA-256 checksum, JSON).
  Logical suffix replacements are additional records, not physical truncation.
  Commit records persist the applied prefix. Every record is fully written and
  fsynced before it becomes visible to the protocol. Recovery rejects checksum
  corruption, discards only an incomplete final frame, and replays committed
  entries. Invalid committed-prefix replacements fail closed.
- `meta.json` is written to a temporary file, fsynced, atomically renamed, and
  followed by directory fsync. An uncertain storage error poisons further writes
  until restart; the process cannot acknowledge an uncertain disk mutation.

This is fixed-membership, crash-fault Raft, not Byzantine consensus. There is no
membership reconfiguration, snapshotting/compaction, RPC authentication/TLS, or
exactly-once client session layer. Logs grow without bound. A client timeout is
an **unknown outcome** in general (a valid quorum might commit after timeout),
not a rollback guarantee. Retry only idempotent commands or supply application-
level deduplication. The verifier retries identical SETs after transient elections;
it does not count timed-out calls as acknowledged operations.

## HTTP API and configuration

`POST /command` with `{"command":{"type":"SET","key":"k","value":"v"}}`
returns `{"status":"committed","index":N}` or HTTP 503 with an error.
`DEL` omits the value. Writes to followers return `NOT_LEADER`; they are not
silently accepted or forwarded. `POST /read` with `{"key":"k"}` returns
`{"value":"v"}` (missing values are omitted). `/health` returns election/log
indices; `/status` additionally exposes the local applied state.

`server.ts` reads `RAFT_ID`, `RAFT_PORT`, `RAFT_CLIENT_PORT`, `RAFT_URL`,
`RAFT_PEERS` (comma-separated RPC URLs), and `RAFT_DATA_DIR`. Defaults are ports
19101/19201 and `/var/raft`. `RAFT_URL` must be reachable by the other nodes.

`RAFT_FAULT_INJECTION=1` additionally enables `/fault` and full diagnostic log
entries. **Never enable it on an untrusted network.** The native verifier and
Docker verifier explicitly enable it; ordinary Compose deployments default it
to off. Faults can isolate a node, drop RPCs from selected sender IDs / peer URLs,
or stall the serialized durable-I/O lane for up to 2 seconds using
`{"diskDelayMs":900}`. The stall leaves the control endpoint responsive while
withholding durable protocol work and acknowledgments. Actual WAL operations
always perform real filesystem fsyncs.

## Chaos verification

The verifier records invocation/completion history, checks leader uniqueness per
observed term and monotonic terms/commit indices, and runs:

1. 1,000 sequential unique SETs, each checked by a fresh linearizable read.
2. A directed **asymmetric** partition: node-2/3 drop node-1's RPCs while reverse
   traffic remains possible. Five hundred concurrent stale-leader writes must
   all fail; 500 majority writes must succeed. No stale key may enter any state
   machine. Reverse traffic may repair node-1 before the explicit heal; this is
   legal. The separate hardening test exercises a fully isolated leader with a
   verified speculative suffix and checks repair after healing.
3. Heal and immediately SIGKILL the majority leader, verify survivor election,
   all acknowledged keys, identical complete logs and state, and the unchanged
   previously committed prefix. Restart the killed node and verify it too.
4. Stall a follower's durable-I/O lane, then a leader's lane, verify majority
   progress, and SIGKILL/restart **all three** processes to verify disk recovery.

Cleanup closes HTTP agents, reaps every native child, removes temporary data,
and tears down the verifier's Docker project/networks/volumes on success,
failure, SIGINT, or SIGTERM. Set `KEEP_RAFT_ARTIFACTS=1` to retain data, process
logs, and `history.jsonl` for debugging; processes/networks are still cleaned up.
This is a targeted fault/invariant checker, not a formal proof or the external
Jepsen framework.
