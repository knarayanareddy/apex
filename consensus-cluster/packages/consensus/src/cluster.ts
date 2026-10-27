import { RaftNode, type NodeConfig } from "./node.ts";

export interface ClusterConfig {
  nodes: NodeConfig[];
}

export class RaftCluster {
  private nodes: Map<string, RaftNode> = new Map();

  constructor(config: ClusterConfig) {
    for (const n of config.nodes) {
      this.nodes.set(n.id, new RaftNode({ ...n, peers: n.peers ?? config.nodes.filter(peer => peer.id !== n.id).map(peer => peer.rpcUrl ?? `http://127.0.0.1:${peer.port}`) }));
    }
  }

  async start(): Promise<void> {
    const results = await Promise.allSettled(Array.from(this.nodes.values(), node => node.start()));
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") { await this.stop(); throw failure.reason; }
  }

  async stop(): Promise<void> {
    for (const node of this.nodes.values()) {
      await node.stop();
    }
  }

  getNodes(): RaftNode[] {
    return Array.from(this.nodes.values());
  }

  getNode(id: string): RaftNode | undefined {
    return this.nodes.get(id);
  }

  getLeaders(): RaftNode[] {
    return Array.from(this.nodes.values()).filter(n => n.isCurrentLeader());
  }

  getFollowers(): RaftNode[] {
    return Array.from(this.nodes.values()).filter(n => !n.isCurrentLeader());
  }

  async waitForLeader(timeoutMs = 5000): Promise<RaftNode> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const leaders = this.getLeaders();
      if (leaders.length === 1) {
        return leaders[0];
      }
      await new Promise(r => setTimeout(r, 50));
    }
    throw new Error("Timed out waiting for leader election");
  }

  async isolateNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.setIsolated(true);
    }
  }

  async reconnectNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.setIsolated(false);
    }
  }

  async crashNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node) {
      await node.stop();
    }
  }

  async restartNode(nodeId: string): Promise<void> {
    const node = this.nodes.get(nodeId);
    if (node) {
      await node.start();
    }
  }

  async waitForSync(nodeId: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const leader = this.getLeaders()[0];
      const node = this.nodes.get(nodeId);
      if (leader && node) {
        const canonical = leader.status();
        const replica = node.status();
        if (replica.applied >= canonical.commitIndex && replica.lastIndex === canonical.lastIndex &&
          JSON.stringify(replica.state) === JSON.stringify(canonical.state)) return;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for replica synchronization");
  }
}
