import { RaftNode } from "./node.ts";

const port = Number(process.env.RAFT_PORT ?? 19101);
const node = new RaftNode({
  id: process.env.RAFT_ID ?? "node-1",
  port,
  clientPort: Number(process.env.RAFT_CLIENT_PORT ?? 19201),
  dataDir: process.env.RAFT_DATA_DIR ?? "/var/raft",
  rpcUrl: process.env.RAFT_URL ?? `http://127.0.0.1:${port}`,
  peers: (process.env.RAFT_PEERS ?? "").split(",").filter(Boolean),
  faultInjection: process.env.RAFT_FAULT_INJECTION === "1"
});
let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await node.stop();
}
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
await node.start();
console.log(`${node.id} listening on ${port}`);
