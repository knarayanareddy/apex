import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { backup, DatabaseSync } from "node:sqlite";
import type { DurabilityMode, GitObjectFormat, WalIntentRow } from "../types.ts";

export class StateDb {
  readonly db: DatabaseSync;
  readonly dbPath: string;
  readonly durabilityMode: DurabilityMode;

  constructor(dbPath: string, durabilityMode: DurabilityMode = "crash-safe") {
    this.dbPath = dbPath;
    this.durabilityMode = durabilityMode;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(dbPath);
    this._initPragmasAndSchema();
  }

  private _initPragmasAndSchema(): void {
    const syncLevel = this.durabilityMode === "power-loss-safe" ? "FULL" : "NORMAL";
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = ${syncLevel};
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;

      CREATE TABLE IF NOT EXISTS repo_meta (
        repo_root            TEXT PRIMARY KEY,
        git_object_format    TEXT NOT NULL CHECK (git_object_format IN ('sha1','sha256')),
        created_at_ms        INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS wal_intents (
        idempotency_key       TEXT PRIMARY KEY,
        session_id            TEXT NOT NULL,
        leaf_id               TEXT NOT NULL,
        tool_call_id          TEXT NOT NULL,
        parent_tool_call_id   TEXT,
        tool_name             TEXT NOT NULL,
        mutability_class      TEXT NOT NULL CHECK (mutability_class IN ('PURE_READ','LOCAL_REVERSIBLE','OPAQUE_EXTERNAL')),
        target_path           TEXT,
        before_content_sha256 TEXT,
        after_content_sha256  TEXT,
        canonical_args        TEXT NOT NULL,
        status                TEXT NOT NULL CHECK (status IN (
                                'INTENT_LOGGED',
                                'EXECUTING',
                                'EFFECT_COMMITTED_RAW',
                                'EFFECT_COMMITTED',
                                'TRANSCRIPT_APPENDED',
                                'OUTCOME_UNKNOWN',
                                'ABORTED_CLEAN',
                                'RESOLVED_BY_USER'
                              )),
        raw_receipt_json      TEXT,
        result_json           TEXT,
        error_text            TEXT,
        created_at_ms         INTEGER NOT NULL,
        updated_at_ms         INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wal_session_status ON wal_intents(session_id, status);
      CREATE INDEX IF NOT EXISTS idx_wal_parent_call ON wal_intents(session_id, parent_tool_call_id);

      CREATE TABLE IF NOT EXISTS git_checkpoints (
        session_id            TEXT NOT NULL,
        leaf_id               TEXT NOT NULL,
        turn_index            INTEGER NOT NULL,
        git_tree_oid          TEXT NOT NULL,
        file_hashes_json      TEXT NOT NULL,
        entry_states_json     TEXT NOT NULL DEFAULT '{}',
        created_at_ms         INTEGER NOT NULL,
        PRIMARY KEY (session_id, leaf_id)
      );

      CREATE TABLE IF NOT EXISTS rewind_journal (
        tx_id                 TEXT PRIMARY KEY,
        session_id            TEXT NOT NULL,
        from_leaf_id          TEXT NOT NULL,
        to_leaf_id            TEXT NOT NULL,
        source_git_tree_oid   TEXT NOT NULL,
        target_git_tree_oid   TEXT NOT NULL,
        safety_git_ref        TEXT,
        pre_hashes_json       TEXT NOT NULL,
        target_hashes_json    TEXT NOT NULL,
        pre_states_json       TEXT NOT NULL DEFAULT '{}',
        target_states_json    TEXT NOT NULL DEFAULT '{}',
        restore_paths_json    TEXT NOT NULL DEFAULT '[]',
        delete_paths_json     TEXT NOT NULL,
        phase                 TEXT NOT NULL CHECK (phase IN ('PREPARING','APPLYING_DISK','DISK_APPLIED','COMPLETED','CONFLICT_HALTED')),
        conflict_detail_json  TEXT,
        created_at_ms         INTEGER NOT NULL,
        updated_at_ms         INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS rewind_ops (
        tx_id                 TEXT NOT NULL,
        op_seq                INTEGER NOT NULL,
        op_kind               TEXT NOT NULL CHECK (op_kind IN (
                                'UNLINK_FILE',
                                'RMDIR_EMPTY',
                                'ENSURE_DIR',
                                'WRITE_BLOB',
                                'HALT_UNSUPPORTED'
                              )),
        rel_path              TEXT NOT NULL,
        expected_before_json  TEXT NOT NULL,
        expected_after_json   TEXT NOT NULL,
        git_blob_oid          TEXT,
        halt_reason           TEXT,
        status                TEXT NOT NULL CHECK (status IN ('PENDING', 'COMPLETED')),
        completed_at_ms       INTEGER,
        PRIMARY KEY (tx_id, op_seq)
      );
      CREATE INDEX IF NOT EXISTS idx_rewind_ops_tx_status ON rewind_ops(tx_id, status, op_seq);

      CREATE TABLE IF NOT EXISTS session_docs (
        session_id            TEXT NOT NULL,
        doc_key               TEXT NOT NULL,
        rev_seq               INTEGER NOT NULL,
        leaf_id               TEXT NOT NULL,
        content               TEXT NOT NULL,
        content_sha256        TEXT NOT NULL,
        created_at_ms         INTEGER NOT NULL,
        PRIMARY KEY (session_id, doc_key, rev_seq)
      );

      CREATE TABLE IF NOT EXISTS episodes (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id            TEXT NOT NULL,
        repo_root             TEXT NOT NULL,
        summary               TEXT NOT NULL,
        files_touched         TEXT NOT NULL,
        outcome               TEXT NOT NULL,
        created_at_ms         INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS skill_load_audit (
        id                    INTEGER PRIMARY KEY AUTOINCREMENT,
        skill_name            TEXT NOT NULL,
        source_label          TEXT NOT NULL,
        bundle_sha256         TEXT NOT NULL,
        loaded_at_ms          INTEGER NOT NULL
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
        summary,
        files_touched,
        content='episodes',
        content_rowid='id',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER IF NOT EXISTS trg_episodes_ai AFTER INSERT ON episodes BEGIN
        INSERT INTO episodes_fts(rowid, summary, files_touched)
        VALUES (new.id, new.summary, new.files_touched);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_episodes_ad AFTER DELETE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, summary, files_touched)
        VALUES ('delete', old.id, old.summary, old.files_touched);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_episodes_au AFTER UPDATE ON episodes BEGIN
        INSERT INTO episodes_fts(episodes_fts, rowid, summary, files_touched)
        VALUES ('delete', old.id, old.summary, old.files_touched);
        INSERT INTO episodes_fts(rowid, summary, files_touched)
        VALUES (new.id, new.summary, new.files_touched);
      END;
    `);
  }

  detectAndRecordGitObjectFormat(repoRoot: string): GitObjectFormat {
    const out = execFileSync("git", ["rev-parse", "--show-object-format"], {
      cwd: repoRoot,
      encoding: "utf8"
    }).trim();
    const fmt: GitObjectFormat = out === "sha256" ? "sha256" : "sha1";
    this.db
      .prepare(
        `INSERT INTO repo_meta (repo_root, git_object_format, created_at_ms)
         VALUES (?, ?, ?)
         ON CONFLICT(repo_root) DO UPDATE SET git_object_format = excluded.git_object_format`
      )
      .run(repoRoot, fmt, Date.now());
    return fmt;
  }

  insertEpisode(entry: {
    sessionId: string;
    repoRoot: string;
    summary: string;
    filesTouched: string[];
    outcome: string;
  }): number {
    const res = this.db
      .prepare(
        `INSERT INTO episodes (session_id, repo_root, summary, files_touched, outcome, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.sessionId,
        entry.repoRoot,
        entry.summary,
        JSON.stringify(entry.filesTouched),
        entry.outcome,
        Date.now()
      );
    return Number(res.lastInsertRowid);
  }

  updateEpisodeSummary(id: number, nextSummary: string): void {
    this.db.prepare(`UPDATE episodes SET summary = ? WHERE id = ?`).run(nextSummary, id);
  }

  deleteEpisode(id: number): void {
    this.db.prepare(`DELETE FROM episodes WHERE id = ?`).run(id);
  }

  searchEpisodes(query: string, limit = 5): Array<{ id: number; summary: string; files_touched: string }> {
    return this.db
      .prepare(
        `SELECT e.id, e.summary, e.files_touched
         FROM episodes_fts f
         JOIN episodes e ON e.id = f.rowid
         WHERE episodes_fts MATCH ?
         ORDER BY bm25(episodes_fts)
         LIMIT ?`
      )
      .all(query, limit) as Array<{ id: number; summary: string; files_touched: string }>;
  }

  searchEpisodeDetails(query: string, limit = 5): Array<{ id:number; session_id:string; repo_root:string; summary:string; files_touched:string; outcome:string; created_at_ms:number }> {
    const boundedLimit=Math.max(1,Math.min(10,Number.isFinite(limit)?Math.floor(limit):5));
    return this.db.prepare(`SELECT e.id,e.session_id,e.repo_root,e.summary,e.files_touched,e.outcome,e.created_at_ms
      FROM episodes_fts f JOIN episodes e ON e.id=f.rowid WHERE episodes_fts MATCH ?
      ORDER BY bm25(episodes_fts),e.created_at_ms DESC LIMIT ?`).all(query,boundedLimit) as Array<{ id:number; session_id:string; repo_root:string; summary:string; files_touched:string; outcome:string; created_at_ms:number }>;
  }

  recordSkillLoad(entry: { name: string; sourceLabel: string; bundleSha256: string; loadedAtMs?: number }): void {
    if (!/^[a-f0-9]{64}$/.test(entry.bundleSha256)) throw new Error("SKILL_AUDIT_HASH_INVALID");
    this.db.prepare(`INSERT INTO skill_load_audit(skill_name,source_label,bundle_sha256,loaded_at_ms) VALUES(?,?,?,?)`)
      .run(entry.name.slice(0,120), entry.sourceLabel.slice(0,240), entry.bundleSha256, entry.loadedAtMs ?? Date.now());
  }

  verifyFtsIntegrity(): void {
    this.db.exec(`INSERT INTO episodes_fts(episodes_fts) VALUES('integrity-check')`);
  }

  rebuildFts(): void {
    this.db.exec(`INSERT INTO episodes_fts(episodes_fts) VALUES('rebuild')`);
  }

  /**
   * Safe online page-level backup via `node:sqlite` native `backup()` API.
   * Never copies live `-wal`/`-shm` sidecars or replaces live inodes with rename().
   */
  async backupOnlineTo(destFilePath: string): Promise<void> {
    fs.mkdirSync(path.dirname(destFilePath), { recursive: true, mode: 0o700 });
    await backup(this.db, destFilePath);
  }

  getWalRow(idempotencyKey: string): WalIntentRow | undefined {
    return this.db
      .prepare(`SELECT * FROM wal_intents WHERE idempotency_key = ?`)
      .get(idempotencyKey) as WalIntentRow | undefined;
  }

  close(): void {
    this.db.close();
  }
}
