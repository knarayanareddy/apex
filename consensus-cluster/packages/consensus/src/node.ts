import http, { type Server, type ClientRequest } from "node:http";
import { Storage, type Command, type Entry } from "./storage.ts";
export type { Command } from "./storage.ts";

export interface NodeConfig {
  id: string;
  port: number;
  clientPort: number;
  dataDir: string;
  peers?: string[];
  rpcUrl?: string;
  faultInjection?: boolean;
}
type Role = "follower" | "candidate" | "leader";
interface VoteRequest { term: number; candidateId: string; lastLogIndex: number; lastLogTerm: number }
interface VoteReply { term: number; granted: boolean }
interface AppendRequest {
  term: number; leaderId: string; leaderUrl: string;
  prevLogIndex: number; prevLogTerm: number; entries: Entry[]; leaderCommit: number;
}
interface AppendReply { term: number; success: boolean; match: number; next: number }
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export class RaftNode {
  readonly id: string;
  readonly config: NodeConfig;
  private storage!: Storage;
  private state = new Map<string, string>();
  private applied = 0;
  private role: Role = "follower";
  private term = 0;
  private votedFor: string | null = null;
  private running = false;
  private isolated = false;
  private blocked = new Set<string>();
  private diskStallUntil = 0;
  private leaderUrl: string | null = null;
  private electionDeadline = 0;
  private lastQuorum = 0;
  private timer?: ReturnType<typeof setInterval>;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private servers: Server[] = [];
  private requests = new Set<ClientRequest>();
  private queue: Promise<unknown> = Promise.resolve();
  private nextIndex = new Map<string, number>();
  private matchIndex = new Map<string, number>();
  private acknowledged = new Map<string, number>();
  private inFlight = new Set<string>();
  private pendingProposals: { command?: Command; resolve: (value: { index: number; term: number }) => void; reject: (error: unknown) => void }[] = [];
  private proposalTimer?: ReturnType<typeof setTimeout>;
  private get peers(): string[] { return this.config.peers ?? []; }
  private get quorum(): number { return Math.floor((this.peers.length + 1) / 2) + 1; }
  private get url(): string { return this.config.rpcUrl ?? `http://127.0.0.1:${this.config.port}`; }
  private get lastIndex(): number { return this.storage.entries.length - 1; }

  constructor(config: NodeConfig) { this.id = config.id; this.config = config; }

  /** All protocol transitions and durable writes run in this single ordered lane. */
  private serial<T>(work: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (!this.running) throw new Error("NODE_CRASHED");
      if (this.diskStallUntil > Date.now()) await sleep(this.diskStallUntil - Date.now());
      if (!this.running) throw new Error("NODE_CRASHED");
      return work();
    });
    this.queue = result.catch(() => {});
    return result;
  }
  private trace(event: string): void {
    if (process.env.RAFT_TRACE === "1") console.log(JSON.stringify({ time: Date.now(), id: this.id, event, term: this.term, role: this.role }));
  }
  private resetElection(): void { this.electionDeadline = Date.now() + 150 + Math.floor(Math.random() * 151); }
  private persistTerm(): void { this.storage.saveMeta({ currentTerm: this.term, votedFor: this.votedFor }); }
  private follow(term: number): void {
    this.trace(`follow ${term}`);
    if (term > this.term) {
      this.term = term;
      this.votedFor = null;
      this.persistTerm();
    }
    this.role = "follower";
    this.leaderUrl = null;
    this.resetElection();
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.storage = new Storage(this.config.dataDir);
    this.term = this.storage.meta.currentTerm;
    this.votedFor = this.storage.meta.votedFor;
    this.state.clear(); this.applied = 0; this.applyCommitted();
    this.role = "follower"; this.leaderUrl = null; this.inFlight.clear();
    this.running = true; this.resetElection();
    try {
      for (const port of new Set([this.config.port, this.config.clientPort])) {
        const server = http.createServer((req, res) => {
          void (async () => {
            let body = "";
            for await (const chunk of req) {
              body += chunk;
              if (body.length > 16 * 1024 * 1024) throw new Error("REQUEST_TOO_LARGE");
            }
            const data = body ? JSON.parse(body) : {};
            let result: unknown;
            if (req.url === "/status") result = this.status();
            else if (req.url === "/health") result = this.status(false);
            else if (req.url === "/fault" && this.config.faultInjection) {
              if (typeof data.isolated === "boolean") this.isolated = data.isolated;
              if (Array.isArray(data.blocked)) this.blocked = new Set(data.blocked);
              if (typeof data.diskDelayMs === "number") this.diskStallUntil = Date.now() + Math.max(0, Math.min(2000, data.diskDelayMs));
              result = { ok: true };
            } else if (req.url === "/command") result = await this.executeCommand(data.command, data.timeoutMs);
            else if (req.url === "/read") result = { value: await this.readState(data.key) };
            else if (req.url === "/rpc/vote" || req.url === "/rpc/append") {
              if (this.isolated || this.blocked.has(data.sender) || this.blocked.has(data.senderUrl)) {
                // Silent TCP blackhole (-j DROP simulation): hold socket open, send zero response bytes/FIN/RST
                req.socket.pause();
                return;
              }
              result = await this.serial(() => req.url === "/rpc/vote" ? this.vote(data) : this.append(data));
            } else throw new Error("NOT_FOUND");
            res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(result));
          })().catch((error: Error) => {
            if (!res.destroyed) { res.writeHead(503, { "content-type": "application/json" }); res.end(JSON.stringify({ error: error.message })); }
          });
        });
        this.servers.push(server);
        await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "0.0.0.0", resolve); });
      }
      this.timer = setInterval(() => {
        void this.serial(() => this.tick()).catch(() => {});
      }, 10);
      this.heartbeatTimer = setInterval(() => {
        void this.serial(() => { if (this.role === "leader") this.replicate(); }).catch(() => {});
      }, 50);
    } catch (error) { await this.stop(); throw error; }
  }
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false; this.role = "follower";
    if (this.timer) clearInterval(this.timer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    if (this.proposalTimer) clearTimeout(this.proposalTimer);
    this.proposalTimer = undefined;
    for (const proposal of this.pendingProposals.splice(0)) proposal.reject(new Error("NODE_CRASHED"));
    for (const request of this.requests) request.destroy(new Error("NODE_CRASHED"));
    await Promise.all(this.servers.map(server => new Promise<void>(resolve => {
      server.close(() => resolve()); server.closeAllConnections();
    })));
    this.servers = [];
    await this.queue;
    this.storage.close();
  }
  getId(): string { return this.id; }
  getCurrentTerm(): number { return this.term; }
  isCurrentLeader(): boolean { return this.running && !this.isolated && this.role === "leader"; }
  setIsolated(isolated: boolean): void { this.isolated = isolated; }
  async setCrashed(crashed: boolean): Promise<void> { if (crashed) await this.stop(); else await this.start(); }
  status(includeData = true) {
    return {
      id: this.id, term: this.term, role: this.role, running: this.running, leaderUrl: this.leaderUrl,
      commitIndex: this.storage.commitIndex, lastIndex: this.lastIndex, applied: this.applied,
      state: includeData ? Object.fromEntries(this.state) : {},
      entries: includeData && this.config.faultInjection ? this.storage.entries : undefined
    };
  }
  private async rpc<T>(url: string, route: string, data: unknown, timeout = 450): Promise<T> {
    if (!this.running || this.isolated || this.blocked.has(url)) throw new Error("PARTITIONED");
    const payload = JSON.stringify({ ...data as object, sender: this.id, senderUrl: this.url });
    return new Promise<T>((resolve, reject) => {
      const req = http.request(new URL(route, url), {
        method: "POST", agent: false, headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload) }
      }, res => {
        let body = "";
        res.on("data", chunk => { body += chunk; });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const reply = JSON.parse(body);
            if (res.statusCode !== 200) reject(new Error(reply.error ?? "RPC_FAILED"));
            else resolve(reply);
          } catch (error) { reject(error); }
        });
      });
      this.requests.add(req);
      const deadline = setTimeout(() => req.destroy(new Error("TIMED_OUT")), timeout);
      req.on("close", () => { clearTimeout(deadline); this.requests.delete(req); });
      req.on("error", reject);
      req.end(payload);
    });
  }
  private tick(): void {
    const now = Date.now();
    if (this.role !== "leader") {
      if (now >= this.electionDeadline) this.elect();
    } else {
      if (now - this.lastQuorum > 350) { this.follow(this.term); return; }
    }
  }
  private elect(): void {
    this.trace(`election overdue ${Date.now() - this.electionDeadline}ms`);
    this.role = "candidate"; this.term++; this.votedFor = this.id; this.leaderUrl = null;
    this.persistTerm(); this.resetElection();
    const term = this.term;
    const votes = new Set([this.id]);
    const request: VoteRequest = { term, candidateId: this.id, lastLogIndex: this.lastIndex, lastLogTerm: this.storage.entries[this.lastIndex].term };
    if (votes.size >= this.quorum) this.becomeLeader();
    for (const peer of this.peers) {
      void this.rpc<VoteReply>(peer, "/rpc/vote", request, 120).then(reply => this.serial(() => {
        if (reply.term > this.term) { this.follow(reply.term); return; }
        if (this.term !== term || this.role !== "candidate") return;
        if (reply.granted) votes.add(peer);
        if (votes.size >= this.quorum) this.becomeLeader();
      })).catch(() => {});
    }
  }
  private vote(request: VoteRequest): VoteReply {
    if (request.term > this.term) this.follow(request.term);
    let granted = false;
    if (request.term === this.term) {
      const lastTerm = this.storage.entries[this.lastIndex].term;
      const upToDate = request.lastLogTerm > lastTerm || (request.lastLogTerm === lastTerm && request.lastLogIndex >= this.lastIndex);
      if (upToDate && (this.votedFor === null || this.votedFor === request.candidateId)) {
        this.votedFor = request.candidateId; this.persistTerm(); this.resetElection(); granted = true;
      }
    }
    return { term: this.term, granted };
  }
  private becomeLeader(): void {
    this.trace("elected");
    this.role = "leader"; this.leaderUrl = this.url; this.lastQuorum = Date.now();
    this.nextIndex.clear(); this.matchIndex.clear(); this.acknowledged.clear();
    for (const peer of this.peers) { this.nextIndex.set(peer, this.lastIndex + 1); this.matchIndex.set(peer, 0); }
    // A current-term entry is mandatory before serving reads or committing inherited entries.
    this.storage.suffix(this.lastIndex + 1, [{ term: this.term }]);
    this.advanceCommit(); this.replicate();
  }
  private append(request: AppendRequest): AppendReply {
    const fail = (next: number): AppendReply => ({ term: this.term, success: false, match: 0, next });
    if (request.term < this.term) return fail(this.lastIndex + 1);
    if (request.term > this.term || this.role !== "follower") this.follow(request.term);
    this.leaderUrl = request.leaderUrl; this.resetElection();
    if (request.prevLogIndex > this.lastIndex) return fail(this.lastIndex + 1);
    if (this.storage.entries[request.prevLogIndex].term !== request.prevLogTerm) {
      let next = request.prevLogIndex;
      const conflictTerm = this.storage.entries[next].term;
      while (next > 1 && this.storage.entries[next - 1].term === conflictTerm) next--;
      return fail(next);
    }
    for (let i = 0; i < request.entries.length; i++) {
      const index = request.prevLogIndex + 1 + i;
      if (this.storage.entries[index]?.term !== request.entries[i].term) {
        // This guard also rejects an invalid leader rather than corrupting a committed prefix.
        if (index <= this.storage.commitIndex) throw new Error("COMMITTED_LOG_OVERWRITE");
        this.storage.suffix(index, request.entries.slice(i)); break;
      }
    }
    const match = request.prevLogIndex + request.entries.length;
    this.storage.commit(Math.min(request.leaderCommit, match)); this.applyCommitted();
    return { term: this.term, success: true, match, next: match + 1 };
  }
  private replicate(): void {
    if (this.role !== "leader") return;
    for (const peer of this.peers) {
      if (this.inFlight.has(peer)) continue;
      const term = this.term;
      const next = this.nextIndex.get(peer) ?? this.lastIndex + 1;
      const request: AppendRequest = {
        term, leaderId: this.id, leaderUrl: this.url, prevLogIndex: next - 1,
        prevLogTerm: this.storage.entries[next - 1].term,
        entries: this.storage.entries.slice(next, next + 128), leaderCommit: this.storage.commitIndex
      };
      const sentAt = Date.now();
      this.inFlight.add(peer);
      void this.rpc<AppendReply>(peer, "/rpc/append", request, 100).then(reply => this.serial(() => {
        if (reply.term > this.term) { this.follow(reply.term); return; }
        if (term !== this.term || this.role !== "leader") return;
        if (reply.success) {
          this.matchIndex.set(peer, reply.match); this.nextIndex.set(peer, reply.match + 1);
          this.acknowledged.set(peer, sentAt);
          const recent = [Date.now(), ...this.acknowledged.values()].sort((a, b) => b - a);
          if (recent.length >= this.quorum) this.lastQuorum = recent[this.quorum - 1];
          this.advanceCommit();
        } else this.nextIndex.set(peer, Math.max(1, Math.min(next - 1, reply.next)));
      })).catch(() => {}).finally(() => { this.inFlight.delete(peer); });
    }
  }
  private advanceCommit(): void {
    const replicated = [this.lastIndex, ...this.peers.map(peer => this.matchIndex.get(peer) ?? 0)].sort((a, b) => b - a);
    const index = replicated[this.quorum - 1];
    if (index > this.storage.commitIndex && this.storage.entries[index].term === this.term) {
      this.storage.commit(index); this.applyCommitted();
    }
  }
  private applyCommitted(): void {
    while (this.applied < this.storage.commitIndex) {
      const command = this.storage.entries[++this.applied].command;
      if (command?.type === "SET") this.state.set(command.key, command.value!);
      if (command?.type === "DEL") this.state.delete(command.key);
    }
  }
  private async propose(command: Command | undefined, timeoutMs: number): Promise<number> {
    const { index, term } = await new Promise<{ index: number; term: number }>((resolve, reject) => {
      if (!this.running) { reject(new Error("NODE_CRASHED")); return; }
      this.pendingProposals.push({ command, resolve, reject });
      if (this.proposalTimer) return;
      this.proposalTimer = setTimeout(() => {
        this.proposalTimer = undefined;
        const batch = this.pendingProposals.splice(0);
        void this.serial(() => {
          if (this.role !== "leader") throw new Error("NOT_LEADER");
          const first = this.lastIndex + 1;
          this.storage.suffix(first, batch.map(item => ({ term: this.term, command: item.command })));
          this.advanceCommit(); this.replicate();
          batch.forEach((item, offset) => item.resolve({ index: first + offset, term: this.term }));
        }).catch(error => { for (const item of batch) item.reject(error); });
      }, 0);
    });
    const deadline = Date.now() + timeoutMs;
    while (this.running && Date.now() < deadline) {
      // The term check prevents a replaced proposal from being acknowledged by index alone.
      if (this.term !== term || this.role !== "leader") throw new Error("QUORUM_UNAVAILABLE");
      if (this.storage.commitIndex >= index) return index;
      await sleep(5);
    }
    throw new Error("TIMED_OUT");
  }
  async executeCommand(command: Command, timeoutMs = 2000): Promise<{ status: "committed"; index: number }> {
    if (!command || !["SET", "DEL"].includes(command.type) || typeof command.key !== "string" || (command.type === "SET" && typeof command.value !== "string")) throw new Error("INVALID_COMMAND");
    return { status: "committed", index: await this.propose(command, timeoutMs) };
  }
  async readState(key: string): Promise<string | undefined> {
    if (!this.running) throw new Error("NODE_CRASHED");
    if (this.role !== "leader") {
      if (!this.leaderUrl || this.isolated) throw new Error("NOT_LEADER");
      const result = await this.rpc<{ value?: string }>(this.leaderUrl, "/read", { key }, 2500);
      return result.value;
    }
    // A committed no-op is a fresh quorum barrier, not a clock/lease-based stale read.
    await this.propose(undefined, 2000);
    return this.state.get(key);
  }
}
