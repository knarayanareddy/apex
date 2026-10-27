import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync, writeSync, fsyncSync, renameSync, ftruncateSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface Command { type: "SET" | "DEL"; key: string; value?: string }
export interface Entry { term: number; command?: Command }
export interface Metadata { currentTerm: number; votedFor: string | null }
type Record = { kind: "suffix"; from: number; entries: Entry[] } | { kind: "commit"; index: number };

/** Append-only, checksummed journal. Suffix replacement is itself a durable record;
 * committed entries are never truncated. A torn final frame is discarded on recovery. */
export class Storage {
  entries: Entry[] = [{ term: 0 }];
  commitIndex = 0;
  meta: Metadata = { currentTerm: 0, votedFor: null };
  private fd: number;
  private dir: string;
  private failed = false;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
    const metaPath = join(dir, "meta.json");
    if (existsSync(metaPath)) this.meta = JSON.parse(readFileSync(metaPath, "utf8"));
    this.fd = openSync(join(dir, "log.bin"), "a+");
    try {
      const bytes = readFileSync(join(dir, "log.bin"));
      let offset = 0;
      while (offset + 36 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        if (length > 16 * 1024 * 1024) throw new Error("CORRUPT_WAL_LENGTH");
        if (offset + 36 + length > bytes.length) break;
        const payload = bytes.subarray(offset + 36, offset + 36 + length);
        if (!createHash("sha256").update(payload).digest().equals(bytes.subarray(offset + 4, offset + 36))) {
          throw new Error("CORRUPT_WAL_CHECKSUM");
        }
        this.apply(JSON.parse(payload.toString()));
        offset += 36 + length;
      }
      if (offset !== bytes.length) { ftruncateSync(this.fd, offset); fsyncSync(this.fd); }
      this.saveMeta(this.meta);
      this.syncDirectory();
    } catch (error) { closeSync(this.fd); throw error; }
  }
  private syncDirectory(): void {
    const fd = openSync(this.dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
  saveMeta(meta: Metadata): void {
    if (this.failed) throw new Error("STORAGE_FAILED");
    try {
      const tmp = join(this.dir, "meta.json.tmp");
      const fd = openSync(tmp, "w");
      try { writeFileSync(fd, JSON.stringify(meta)); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(tmp, join(this.dir, "meta.json"));
      this.syncDirectory();
      this.meta = { ...meta };
    } catch (error) { this.failed = true; throw error; }
  }
  private validate(record: Record): void {
    if (record.kind === "suffix") {
      if (record.from <= this.commitIndex || record.from > this.entries.length) throw new Error("COMMITTED_LOG_OVERWRITE");
    } else if (record.index < this.commitIndex || record.index >= this.entries.length) throw new Error("INVALID_COMMIT");
  }
  private apply(record: Record): void {
    this.validate(record);
    if (record.kind === "suffix") this.entries.splice(record.from, this.entries.length - record.from, ...record.entries);
    else this.commitIndex = record.index;
  }
  private append(record: Record): void {
    if (this.failed) throw new Error("STORAGE_FAILED");
    this.validate(record);
    const payload = Buffer.from(JSON.stringify(record));
    if (payload.length > 16 * 1024 * 1024) throw new Error("WAL_RECORD_TOO_LARGE");
    const header = Buffer.alloc(36);
    header.writeUInt32BE(payload.length);
    createHash("sha256").update(payload).digest().copy(header, 4);
    const frame = Buffer.concat([header, payload]);
    try {
      let offset = 0;
      while (offset < frame.length) offset += writeSync(this.fd, frame, offset, frame.length - offset);
      fsyncSync(this.fd);
      this.apply(record);
    } catch (error) {
      // An uncertain write must never be followed by further writes in this process.
      this.failed = true; throw error;
    }
  }
  suffix(from: number, entries: Entry[]): void { this.append({ kind: "suffix", from, entries }); }
  commit(index: number): void { if (index > this.commitIndex) this.append({ kind: "commit", index }); }
  close(): void { closeSync(this.fd); }
}
