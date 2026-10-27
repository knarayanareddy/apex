# Pi-Apex Master Engineering Specification & Build Bible (`v4.0` — Complete `Ring 0`–`Ring 10` Warm Editorial Studio & 1-Click Onboarding Specification)

> **Scope & Claim Discipline:** This document includes historical Ring 0–10 design and verification claims plus later ring sections. It is not a blanket assertion that every described behavior is current, production-live, automatically invoked, or exercised against a real provider/network; confirm each claim against current source and its named test before relying on it. Automated tests include deterministic fixtures, faux providers, local services, and mocks.  
> **Current verified limitations (2026-10-27):** Browser automation is available as a deferred/on-demand tool, not forced for every research task. The Skills Library discovers/displays skills; the agent can explicitly list and load a clean active canonical workspace skill via deferred `skill_access`, but task matching is model-directed, not guaranteed. FTS5 episode storage and `/dream` consolidation exist; the deferred `memory_recall` tool provides explicit bounded keyword recall, not automatic injection on each prompt. Consolidated `MEMORY.md` applies on a later boot. Optional Obsidian access is read-only and requires an explicit vault path. Prefix immutability and cache-use telemetry do not mean Pi-Apex owns a durable prompt-content cache.  
> **Target Platform:** Personal Single-Operator Linux `x86_64`/`arm64` (`Linux >= 5.6` for `openat2(2)`, `Node.js >= 22.19.0`, `git >= 2.38`, `bubblewrap >= 0.8`, `gcc` + `node_api.h` for `linux_fs_bridge.node`, plus `chromium` + `xvfb` for live CDP browser/CUA mode).

---

## Changelog (`Ring 0` Contract & Implementation Fixes)

1. **Descriptor-Relative Filesystem Broker + `O_CLOEXEC` Enforcement (`§3.1`, `§3.2`, `§3.3`, `src/native/linux_fs_bridge.c`):**
   - N-API Linux syscall broker (`linux_fs_bridge.node`) binds **`openRootDir` (`O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`)**, **`openat2(2)` (`O_CLOEXEC` + `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`)**, **`mkdirat(2)`**, **`renameat(2)`**, **`unlinkat(2)` (both file `0` and `AT_REMOVEDIR`)**, **`fstatat(2)` (`AT_SYMLINK_NOFOLLOW`)**, **`flock(2)` (with `FD_CLOEXEC` verified via `fcntl(F_GETFD)`)**, and **`hasCloexec(fd)`**. Swapping an ancestor directory into a symlink before `renameat`/`unlinkat` cannot escape `<workspaceRoot>`, and child processes spawned across `fork`/`exec` never inherit `wsFd` or `lockFd`.

2. **Unconditional Default Git Object/Reflog Isolation Across Standard Repos & Linked Worktrees (`§3.1`, `src/core/bwrap-sandbox.ts`):**
   - `ReadOperations`/`WriteOperations` block direct `.git` / `.git/**` access completely, and `snapshotWorkingTreeToGit()` excludes all secret basenames, hardlink aliases, symlinks, and submodules.
   - `resolveGitRepositoryLayout()` resolves both `gitDir` and `commonDir` (following linked `git worktree` `.git` pointer files and `commondir`, plus `objects/info/alternates` and `logs`).
   - **`isolateGitObjectsMode` defaults to `"always"`**: `bwrap` mounts **`--tmpfs`** over all resolved `objects` and `logs` directories (`commonDir/objects`, `alternates`, `commonDir/logs`, `gitDir/logs`) while keeping `hooks` and `config` read-only (`--ro-bind`), blocking reachable, reflog-only, **and** unreachable/dangling secret blobs prior to `git gc --prune=now` in both standard repositories and linked worktrees. Opt-in `"on-historical-secret"` is explicitly documented as a weaker heuristic covering only reachable `git ls-files` / `git log --all` history.

3. **Per-Operation Crash-Idempotent Rewind Journal (`rewind_ops`) + Exact `0o000`–`0o777` Mode Preservation (`§2`, `§3.2`, `§3.3`, `src/core/git-rewind.ts`, `src/core/wal-recovery.ts`):**
   - Removed falsy `|| 0o644` mode fallbacks in `writeFileDurable()` and `git-rewind.ts`: defaults apply strictly when `options?.mode === undefined` and `existingMode === null`, preserving valid `0o000` (`0000`) permissions on both new creation and overwrite while masking off `setuid`/`setgid`/`sticky` (`rawMode & 0o777`).
   - Replaced coarse path-list rewind recovery with persisted per-operation rows in **`rewind_ops`** (`UNLINK_FILE` $\to$ `RMDIR_EMPTY` $\to$ `ENSURE_DIR` $\to$ `WRITE_BLOB` / `HALT_UNSUPPORTED`), each storing step-specific `expected_before_json`, `expected_after_json`, and `status ∈ {'PENDING', 'COMPLETED'}`. Recovery skips `COMPLETED` ops, idempotently promotes `PENDING` ops whose `expected_after` already matches live disk state (crash between syscall and SQLite commit), uses distinct `mkdirat` (`ENSURE_DIR`) and `unlinkat(AT_REMOVEDIR)` (`RMDIR_EMPTY`) syscalls, and recovers cleanly from crashes at every intermediate step of `file ↔ directory` transitions without false conflicts or unlinking restored directories.

4. **Single-Owner `O_CLOEXEC` Kernel `flock(2)` Workspace Lock (`§3.3`, `src/core/workspace-lock.ts`):**
   - Acquires `flock(lockFd, LOCK_EX | LOCK_NB)` on a permanent, never-unlinked `.harness/workspace.lock` inode opened with `O_CLOEXEC` (`hasCloexec(lockFd) === true`), never duplicating or passing `lockFd` to child `stdio`, so `SIGKILL` (`kill -9`) closes the sole open file description and releases the kernel lock immediately even when child processes spawned under the lock remain alive.

5. **Full `power-loss-safe` Root Tool-Result JSONL `fsync` (`§3.0`, `§3.2`, `src/core/wal-recovery.ts`, `src/core/ring0-session.ts`):**
   - `syncSessionTranscriptDurable()` explicitly `fsync`s both the session `.jsonl` file and its parent directory in `power-loss-safe` mode **before** `markWalCallTreeTranscriptAppended()` transitions normal root + nested QuickJS WAL rows to `TRANSCRIPT_APPENDED` (enforced via `TranscriptNotSyncedError`), not only rewind anchors.

---

## 0. Scoped `Ring 0` Invariants (`I-01` – `I-12`)

| ID | Invariant | Verifiable Enforcement |
|---|---|---|
| **I-01** | **Pinned `2,100`-Token Prefix (`o200k_base`)** | Measured via `js-tiktoken` on `@earendil-works/pi-coding-agent@1.4.0`: `[read, bash, edit, write, codemode]` = **`1,073` tokens** (`<= 1,240` direct schema ceiling) + pinned text surfaces (`<= 860` tokens) = **`<= 2,100` `o200k_base` tokens max**. Snapshot-pinned at `session_start`; SHA-256 verified every turn. |
| **I-02** | **Append-Only Dynamic Context** | Subdirectory `AGENTS.md`, `.mdc` path globs, LSP diagnostics, skills, and inline comments inject strictly at message/tool-result tails (`Rings 1–2`). |
| **I-03** | **Zero-Schema-Bloat Secondary Tools (`exposure: "deferred"`)** | `exposure: "deferred"` adds **`0` schema tokens** across 50+ secondary tools while remaining callable via `await tools.<name>(args)` inside QuickJS `codemode`. |
| **I-04** | **Universal Guard & WAL Crossing** | Nested `Codemode` scripts invoke `ctx.executeTool()` (`<parentId>/<n>`), crossing `pi.on("tool_call")` and our confined `Operations` seams. |
| **I-05** | **Minimal-Rootfs + Secret/Hardlink + Default `.git` Object/Reflog Isolation** | Minimal OS allowlist rootfs + `--tmpfs /home` + `--clearenv` + `--unshare-net` + recursive secret & `(dev, ino)` hardlink `/dev/null` masks + default `isolateGitObjectsMode: "always"` (`--tmpfs` over resolved `commonDir/objects`, `alternates`, and `logs` across standard repos & linked `git worktree`s). |
| **I-06** | **Descriptor-Bound `O_CLOEXEC` No-Symlink Mutations** | All host-side file reads, temp writes, renames, mkdirs, and deletions execute via `linux_fs_bridge.node` (`openRootDir` + `openat2(O_CLOEXEC \| RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS)` + `renameat` + `unlinkat` + `mkdirat`), preserving exact `0o000`–`0o777` modes (`rawMode & 0o777`). |
| **I-07** | **Honest WAL + Post-Effect Receipt + Synced Transcript Durability** | `EFFECT_COMMITTED_RAW` precedes spill; `reconcileWalOnStartup` promotes `EFFECT_COMMITTED_RAW -> EFFECT_COMMITTED`; nested QuickJS calls remain `EFFECT_COMMITTED` until root JSONL append (+ `fsync` of JSONL file & parent dir in `power-loss-safe` mode); un-appended side-effecting sub-calls or interrupted `OPAQUE_EXTERNAL` calls lock session with `OUTCOME_UNKNOWN`. |
| **I-08** | **Single-Owner `flock` + Per-Op `rewind_ops` `/tree` Rewind** | `O_CLOEXEC` kernel `flock(LOCK_EX \| LOCK_NB)` on permanent `.harness/workspace.lock`, dirty-tree safety ref, ordered per-operation `rewind_ops` (`UNLINK_FILE` $\to$ `RMDIR_EMPTY` $\to$ `ENSURE_DIR` $\to$ `WRITE_BLOB` / `HALT_UNSUPPORTED`) with step-specific `expected_before`/`expected_after` and `PENDING`/`COMPLETED` crash idempotency across `file ↔ dir`, fail-closed symlink/submodule divergence, and durable `pi_apex_rewind_anchor` JSONL entries. |
| **I-09** | **1-Level Disjoint Worktree Isolation (`Ring 2`)** | `maxDepth = 1`, disjoint `ownedFiles`, writable `<main>/.git/worktrees/<id>` + RO `<main>/.git/hooks`, `_staging` test gate, sanitized `blind_reviewer`. |
| **I-10** | **Two-Stage Warm-Prefix Compaction (`Ring 1`)** | Stage 1 uses `SessionManager.appendContextEdit()` (`0` LLM calls); Stage 2 summarizes warm prefix only when utilization remains `>= 0.80`. |
| **I-11** | **Unattended Cron Mutation Quarantine & Guardrail Pin** | `unattended = true` hard-blocks external mutations (`DENY_UNATTENDED`). `GUARDRAILS.yaml` (`0444`, outside `<workspaceRoot>`) is verified against `COMPILED_GUARDRAILS_SHA256` at boot. |
| **I-12** | **Dual-Tier Verification** | **Tier-A (`< 2s`)** deterministic unit & syscall race-injection suite (`0000`/`0755` modes, `FD_CLOEXEC`, `power-loss-safe` JSONL `fsync` gate) + **Tier-B** real `bwrap` (historical + dangling `.git/objects` blobs & linked `git worktree`), real `SIGKILL` (WAL + surviving-grandchild `flock`), per-`op_seq` `file ↔ dir` rewind crash recovery, and live `pi@1.4.0` QuickJS WASM integration suite. |

---

## 1. Verified `@earendil-works/pi-*@1.4.0` SDK Seams Used by `Ring 0`

1. **Core Session & Shared Runtime (`sdk.d.ts`):**
   - `ModelRuntime.create({ authPath, credentials, refreshOnCreate: false })` passed into `createAgentSession(...)`, followed by `session.setActiveToolsByName(["read", "bash", "edit", "write", "codemode"])`.
2. **Pluggable Confined Built-In Tool Backends (`tools/{read,write,edit,bash}.d.ts`):**
   - `createReadToolDefinition(cwd, { operations: ReadOperations })` → `openat2(wsFd, relPath, O_RDONLY, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` + `.git/**` block + `fstatSync(fd)` `(dev, ino)` secret/hardlink block.
   - `createWriteToolDefinition(cwd, { operations: WriteOperations })` & `createEditToolDefinition(cwd, { operations: EditOperations })` → descriptor-relative `writeFileDurable()` (`openat2` + `fchmodSync` preserving existing `st.mode & 0o777` + `fsyncSync(tmpFd)` + `renameat` + `fsyncSync(parentDirFd)`).
   - `createBashToolDefinition(cwd, { operations: BashOperations, exposeSessionEnvironment: false })` → minimal-rootfs `bwrap` + `--clearenv` + `--unshare-net` + recursive secret/hardlink `/dev/null` masks + historical-secret `.git/objects` `--tmpfs` overlay.
3. **Nested `Codemode` Pipeline (`extensions/codemode/tool.js` + `extensions/types.d.ts`):**
   - `createCodemodeExtension({ mode: "on" })` routes nested script calls (`await tools.<name>(...)`) through `ctx.executeTool()` (`event.toolCallId = "<parentId>/<n>"`, `event.parentToolCallId = "<parentId>"`).
4. **Session Tree Persistence (`session-manager.d.ts` & `.js`):**
   - `sessionManager.branch(toLeafId)` + `sessionManager.appendCustomEntry("pi_apex_rewind_anchor", { txId, toLeafId })`.

---

## 2. Exact SQLite Schema (`state.db` — `Ring 0`)

```sql
CREATE TABLE IF NOT EXISTS repo_meta (
  repo_root             TEXT PRIMARY KEY,
  git_object_format     TEXT NOT NULL CHECK (git_object_format IN ('sha1','sha256')),
  created_at_ms         INTEGER NOT NULL
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
  before_content_sha256 TEXT,                     -- Raw file SHA-256 ('MISSING' if absent pre-write)
  after_content_sha256  TEXT,                     -- Expected raw file SHA-256 post-write
  canonical_args        TEXT NOT NULL,
  status                TEXT NOT NULL CHECK (status IN (
                          'INTENT_LOGGED',
                          'EXECUTING',
                          'EFFECT_COMMITTED_RAW',  -- Effect finished; before optional spill/formatting
                          'EFFECT_COMMITTED',      -- Scrubbed & spilled payload finalized (including QuickJS VM return prior to root JSONL append)
                          'TRANSCRIPT_APPENDED',   -- Root toolResult durably persisted to Pi SessionManager JSONL
                          'OUTCOME_UNKNOWN',       -- Interrupted OPAQUE_EXTERNAL, drifted file, or un-appended nested mutation
                          'ABORTED_CLEAN',         -- Interrupted before dispatch or verified untouched
                          'RESOLVED_BY_USER'       -- Explicit operator resolution of OUTCOME_UNKNOWN
                        )),
  raw_receipt_json      TEXT,                      -- Infallibly scrubbed receipt written at EFFECT_COMMITTED_RAW
  result_json           TEXT,                      -- Final formatted tool output written at EFFECT_COMMITTED
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
  git_tree_oid          TEXT NOT NULL,             -- Repository-native Git tree OID (40-hex sha1 or 64-hex sha256)
  file_hashes_json      TEXT NOT NULL,             -- Map<relPath, raw_content_sha256>
  entry_states_json     TEXT NOT NULL DEFAULT '{}',-- Map<relPath, { kind, hash, mode }> (9-bit POSIX mode on files)
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
  safety_git_ref        TEXT,                      -- refs/pi-apex/safety/<txId> if dirty pre-rewind
  pre_hashes_json       TEXT NOT NULL,
  target_hashes_json    TEXT NOT NULL,
  pre_states_json       TEXT NOT NULL DEFAULT '{}',-- Map<affectedRelPath, { kind, hash, mode }> at rewind start
  target_states_json    TEXT NOT NULL DEFAULT '{}',-- Map<affectedRelPath, { kind, hash, mode }> at target leaf
  restore_paths_json    TEXT NOT NULL DEFAULT '[]',-- Ordered JSON string[] of affected paths to materialize
  delete_paths_json     TEXT NOT NULL,             -- Ordered JSON string[] of affected paths to unlink
  phase                 TEXT NOT NULL CHECK (phase IN ('PREPARING','APPLYING_DISK','DISK_APPLIED','COMPLETED','CONFLICT_HALTED')),
  conflict_detail_json  TEXT,
  created_at_ms         INTEGER NOT NULL,
  updated_at_ms         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS rewind_ops (
  tx_id                 TEXT NOT NULL REFERENCES rewind_journal(tx_id) ON DELETE CASCADE,
  op_seq                INTEGER NOT NULL,
  op_kind               TEXT NOT NULL CHECK (op_kind IN (
                          'UNLINK_FILE',
                          'RMDIR_EMPTY',
                          'ENSURE_DIR',
                          'WRITE_BLOB',
                          'HALT_UNSUPPORTED'
                        )),
  rel_path              TEXT NOT NULL,
  expected_before_json  TEXT NOT NULL,             -- Step-specific expected { kind, hash, mode } prior to op_seq
  expected_after_json   TEXT NOT NULL,             -- Step-specific expected { kind, hash, mode } after op_seq
  git_blob_oid          TEXT,                      -- Target blob OID for WRITE_BLOB
  halt_reason           TEXT,                      -- Reason code for HALT_UNSUPPORTED
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

CREATE VIRTUAL TABLE IF NOT EXISTS episodes_fts USING fts5(
  summary, files_touched, content='episodes', content_rowid='id', tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS trg_episodes_ai AFTER INSERT ON episodes BEGIN
  INSERT INTO episodes_fts(rowid, summary, files_touched) VALUES (new.id, new.summary, new.files_touched);
END;
CREATE TRIGGER IF NOT EXISTS trg_episodes_ad AFTER DELETE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, summary, files_touched) VALUES ('delete', old.id, old.summary, old.files_touched);
END;
CREATE TRIGGER IF NOT EXISTS trg_episodes_au AFTER UPDATE ON episodes BEGIN
  INSERT INTO episodes_fts(episodes_fts, rowid, summary, files_touched) VALUES ('delete', old.id, old.summary, old.files_touched);
  INSERT INTO episodes_fts(rowid, summary, files_touched) VALUES (new.id, new.summary, new.files_touched);
END;
```

---

## 3. Security, Durability & Recovery Algorithms (`Ring 0`)

### 3.0 Explicit Durability Modes & SQLite / Git Synchronization Contract

Pi-Apex exposes two explicit `DurabilityMode` settings across `StateDb`, `writeFileDurable()`, and `git-rewind.ts`:

| Mode | Fault Boundary Covered | SQLite Pragmas (`state.db`) | Filesystem & Transcript Writes | Git Object / Ref Writes |
|---|---|---|---|---|
| **`crash-safe` (Default)** | Process exceptions, V8 OOM, abort signals, and **`SIGKILL` (`kill -9`)** while the OS kernel remains running. Does **not** claim survival across sudden host power loss / kernel panic prior to page-cache writeback. | `PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;` | Descriptor-relative temp write (`openat2` `O_CREAT\|O_EXCL\|O_WRONLY`) + `fchmodSync(tmpFd)` + `renameat(parentDirFd, tmp, leaf)`. | Standard Git loose-object atomic write + rename. |
| **`power-loss-safe` (Opt-In)** | Sudden power loss / kernel crash on filesystems honoring POSIX `fsync`. | `PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;` | Adds **`fs.fsyncSync(tmpFd)`** before `closeSync(tmpFd)`, **`fs.fsyncSync(parentDirFd)`** after `renameat`, and **`syncSessionTranscriptDurable()` (`fsync` on both session `.jsonl` file and parent directory)** before marking normal root/nested WAL call trees `TRANSCRIPT_APPENDED` **and** after `pi_apex_rewind_anchor` append. | Pairs with `git config core.fsync object,reference,derived-metadata` + `fs.fsyncSync(wsFd)`. |

In **both** modes:
- Online backups of `state.db` MUST use `node:sqlite` `backup(db, destPath)` (never `rename()` over an open WAL database inode and never raw file copies of `-wal`/`-shm` sidecars).
- Even when `wal_intents.status` is `EFFECT_COMMITTED`, cached `LOCAL_REVERSIBLE` replay re-hashes `target_path` on disk (`computeFileContentSha256`): if `diskSha256 !== after_content_sha256`, the row downgrades to **`OUTCOME_UNKNOWN`** instead of serving stale cached success.

### 3.1 Minimal-Rootfs `bwrap`, Descriptor-Bound `O_CLOEXEC` FS Broker & Secret/`.git` Confidentiality (`src/native/linux_fs_bridge.c`, `src/core/safe-path.ts`, `src/core/bwrap-sandbox.ts`)

1. **Minimal-Rootfs Mount & Namespace Isolation:**
   - Never bind `/` or `$HOME`. Bind read-only only `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64`, `/etc/alternatives`, `/etc/ld.so.cache`, `/etc/ssl/certs`, `/etc/ca-certificates`; mount `--proc /proc`, `--dev /dev`, `--tmpfs /tmp`, `--tmpfs /run`, `--tmpfs /home`, `--dir /home/sandbox`.
   - Mount `<workspaceRoot>` (`--ro-bind` in `read-only`; `--bind` in `workspace-write`), followed by `extraReadOnlyPaths` / `extraWritablePaths`, and then overlay `--ro-bind` on `.harness`, `gitDir/hooks`, `gitDir/config`, `commonDir/hooks`, and `commonDir/config` so extra binds can never overmount control-plane protections.
   - Run with `--unshare-net` (by default), `--unshare-pid`, `--die-with-parent`, `--new-session`, `--clearenv`, exporting only `PATH`, `HOME=/home/sandbox`, `TMPDIR=/tmp`, `LANG=C.UTF-8`, `TERM=dumb`.
2. **Descriptor-Relative `O_CLOEXEC` Syscall Broker (`linux_fs_bridge.node`):**
   - All host-side workspace operations open `wsFd = openRootDir(realWs)` (`open(realWs, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC)`) and resolve paths strictly via Linux **`openat2(wsFd, relPath, how)`** with **`how.flags = flags | O_CLOEXEC`** and `how.resolve = RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS`.
   - All directory creations, empty-directory removals, renames, file unlinks, and non-follow stats execute on the pinned `parentDirFd` via **`mkdirat`**, **`unlinkat(AT_REMOVEDIR)`**, **`renameat`**, **`unlinkat(0)`**, and **`fstatat(AT_SYMLINK_NOFOLLOW)`**, verifying `/proc/self/fd/<parentDirFd>` still resides inside `realWs` immediately prior to mutation.
3. **Working-Tree, Hardlink & `.git/objects` Secret Confidentiality:**
   - **Working-Tree & Hardlink Scan:** Recursively scans `<workspaceRoot>` (including untracked/gitignored directories like `service/.env`; skipping only `.git` and `.harness`) for secret basenames (`.env`, `.env.*` except `.env.example`/`.env.sample`/`.env.template`, `.npmrc`, `.netrc`, `.pypirc`, `.pgpass`, `id_rsa`, `id_ed25519`, `id_ecdsa`, `id_dsa`, `*.pem`, `*.key`, `*.p12`, `*.pfx`). Records `(dev, ino)` in `secretInodeKeys`; whenever `st.nlink > 1`, sweeps regular files across `<workspaceRoot>` to mask every hardlink alias with `--ro-bind /dev/null` in `bwrap` and reject it via `fstatSync(fd)` in `ReadOperations`/`WriteOperations` (plus rejecting external hardlinks where `inWorkspaceLinks < st.nlink`).
   - **Unconditional Default `.git` Object & Reflog Isolation Across Standard Repos & Linked Worktrees:**
     - Direct `read`/`write`/`edit` tools reject `.git` and `.git/**` unconditionally, and `snapshotWorkingTreeToGit()` dynamically excludes all secret paths and hardlink aliases so Pi-Apex checkpoints never write secrets into `.git/objects`.
     - `resolveGitRepositoryLayout()` inspects `<ws>/.git` (`lstatSync`): for standard repositories (`isDirectory()`), `gitDir = commonDir = realpath(<ws>/.git)`; for linked `git worktree` checkouts (`isFile()` starting with `gitdir:`), it resolves `gitDir`, follows `<gitDir>/commondir` to `commonDir`, and collects all object stores (`<commonDir>/objects`, `<gitDir>/objects`, plus `<objects>/info/alternates`) and reflog directories (`<commonDir>/logs`, `<gitDir>/logs`).
     - **`isolateGitObjectsMode` defaults to `"always"`**: `bwrap` mounts **`--tmpfs`** over every resolved `objects` and `logs` directory across both standard repos and linked worktrees, blocking `git cat-file` and pack/loose object reads of **reachable historical commits, reflog-only commits, and unreachable/dangling secret blobs prior to `git gc --prune=now`**. Opt-in `"on-historical-secret"` is explicitly documented as a weaker heuristic that inspects only reachable `git ls-files -z` and `git log --all --name-only -z` paths.
   - **Explicit Confidentiality Scope Boundary:** Mount/inode masking and `.git` isolation cannot identify secrets manually copied by a user into a distinct inode under a non-secret filename inside `<workspaceRoot>` (e.g., `cp .env scratch.txt`) unless the output matches known credential token patterns caught by `scrubSecretsInfallible()`.

### 3.2 Post-Effect WAL Receipt, Synced Transcript Durability & Mode-Exact `writeFileDurable` (`src/core/wal-recovery.ts`)

```text
INTENT_LOGGED ──► EXECUTING ──(effect returns)──► EFFECT_COMMITTED_RAW ──(spill/format)──► EFFECT_COMMITTED ──(root JSONL append + fsync in power-loss-safe)──► TRANSCRIPT_APPENDED
       │              │                                    │                                       │
  (crash pre-exec) (crash/throw mid-exec)           (crash pre-spill or ENOSPC)             (nested QuickJS call crashes before root JSONL append/fsync)
       ▼              ▼                                    ▼                                       ▼
 ABORTED_CLEAN   LOCAL_REVERSIBLE: check disk SHA-256  reconcileWalOnStartup promotes          PURE_READ -> ABORTED_CLEAN
                 OPAQUE_EXTERNAL:  OUTCOME_UNKNOWN     via scrubAndMaybeSpill() ->             LOCAL_REVERSIBLE / OPAQUE_EXTERNAL ->
                                                       EFFECT_COMMITTED (never re-execs!)      OUTCOME_UNKNOWN lock w/ committed child receipts
```

- **`writeFileDurable(targetPath, content, durabilityMode, options?)`:**
  1. Opens `parentDirFd` beneath `wsFd` via `openat2(O_CLOEXEC | RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` (creating missing ancestor dirs via `mkdirat`).
  2. Inspects existing leaf via `fstatat(parentDirFd, leafName, AT_SYMLINK_NOFOLLOW)`: rejects symlinks/directories; computes `rawMode = options?.mode !== undefined ? options.mode : existingMode !== null ? existingMode : (0o666 & ~umask)` and **`targetMode = rawMode & 0o777`** — never using `|| 0o644`, so valid `0o000` (`0000`), `0o600`, and `0o755` modes are preserved identically on creation and overwrite while `setuid`/`setgid`/`sticky` bits are masked off.
  3. Creates `.pi-apex-tmp.<pid>.<rand>` via `openat2(parentDirFd, tmpName, O_CREAT | O_EXCL | O_WRONLY | O_CLOEXEC, 0600)`, writes bytes, `fchmodSync(tmpFd, targetMode)`, `fsyncSync(tmpFd)` (in `power-loss-safe`), `closeSync(tmpFd)`.
  4. Verifies `/proc/self/fd/<parentDirFd>` remains inside `realWs`, commits via **`renameat(parentDirFd, tmpName, parentDirFd, leafName)`**, and `fsyncSync(parentDirFd)` (in `power-loss-safe`).
- **`EFFECT_COMMITTED_RAW`, Nested QuickJS Sub-Calls & `power-loss-safe` Transcript Sync (`reconcileWalOnStartup`, `syncSessionTranscriptDurable`):**
  1. Rows in `EFFECT_COMMITTED_RAW` verify `LOCAL_REVERSIBLE` `after_content_sha256` on disk, run `spillStore.scrubAndMaybeSpill()`, write `result_json`, and transition to `EFFECT_COMMITTED`.
  2. Nested `<parentId>/<n>` calls returning to QuickJS RAM stop at `EFFECT_COMMITTED`. At `turn_end`, after `SessionManager` appends the root `toolResult` to `.jsonl`, `ring0-session.ts` runs **`syncSessionTranscriptDurable(sessionFile, durabilityMode, true)`** (which `fsync`s both the `.jsonl` file and its parent directory in `power-loss-safe` mode; `markWalCallTreeTranscriptAppended` throws `TranscriptNotSyncedError` if called unsynced) **before** transitioning root + child WAL rows to `TRANSCRIPT_APPENDED`.

### 3.3 Single-Owner `flock` & Per-Operation `rewind_ops` `/tree` Rewind Protocol (`src/core/workspace-lock.ts`, `src/core/git-rewind.ts`)

1. **Acquire Single-Owner `O_CLOEXEC` Kernel `flock` Lock (`.harness/workspace.lock`):**
   - Open `.harness/workspace.lock` via `openat2(wsFd, ".harness/workspace.lock", O_CREAT | O_RDWR | O_CLOEXEC, 0600, RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` (**never unlinking** the lockfile inode).
   - Call **`flock(lockFd, LOCK_EX | LOCK_NB)`** inside `linux_fs_bridge.node` (which also enforces `FD_CLOEXEC` via `fcntl(F_GETFD)` / `F_SETFD`), and verify `bridge.hasCloexec(lockFd) === true`.
   - **Single-Owner Descriptor Rule:** `lockFd` is owned exclusively by `WorkspaceLockHandle`, is never `dup()`ed, and is never passed into child `spawn` `stdio`. Because `flock(2)` binds to the kernel open file description and `FD_CLOEXEC` closes `lockFd` across `execve(2)`, `SIGKILL` (`kill -9`) of the harness process closes the sole open file description and releases the lock immediately even if child processes spawned while holding the lock remain alive.
2. **Dirty-Tree Safety Stash (`T_now` vs `T_from`):**
   - Snapshot `T_now` (`gitTreeOid` + `entryStates`); if `T_now !== T_from` (in tree OID or `entryStates`), record `refs/pi-apex/safety/<txId>`.
3. **Compile & Persist Ordered `rewind_ops` Plan (`phase = 'PREPARING'`):**
   - Each entry state is `{ kind: 'missing' | 'file' | 'dir' | 'symlink' | 'submodule' | 'other', hash: string | null, mode: number | null }` where `mode` for `kind === 'file'` is `st.mode & 0o777` (`0o000`..`0o777`). Paths where `entryStatesEqual(cur, tgt)` are untouched.
   - Inside a single `BEGIN IMMEDIATE ... COMMIT` transaction, persist `rewind_journal` plus the ordered `rewind_ops` rows (`status = 'PENDING'`), each carrying its step-specific `(expected_before_json, expected_after_json)`:
     - **Phase 0 (`HALT_UNSUPPORTED`):** Any diverged `submodule` (`SUBMODULE_STATE_DIVERGENCE`) or diverged `symlink` (`SYMLINK_TRANSITION_REQUIRES_OPERATOR`).
     - **Phase 1 (`UNLINK_FILE`, deepest-path-first):** Regular files absent as regular files at target (`file -> missing` and `file -> dir`), transitioning `file -> missing`.
     - **Phase 2 (`RMDIR_EMPTY`, deepest-path-first):** Existing directories colliding with a target regular file (`dir -> file`, or nested under it) or emptied by Phase 1 and absent from `targetDirs`, transitioning `dir -> missing` via `unlinkat(..., AT_REMOVEDIR)`.
     - **Phase 3 (`ENSURE_DIR`, shallowest-path-first):** Target directories not already surviving on disk (including `file -> dir` after Phase 1 unlinked the file!), transitioning `missing -> dir` via `mkdirat`.
     - **Phase 4 (`WRITE_BLOB`, shallowest-path-first):** Changed or restored regular files (`file -> file`, `missing -> file`, and `dir -> file` after Phase 2 removed the directory), transitioning `expectedBefore -> targetFileState` via `writeFileDurable(..., { mode: exactMode, workspaceRoot })`.
4. **Per-Op Pre-Flight Audit & Crash-Idempotent Execution (`phase = 'APPLYING_DISK'` $\to$ `'DISK_APPLIED'`):**
   - Query `SELECT * FROM rewind_ops WHERE tx_id = ? AND status = 'PENDING' ORDER BY op_seq ASC` (**already-`COMPLETED` operations are never re-audited or re-executed**).
   - For the **first `PENDING` operation** on each `rel_path`, inspect live disk state beneath `wsFd`:
     - Halt with `CONFLICT_HALTED` on `HALT_UNSUPPORTED`, `ANCESTOR_SYMLINK_CONTAMINATION`, unscheduled children inside a pending `RMDIR_EMPTY` (`UNSCHEDULED_CHILDREN_IN_RMDIR`), or when `!entryStatesEqual(liveState, op.expectedBefore) && !entryStatesEqual(liveState, op.expectedAfter)`.
   - Execute each `PENDING` op sequentially under `lock.assertHeld()`:
     - If `entryStatesEqual(liveNow, op.expectedAfter)` (crash occurred after the kernel syscall succeeded but before SQLite committed `status = 'COMPLETED'`), mark `op_seq` `COMPLETED` immediately without re-invoking the syscall.
     - Otherwise verify `entryStatesEqual(liveNow, op.expectedBefore)`, execute the exact op syscall (`unlinkSafeBeneathWorkspace`, `rmdirEmptyBeneathWorkspace`, `mkdirSingleBeneathWorkspace`, or `writeFileDurable`), and commit `UPDATE rewind_ops SET status = 'COMPLETED'` for `op_seq`.
5. **Durable Idempotent Pi Leaf Update (`phase = 'COMPLETED'`):**
   - Verify `lock.assertHeld()`, idempotently append `pi_apex_rewind_anchor` (`syncSessionTranscriptDurable` `fsync`s JSONL + parent dir in `power-loss-safe`), mark `COMPLETED`, and release `flock`.
6. **Startup Recovery (`recoverInterruptedRewinds`):**
   - Under `flock`, resumes only remaining `PENDING` `rewind_ops` rows in `op_seq` order: crashing at any intermediate step of `file -> dir` (after `UNLINK_FILE` when path is `missing`, or after `ENSURE_DIR` when path is `dir`) or `dir -> file` (after child `UNLINK_FILE` or after `RMDIR_EMPTY`) recovers cleanly to `COMPLETED` without false conflicts or unlinking a restored target directory.

---

## 4. Phased Build & Validation Roadmap

- **Ring 0 (Implemented & Verified First — Mandatory Gate):**
  - `linux_fs_bridge.c` / `linux-fs-bridge.ts`, `guardrail-pin.ts`, `safe-path.ts`, `workspace-lock.ts`, `prefix-budget.ts` (`<= 2,100` `o200k_base` static prefix budget; `1,073` active schema tokens), `state-db.ts`, `spill-store.ts`, `wal-recovery.ts`, `bwrap-sandbox.ts`, `git-rewind.ts`, `monotonic-guard.ts`, and `ring0-session.ts`.
- **Ring 1 (Implemented & Verified — `src/ring1/*`, `test/ring1/run-ring1-tests.ts`):**
  - `scoped-rules-loader.ts` (descriptor-confined `.mdc` glob & subdirectory `AGENTS.md` tail-only loader `<= 32 KiB` with `/tree` branch-aware deduplication + OpenCode `ENOENT` sibling fuzzy hints), `two-stage-compaction.ts` (`SessionManager.appendContextEdit` `0`-LLM Stage 1 $\to$ `<compacted-summary>` Stage 2 + FTS5 episode via `turn_end` `BoundaryResult`), `loop-guard.ts` (deterministic 3-strike identical-call & `A -> B -> A -> B` edit ping-pong gate), `merkle-repo-map.ts` (real `web-tree-sitter` WASM AST + directory Merkle rollup + PageRank/BM25 `repo_map` at `exposure: "deferred"` = `+0` schema tokens), `lsp-client.ts` (workspace-trust-gated stdio `Content-Length` JSON-RPC 2.0 client with OpenCode's 9 semantic ops + `read` warm-up + `<lsp-diagnostics>` tail), and `ring1-extension.ts`.
- **Ring 2 (Implemented & Verified — `src/ring2/*`, `test/ring2/run-ring2-tests.ts`, Upstream OSS-Integrated):**
  - `plan-trust-artifacts.ts` (adapted from `@earendil-works/pi-coding-agent` `examples/extensions/plan-mode/{utils,index}.ts` + Antigravity Trust Artifacts + `AgentSession.steer()`/`sendCustomMessage()` inline line-anchored review steering + compound-shell hardening), `worktree-subagent-pool.ts` (adapted from Pi `subagent/{index,agents}.ts` & `git-merge-and-resolve.ts` + `anomalyco/opencode` `packages/core/src/git.ts` + PR `#14649` orphan-worktree cleanup fix across 5 roles with disjoint `ownedPaths` & depth-1 cap), `bugbot-ci-loop.ts` (adapted from `openai/codex` `v2/review.rs` + `tasks/review.rs` + `review_format.rs` with Issues `#8404`/`#17160` `mergeBase...HEAD` fix + Cursor BugBot `REVIEW_RULES.md` + bounded CI autofix loop), `agent-browser-ref.ts` (adapted from `vercel-labs/agent-browser` `cli/src/native/snapshot.rs` & `eve/extension` with Issues `#1443` stale-ref block & `#2147` `StaticText` retention fixes + RFC-2083 PNG `ImageContent` screenshots), `pty-cron-routines.ts` (adapted from `anomalyco/opencode` `pty.ts` 2 MiB cursor ring buffer + `NousResearch/hermes-agent` `process_registry.py` & `cron/jobs.py` + Ring 0 `DENY_UNATTENDED` gate), and `ring2-extension.ts` (`+0` active schema tokens across all 6 Ring 2 deferred tools).
- **Ring 3 (Implemented & Verified — `src/ring3/*`, `test/ring3/run-ring3-tests.ts`, Upstream OSS-Integrated):**
  - `skills-guard-quarantine.ts` (adapted from `NousResearch/hermes-agent @ 765c6463009f` `tools/skills_guard.py` `skills-guard-v10`, `tools/skill_manager_tool.py`, `tools/skill_manager_guards.py`, and `agent/curator.py` — quarantine-first `.skills-quarantine/` distillation, static threat/injection/exfil/#63307/bidi scan, operator-approved promotion, `#11227` symlink refusal, `#29912` `absorbedInto` umbrella consolidation guard, and `14d -> stale -> 30d -> archived` lifecycle pass), `harness2-contrastive-evolver.ts` (adapted from `google-research/harness2 @ 1cfe254e8d25` `harness2/core/{library,selection,context}.py` — deterministic SHA-1 candidate anonymization `assignAnonymousCandidateIds`, `<experience>`/`<edits>`/`choice` parsers, `GRADER_VERDICT_MARKERS` leak tripwire, domain `INDEX.md` library, and 4-gate validator confining self-evolution strictly to `surfaces/EXPERIENCE.md` while keeping `surfaces-immutable/GUARDRAILS.yaml` `0444` + SHA-256 pinned to neutralize `Harness²` Issue `#94`), `dreaming-consolidator.ts` (adapted from `NousResearch/hermes-agent @ 765c6463009f` `agent/memory_manager.py` `_redact_for_provider` `#115104` two-pass learned-token scrubber + FTS5 episodic consolidation into `<= 300`-token `surfaces/MEMORY.md` staged for next session boot with `0` live static-prefix drift), `cua-computer-driver.ts` (optional disabled-by-default, viewport-bounded, operator-approval-gated GUI computer-use controller emitting RFC-2083 PNG `ImageContent` screenshots), and `ring3-extension.ts` (`+0` active schema tokens across all 14 Ring 1–3 deferred specialist tools, including explicit skill access and episode recall: `1,073 === 1,073 o200k_base` tokens).
- **Ring 4 (Implemented & Verified — Production Operator CLI, Interactive TUI & Slash-Command Shell — `src/ring4/*`, `src/cli/*`, `bin/pi-apex`, `test/ring4/run-ring4-tests.ts`):**
  - Wires `createRing3Harness` into `@earendil-works/pi-coding-agent@1.4.0`'s native `AgentSessionRuntime`, `InteractiveMode` (`@earendil-works/pi-tui@1.4.0`), `runPrintMode` (`text` & `json`), `runRpcMode` (`RpcClient`), `parseArgs`, and `resolveCliModel`, plus 7 zero-token operator slash commands (`/plan`, `/rewind`, `/review`, `/quarantine`, `/dream`, `/evolve`, `/doctor`) verified end-to-end across `R4-1`–`R4-6` (`1,073 === 1,073 o200k_base` active schema tokens; `0` mid-session prefix drift).
- **Ring 5 (Implemented & Verified — Live Mission-Control Web Cockpit, Multi-Ring Stress/Eval Suite & Personal Installer — `src/ring5/*`, `scripts/install-personal.sh`, `test/ring5/run-ring5-tests.ts`):**
  - Out-of-band HTTP + SSE Mission-Control Web UI (`0.0.0.0` preview-safe host binding, strictly relative browser URLs, delta-efficient `toJsonEvent` SSE stream, inline line-anchored Trust Artifact `steer()`, `.skills-quarantine/` promotion gate, `/tree` Git rewind graph, and live prefix/WAL/`/doctor` telemetry), programmatic multi-ring SWE & adversarial stress/eval suite (`E2E-1` & `E2E-2`), `--web`/`--port`/`--seed-demo` CLI launcher, and portable `~/.local/bin/pi-apex` + `systemd --user` installer (`R5-1`–`R5-6` PASS).
- **Ring 6 (Implemented & Verified — Daily-Driver Production Pack: Confined `@earendil-works/pi-mcp` Bridge, Cache-Preserving `apex/auto` Virtual Router, Mission-Control Cockpit v2 & Portable Release Bundle — `src/ring6/*`, `src/ring5/*`, `scripts/package-release.sh`, `test/ring6/run-ring6-tests.ts`):**
  - Zero-schema-bloat MCP client hub built atop `@earendil-works/pi-mcp@1.4.0` (`McpClient`, `StdioTransport`, `StreamableHttpTransport`, `toLlmContent`) with `exposure: "deferred"`, untrusted-repo stdio block, `inheritEnv: false` clean env allowlist, and `skills-guard-v10` + `scrubSecretsInfallible()` poisoning/secret defense; cache-preserving `apex/auto` virtual model router adapted from `@earendil-works/pi-coding-agent` `examples/extensions/jev-router.ts` + local Ollama/OpenAI-compatible `registerProvider` & prompt-cache/cost telemetry; Mission-Control Cockpit v2 (live streaming multi-turn chat transcript, unified Git diff viewer, multi-session `.jsonl` switcher, provider/Ollama/MCP drawer); and portable `/home/user/pi-apex-v3.6.0-personal.tar.gz` bundle (`R6-1`–`R6-6` PASS).
- **Ring 7 (Implemented & Verified — Capstone Autonomous Orchestration Pack: Autonomous Issue-to-PR Pipeline, Pi Session Handoff / Zero-Drift Presets / Bookmarks, Real Headless Chromium CDP WebSocket Driver, Multi-Workspace Cockpit v3 & `v3.7.0` Release Bundle — `src/ring7/*`, `src/ring2/*`, `src/ring4/*`, `src/ring5/*`, `test/ring7/run-ring7-tests.ts`):**
  - End-to-end 6-stage `AutonomousPrPipeline` (`/pr` + deferred `pr_pipeline` tool: isolated `apex/<slug>` Git branch $\to$ Plan Trust Artifact $\to$ disjoint `git worktree` subagents $\to$ Codex three-dot `mergeBase...HEAD` + BugBot `REVIEW_RULES.md` review $\to$ sandboxed `bwrap` CI verification $\to$ secret-scrubbed PR bundle & conventional commit); focused `parentSession`-linked context handoff, zero-prefix-drift named presets, and turn bookmarks adapted from `@earendil-works/pi-coding-agent` `examples/extensions/{handoff,preset,bookmark}.ts` (`/handoff`, `/preset`, `/bookmark`); zero-dependency Node 22 WebSocket Chrome DevTools Protocol (CDP) driver (`Accessibility.getFullAXTree`, `Page.captureScreenshot`, live `MutationObserver` `STALE_SNAPSHOT_REF` `#1443` guard) wired into `AgentBrowserController` (`chromium` 156); Multi-Workspace Mission-Control Cockpit v3; and `/home/user/pi-apex-v3.7.0-personal.tar.gz` (`R7-1`–`R7-6` PASS).

---

## 5. Ring 4 — Production `pi-apex` Operator CLI, Interactive TUI & Slash-Command Specification

### 5.1 Architectural Objectives & Upstream OSS Reuse (`@earendil-works/pi-coding-agent@1.4.0` + `@earendil-works/pi-tui@1.4.0`)

Ring 4 exposes the verified `Ring 0`–`Ring 3` engine as a runnable personal binary (`bin/pi-apex`) without duplicating terminal rendering, JSON-RPC framing, or model-resolution code already shipped in `@earendil-works/pi-coding-agent@1.4.0` and `@earendil-works/pi-tui@1.4.0`:

1. **Zero Active-Schema & Static-Prefix Token Bloat (`Invariant I-01` & `I-03`):**
   - All 7 operator commands register exclusively through `ExtensionAPI.registerCommand(...)` (plus `Key.ctrlAlt("p")` via `registerShortcut`).
   - Because extension commands execute in the host `ExtensionRunner` (`AgentSession._tryExecuteExtensionCommand`) rather than entering `agent.state.tools`, active tool schema tokens remain strictly **`1,073 === 1,073 o200k_base` tokens** and live `prefixSha256` drift remains **`0`**.
2. **`AgentSessionRuntime` Lifecycle Confinement (`src/ring4/ring4-runtime.ts`):**
   - `createRing4Runtime()` wraps `createRing4Harness()` inside `@earendil-works/pi-coding-agent`'s `createAgentSessionRuntime(factory, { cwd, agentDir, sessionManager })`.
   - Before any session switch (`/new`, `/resume`, `/fork`, `runtimeHost.newSession()`, or process exit), the active Ring 0–3 auxiliary handles (`StateDb`, `PtyLeaseManager`, `WorktreeSubagentPool`, `LspClientManager`) are cleanly disposed before the replacement session opens `.harness/state.db`, guaranteeing zero SQLite WAL handle leaks and seamless reload of `Dreaming`-staged `surfaces/MEMORY.md` on `/new`!
3. **Four Native Execution Modes (`src/cli/pi-apex-cli.ts`, `bin/pi-apex`):**
   - **Interactive TUI Mode (Default TTY):** Instantiates `new InteractiveMode(runtimeHost, ...)` over `@earendil-works/pi-tui` (`ProcessTerminal` by default, or an injected `Terminal` for headless TUI verification), enabling full-screen/main-screen markdown rendering, Tab-autocomplete on all slash commands and sub-arguments, `Ctrl+Alt+P` Plan Mode toggle, live status-bar indicators (`ctx.ui.setStatus`), and interactive selection menus (`ctx.ui.select`).
   - **Single-Shot Print Mode (`-p` / `--print` or piped `stdin`):** Delegates to `runPrintMode(runtimeHost, { mode: "text", ... })`. Local operator slash invocations (e.g., `pi-apex -p "/doctor"` or `pi-apex -p "/quarantine list"`) execute offline without requiring a remote LLM API key, emitting deterministic text to `stdout` and recording a `CustomMessageEntry` in the session log.
   - **Structured JSON Event Mode (`--mode json`):** Delegates to `runPrintMode(runtimeHost, { mode: "json", ... })`, emitting NDJSON session header + `AgentSessionEvent` records (including `customType: "pi-apex-command"` results).
   - **Headless JSON-RPC Mode (`--mode rpc`):** Delegates to `runRpcMode(runtimeHost)`, speaking Pi's bidirectional line-delimited JSON-RPC protocol over `stdin`/`stdout` (100% compatible with `@earendil-works/pi-coding-agent`'s `RpcClient`).

### 5.2 CLI Flags & Configuration Precedence (`bin/pi-apex`)

`parsePiApexCliArgs(argv)` preprocesses Pi-Apex-specific confinement flags and delegates all standard agent/model/session flags directly to upstream `parseArgs(remainingArgv)`:

| Flag | Default | Effect |
|---|---|---|
| `--cwd <dir>` | `process.cwd()` | Target workspace root confined by `openat2(RESOLVE_BENEATH \| RESOLVE_NO_SYMLINKS)`. |
| `--surfaces-dir <dir>` | `<packageRoot>/surfaces` (fallback `<cwd>/surfaces`) | Directory containing `SYSTEM.md`, `TOOL_GUIDANCE.md`, `MEMORY.md`, `EXPERIENCE.md`, `SUBAGENTS.yaml`. |
| `--sandbox <mode>` | `"workspace-write"` | Ring 0 `bwrap` sandbox mode (`"read-only"` \| `"workspace-write"`). |
| `--durability <mode>` | `"crash-safe"` | Ring 0 SQLite/FS durability mode (`"crash-safe"` \| `"power-loss-safe"`). |
| `--plan` | `false` | Boot session directly in read-only Plan Mode (`Ring 2`). |
| `--enable-cua` | `false` | Opt-in enablement for the viewport-bounded, approval-gated `cua_control` driver (`Ring 3`). |
| `--allow-unsandboxed-dev` | `false` | Explicit developer override when `bwrap` user namespaces are unavailable in restricted containers. |
| `--provider`, `--model`, `--api-key`, `--thinking`, `--models`, `--list-models`, `-p`/`--print`, `--mode <text\|json\|rpc>`, `-c`/`--continue`, `-r`/`--resume`, `--session`, `--no-session`, `--verbose`, `--offline`, `--help`, `--version` | Upstream Pi defaults | Handled via `@earendil-works/pi-coding-agent` `parseArgs`, `resolveCliModel`, and `ModelRuntime`. |

### 5.3 Operator Slash-Command Contracts (`src/ring4/slash-commands-extension.ts`)

Every command supports Tab-completion (`getArgumentCompletions`), updates TUI status/notifications when `ctx.hasUI` is true, records a structured `CustomMessageEntry` (`customType: "pi-apex-command"`, `triggerTurn: false`), and writes deterministic output in `print` mode:

1. **`/plan [on | off | toggle | status | list | approve <artifactId> | steer <artifactId> <Lstart[-Lend]> <comment>]`**
   - Toggles Ring 2 read-only Plan Mode (`Ctrl+Alt+P` shortcut), displays active Trust Artifacts (`plan`, `diff`, `verification`) with `[DONE:n]` step progress, approves a Plan Trust Artifact to unlock execution, or injects inline line-anchored feedback via `TrustArtifactController.submitInlineReviewComments()`.
2. **`/rewind [list | <leafId>]`**
   - `list` (or no args in non-UI mode): Lists captured `git_checkpoints` (`turn_index`, `leaf_id`, `git_tree_oid`, timestamp) for the current session.
   - Interactive TUI with no args: Opens `ctx.ui.select(...)` over captured checkpoints and confirms before rewinding.
   - `<leafId>`: Acquires single-owner `O_CLOEXEC` `flock` and executes `rewindChatAndDiskToLeaf(...)` (`{kind, hash, mode}` restoration + `pi_apex_rewind_anchor`), reporting restored/deleted paths and any `safetyGitRef` stash.
3. **`/review [uncommitted | base <branch> | commit <sha> | ci <command>]`**
   - Runs Ring 2 `BugBotAndCiEngine.runCodeReview(...)` (`REVIEW_RULES.md` + Codex `ReviewOutputEvent` with `mergeBase...HEAD` `#8404` fix) or `runCiVerificationLoop(...)` and records a `verification` Trust Artifact.
4. **`/quarantine [list [status] | inspect <name> | promote <name> | consolidate <name> <umbrella> | lifecycle]`**
   - Manages Ring 3 `.skills-quarantine/` and `.agents/skills/`: displays `skills-guard-v10` scan verdicts and findings, promotes clean skills with `operatorApproved: true` (still hard-blocking `dangerous` findings!), consolidates redundant skills into an existing umbrella (`#29912`), or runs the `14d -> stale -> 30d -> archived` curator pass.
5. **`/dream [query]`**
   - Invokes Ring 3 `DreamingMemoryConsolidator.runDreamingPass(...)`, scrubbing FTS5 episodes with Hermes `#115104` two-pass learned-token redaction, filtering poisoned episodes, writing `<= 300`-token `surfaces/MEMORY.md` for the next session boot (`/new`), and verifying `0` live static-prefix SHA-256 drift.
6. **`/evolve [status | recall <domain> [query]]`**
   - Displays `surfaces/EXPERIENCE.md` `o200k_base` token usage and live `COMPILED_GUARDRAILS_SHA256` verification status, or queries `.harness/experience-library/<domain>/INDEX.md` for matching `cue -> lesson` entries.
7. **`/doctor`**
   - Runs a 9-point deterministic health & security audit: (1) N-API `linux_fs_bridge.node` `openat2` + `FD_CLOEXEC`, (2) `GUARDRAILS.yaml` `0444` & `COMPILED_GUARDRAILS_SHA256` pin, (3) `bwrap` availability, (4) Git repo & object format, (5) SQLite WAL + `episodes_fts` integrity check, (6) `wal_intents` `OUTCOME_UNKNOWN` audit, (7) exact `o200k_base` static prefix & `1,073`-token active schema audit, (8) `.skills-quarantine/` queue status, and (9) active model/provider state.

### 5.4 Ring 4 Acceptance Gate (`test/ring4/run-ring4-tests.ts`, `R4-1`–`R4-6`)

- **`R4-1`:** Active tool schema strictly `1,073 === 1,073 o200k_base` tokens (`+0` bloat) with all 7 slash commands, `Ctrl+Alt+P` shortcut, and Tab-argument completions registered.
- **`R4-2`:** End-to-end execution of all 7 slash commands (`/doctor`, `/plan`, `/rewind`, `/review`, `/quarantine`, `/dream`, `/evolve`) against real Git checkpoints, quarantined clean & poisoned skills, FTS5 episodes, and BugBot diffs, with `0` live prefix hash drift.
- **`R4-3`:** Real `@earendil-works/pi-tui` `InteractiveMode` booted over an instrumented headless `Terminal`, rendering startup UI & status bar, executing `/plan on` and `/doctor`, and tearing down cleanly.
- **`R4-4`:** Real child-process `bin/pi-apex` CLI execution in `--version`, `--help`, `-p "/doctor"` (offline/keyless print mode), and `--mode json "/quarantine list"` (NDJSON event stream).
- **`R4-5`:** Real child-process `bin/pi-apex --mode rpc` driven via `@earendil-works/pi-coding-agent`'s `RpcClient` (`getState()`, `getCommands()`, `prompt("/plan on")`, `prompt("/doctor")`).
- **`R4-6`:** `runtimeHost.newSession()` lifecycle replacement cleanly closing the prior `StateDb`/handles and booting a fresh session whose frozen static prefix incorporates the `Dreaming`-updated `surfaces/MEMORY.md`.

---

## 6. Ring 5 — Live Mission-Control Web Cockpit, Multi-Ring Stress/Eval Suite & Personal Installer Specification

### 6.1 Architectural Objectives & Confinement Invariants

Ring 5 completes the operator-facing control plane and full-stack stress verification without touching a single token of the LLM context prefix:

1. **Out-of-Band HTTP + SSE Control Plane (`+0` Schema & Prefix Tokens):**
   - `MissionControlServer` (`src/ring5/mission-control-server.ts`) attaches directly to `Ring4RuntimeController` (`AgentSessionRuntime` + `Ring4HarnessInstance`).
   - Active tool schema tokens remain **`1,073 === 1,073 o200k_base` tokens** and live `prefixSha256` drift remains **`0`** across every Web UI inspection, inline `steer()`, quarantine promotion, `/dream` run, or `/rewind`.
2. **Proxy- & Iframe-Preview-Safe Network Contract:**
   - Binds `0.0.0.0` by default (`--host 0.0.0.0 --port 4310`), accepts proxied `Host`/`Origin` headers without allowlist rejection, omits `X-Frame-Options` blocks so embedded browser previews render cleanly, and uses **strictly relative browser URLs** (`./api/...`, `new EventSource("./api/events")`) with zero `localhost`/`127.0.0.1` calls in client-side code and zero external CDN dependencies.
   - Adapts `@earendil-works/pi-coding-agent`'s `toJsonEvent` delta wire serializer (`dist/modes/json-event.js`) so `/api/events` streams constant-size delta events without cumulative partial-message bloat, while passing every outgoing API/SSE payload through `scrubSecretsInfallible()`.

### 6.2 Mission-Control REST & SSE API Surface (`src/ring5/mission-control-server.ts`)

| Endpoint | Method | Purpose |
|---|---|---|
| `/` | `GET` | Serves the self-contained Mission-Control Operator Cockpit HTML/CSS/JS (`src/ring5/mission-control-ui.ts`). |
| `/api/status` | `GET` | Returns live prefix telemetry (`1,073` schema tokens, `textTotal`, `prefixSha256`, `GUARDRAILS.yaml` SHA-256 verification), Plan Mode status, Trust Artifacts, `.skills-quarantine/` & active skills ledger, `git_checkpoints`, `wal_intents` summary, `MEMORY.md`, and `EXPERIENCE.md`. |
| `/api/events` | `GET` (`text/event-stream`) | Streams real-time `AgentSessionEvent` deltas (`toJsonEvent`) + cockpit state-refresh notifications across `/new` session transitions. |
| `/api/plan/toggle` | `POST` | Toggles read-only Plan Mode (`{ enabled?: boolean }`). |
| `/api/artifacts` | `POST` | Creates or updates a structured Trust Artifact (`plan`, `diff`, `verification`). |
| `/api/artifacts/:id/approve` | `POST` | Approves a Plan Trust Artifact and unlocks workspace execution mode. |
| `/api/artifacts/:id/steer` | `POST` | Delivers an inline line-anchored review comment (`{ lineStart, lineEnd, comment }`) via `addInlineCommentAndSteer()`. |
| `/api/quarantine/distill` | `POST` | Distills a candidate `SKILL.md` into `.skills-quarantine/` and runs `skills-guard-v10`. |
| `/api/quarantine/:name/promote` | `POST` | Promotes a quarantined skill with `operatorApproved: true` (mechanically hard-blocking `verdict === "dangerous"`). |
| `/api/quarantine/lifecycle` | `POST` | Runs the Hermes `14d -> stale -> 30d -> archived` curator lifecycle pass. |
| `/api/rewind` | `POST` | Executes kernel-`flock`-locked `rewindChatAndDiskToLeaf({ toLeafId })` and returns restored/deleted file receipts. |
| `/api/dream` | `POST` | Runs `DreamingMemoryConsolidator.runDreamingPass()` (`episodes_fts` $\to$ `#115104` two-pass secret scrub $\to$ `<= 300`-token `MEMORY.md` staged for next boot). |
| `/api/evolve` | `POST` | Runs a 4-gate `Harness²` `Propose–Probe–Compose` cycle or recalls domain cues/lessons. |
| `/api/slash` | `POST` | Dispatches any `/plan`, `/rewind`, `/review`, `/quarantine`, `/dream`, `/evolve`, or `/doctor` command and returns its structured markdown report. |
| `/api/new-session` | `POST` | Invokes `runtimeHost.newSession()`, cleanly closing prior handles and booting a fresh session with any newly staged `surfaces/MEMORY.md`. |

### 6.3 Multi-Ring Stress & SWE Evaluation Harness (`src/ring5/e2e-eval-harness.ts`)

`runMultiRingEvalSuite()` exercises `Rings 0–5` simultaneously in two deterministic multi-stage gauntlets:

1. **`E2E-1` — Full 6-Stage SWE Feature Delivery Pipeline:**
   - Stage 1 (`Ring 1`): Scoped `.cursor/rules/*.mdc` tail injection on `read` + WASM Merkle AST `repo_map` + `ENOENT` sibling hint.
   - Stage 2 (`Ring 2`): Read-only Plan Mode enforcement $\to$ Plan Trust Artifact creation $\to$ inline `L2-L3` `steer()` refinement $\to$ `approvePlanArtifact`.
   - Stage 3 (`Ring 2`): Parallel disjoint `git worktree` `execute` subagents across `src/auth/**` and `src/billing/**` with zero leaked worktrees (OpenCode PR `#14649`).
   - Stage 4 (`Ring 2`): Cursor BugBot `REVIEW_RULES.md` + Codex `mergeBase...HEAD` diff review + CI verification pass.
   - Stage 5 (`Ring 3`): `Dreaming` FTS5 consolidation (`<= 300` tokens, `#115104` learned-token scrub) + 4-gate `Harness²` `EXPERIENCE.md` promotion (`GUARDRAILS.yaml` SHA-256 intact).
   - Stage 6 (`Ring 4`): `runtimeHost.newSession()` reload confirming `Dreaming` `MEMORY.md` activation while maintaining `1,073 === 1,073` schema tokens and `0` mid-session prefix drift throughout Stages 1–5.
2. **`E2E-2` — Adversarial Chaos, Crash & Security Gauntlet:**
   - simultaneously verifies `bwrap` `.env` & `.git/objects` secret masking (`Ring 0`), 3-strike identical-call loop guard & Stage-1 `0`-LLM `appendContextEdit` compaction (`Ring 1`), compound-shell Plan Mode bypass block & `STALE_SNAPSHOT_REF` browser block (`Ring 2`), `skills-guard-v10` dangerous skill promotion block, `#11227` symlink refusal, & `Harness²` Issue `#94` `GUARDRAILS.yaml` tamper rejection (`Ring 3`).

### 6.4 Portable Personal Host Installer (`scripts/install-personal.sh` & `pi-apex --web`)

- `bin/pi-apex --web [--port 4310] [--host 0.0.0.0]` launches `MissionControlServer` directly from the CLI.
- `scripts/install-personal.sh` (`--prefix <dir>`, default `~/.local`, plus optional `--install-systemd-user`) compiles `linux_fs_bridge.node`, verifies `Node >= 22.19`, `bwrap`, and `git`, installs `~/.local/bin/pi-apex` symlink, and optionally writes `~/.config/systemd/user/pi-apex-cockpit.service`.

### 6.5 Ring 5 Acceptance Gate (`test/ring5/run-ring5-tests.ts`, `R5-1`–`R5-6`)

- **`R5-1`:** Mission-Control Web UI & `/api/status` preserve `1,073 === 1,073` active schema tokens, `0` live prefix drift, relative-only client URLs (zero `localhost`/`127.0.0.1` literals), and preview-safe HTTP headers.
- **`R5-2`:** Live SSE `/api/events` stream + inline line-anchored Trust Artifact `steer()` + Plan approval + `.skills-quarantine/` promotion & dangerous-skill block over HTTP.
- **`R5-3`:** Atomic HTTP `/api/rewind` restoring workspace disk + `/api/dream` + `/api/new-session` reloading `surfaces/MEMORY.md` cleanly.
- **`R5-4`:** Full `E2E-1` 6-stage SWE delivery pipeline across Rings 0–4 PASS.
- **`R5-5`:** Full `E2E-2` adversarial chaos & security gauntlet across Rings 0–3 PASS.
- **`R5-6`:** Portable personal installer (`scripts/install-personal.sh --prefix <tmpDir> --install-systemd-user`) installs a working `<tmpDir>/bin/pi-apex` symlink + valid `systemd` user unit verified via `<tmpDir>/bin/pi-apex -p "/doctor"`.

---

## 7. Ring 6 — Confined `@earendil-works/pi-mcp` Bridge, Cache-Preserving `apex/auto` Virtual Router, Mission-Control Cockpit v2 & Portable Release Bundle Specification

### 7.1 Architectural Objectives & Upstream OSS Reuse

Ring 6 upgrades Pi-Apex into a complete daily-driver personal workstation harness while strictly preserving every Ring 0–5 security and token-budget invariant:

1. **Zero-Token Deferred MCP Client Hub (`@earendil-works/pi-mcp@1.4.0` — `src/ring6/mcp-confined-hub.ts`):**
   - Directly integrates `@earendil-works/pi-mcp@1.4.0`'s `McpClient`, `StdioTransport`, `StreamableHttpTransport`, `toLlmContent`, and `InMemoryTransport` (`dist/testing`).
   - Registers a single deferred `mcp_hub` gateway tool (`exposure: "deferred"`) — plus optional per-tool deferred proxies — so connecting 1 or 50 MCP servers adds **`+0` active tool schema tokens** (`1,073 === 1,073 o200k_base` tokens; `0` live prefix SHA-256 drift) and works seamlessly inside QuickJS WASM `codemode` (`await tools.mcp_hub(...)`) and `tool_search`.
2. **4-Layer MCP Security & Confinement Fence:**
   - **Workspace Trust Gate (adapted from Pi `examples/extensions/project-trust.ts` & Ring 1 LSP gate):** Any workspace-configured stdio MCP server (`.mcp.json` / `.harness/mcp.json`) is **hard-blocked** (`UNTRUSTED_WORKSPACE_MCP_BLOCKED`) when `workspaceTrusted === false`, preventing untrusted repositories from executing arbitrary binaries on session open.
   - **Clean-Env Stdio Isolation:** `StdioTransport` always launches with `inheritEnv: false` and an explicit sanitized environment (`PATH`, `HOME`, `LANG`, `TERM`, `TMPDIR`, plus non-secret server `env` keys filtered against secret-key patterns), preventing host `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `AWS_SECRET_ACCESS_KEY` leakage into child MCP servers.
   - **Tool-Description & Instruction Poisoning Scan (`skills-guard-v10`):** On `listTools()` and `connect()`, every MCP tool `description` and server `instructions` string is scanned via `scanSkillBundle` (`skills-guard-v10`). Poisoned tools (`verdict === "dangerous"`, e.g. hidden prompt-injection / exfiltration instructions in a tool description) are quarantined from discovery and blocked from invocation (`MCP_TOOL_POISONING_BLOCKED`).
   - **Result Secret Scrubbing & Spill Protection:** Every `callTool()` and `readResource()` response converted via `toLlmContent()` passes all text blocks through `scrubSecretsInfallible()` and Ring 0's `SpillStore` ceiling (`32 KiB`), while valid base64 `image` blocks pass through cleanly.
3. **Cache-Preserving `apex/auto` Virtual Model Router & Local Ollama / Frontier Provider Profiles (`src/ring6/provider-router.ts`):**
   - Adapts `@earendil-works/pi-coding-agent@1.4.0` `examples/extensions/jev-router.ts` (`pi.registerVirtualModel<ApexRouteState>`):
     - Registers virtual model **`apex/auto`** (`Auto Plan-Strong / Implement-Fast`), which routes planning/exploration turns to a configured `planningModel` and switches **at most once per branch** to `implementationModel` after the first successful `edit` or `write` tool result in the turn (`editedThisTurn(messages)`), storing `{ phase, modelProvider, modelId }` on the Pi session branch so prompt caches stay warm!
   - Provides 1-call local **Ollama / OpenAI-compatible** endpoint registration (`registerOllamaOrOpenAiCompatProvider` via `ModelRuntime.registerProvider("ollama", { api: "openai-completions", baseUrl, apiKey, models })`) and runtime credential configuration for `anthropic`, `openai`, `google`, `openrouter`, and `ollama`.
   - Tracks cumulative session **Prompt-Cache & Token Cost Telemetry** (`inputTokens`, `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`, `cacheHitRatePct`, `totalCostUsd`) across turns.
4. **Operator Slash Commands (`/mcp` & `/router` — `+0` Active Schema Tokens):**
   - Extends the slash-command suite from 7 to **9 zero-token commands** (`/plan`, `/rewind`, `/review`, `/quarantine`, `/dream`, `/evolve`, `/doctor`, **`/mcp`**, **`/router`**) registered via `ExtensionAPI.registerCommand`.

### 7.2 Mission-Control Cockpit v2 API & UI (`src/ring5/mission-control-server.ts`, `src/ring5/mission-control-ui.ts`)

Upgrades the live Web Cockpit (`0.0.0.0:4310`, strictly relative `./api/...` URLs, zero external CDNs, zero `localhost`/`127.0.0.1` literals in client JS) with 6 new daily-driver endpoints and UI panels:

| New Endpoint | Method | Purpose |
|---|---|---|
| `/api/transcript` | `GET` | Returns normalized multi-turn session chat history (`user`, `assistant`, `toolResult`, `custom`), live streaming state, and cumulative token/cache/cost usage telemetry. |
| `/api/abort` | `POST` | Aborts an in-flight streaming LLM/tool turn (`session.abort()`). |
| `/api/diff` | `GET` | Computes live workspace `git status --short` + unified `git diff HEAD` (plus untracked file previews, secret-scrubbed and `openat2`-safe) for the interactive Diff Viewer tab. |
| `/api/sessions` | `GET` / `POST` | `GET` lists all saved `.harness/sessions/*.jsonl` transcripts via `SessionManager.list()`; `POST` switches active session via `runtimeHost.switchSession(sessionPath)` and rebinds SSE cleanly. |
| `/api/models` | `GET` / `POST` | `GET` lists configured/available models (including `apex/auto` and local `ollama/*`), active model, and cache/cost telemetry; `POST` sets runtime API keys, registers local Ollama/OpenAI-compat endpoints, or switches the active session model (`session.setModel`). |
| `/api/mcp` | `GET` / `POST` | `GET` lists connected/configured MCP servers, discovered tools, and `skills-guard-v10` poisoning scan status; `POST` connects a stdio/HTTP MCP server, disconnects, lists resources, or invokes a safe MCP tool. |

### 7.3 Portable Personal Release Bundle (`scripts/package-release.sh` & `PERSONAL_QUICKSTART.md`)

- `scripts/package-release.sh` builds a deterministic, clean source release archive at **`/home/user/pi-apex-v3.6.0-personal.tar.gz`** (plus SHA-256 checksum manifest `/home/user/pi-apex-v3.6.0-personal.tar.gz.sha256`), packaging `src/`, `bin/`, `scripts/`, `surfaces/`, `surfaces-immutable/`, `test/`, `package.json`, `package-lock.json`, `tsconfig.json`, `SPEC_BIBLE.md`, `ARCHITECTURE.md`, and `PERSONAL_QUICKSTART.md` while excluding `.git`, `node_modules`, `.harness`, and ephemeral artifacts.

### 7.4 Ring 6 Acceptance Gate (`test/ring6/run-ring6-tests.ts`, `R6-1`–`R6-6`)

- **`R6-1` (Zero Schema Bloat + Real `@earendil-works/pi-mcp` Stdio & In-Memory Execution):** Connects both an `InMemoryTransport` MCP server and a real child-process `StdioTransport` MCP server (`fixtures/stdio-mcp-server.ts`); verifies `1,073 === 1,073 o200k_base` active schema tokens (`+0` bloat), `0` prefix drift, `tool_search` + QuickJS WASM `codemode` execution (`tools.mcp_hub`), `toLlmContent()` text+image conversion, and `inheritEnv: false` host-secret non-leakage.
- **`R6-2` (4-Layer MCP Security Fence):** Verifies (1) untrusted workspace stdio `.mcp.json` spawn is hard-blocked (`UNTRUSTED_WORKSPACE_MCP_BLOCKED`), (2) poisoned MCP tool descriptions containing prompt-injection/exfiltration payloads are flagged by `skills-guard-v10` and blocked (`MCP_TOOL_POISONING_BLOCKED`), and (3) secret tokens returned inside MCP tool/resource payloads are redacted by `scrubSecretsInfallible()`.
- **`R6-3` (`apex/auto` Cache-Preserving Virtual Model Router + Ollama Registration + Usage Telemetry):** Verifies `apex/auto` plans on the strong planning model until the first successful `edit`/`write` tool result, switches once to the fast implementation model (adapted from Pi `jev-router.ts`), registers a local `ollama` OpenAI-compatible provider on `ModelRuntime`, and computes exact cache-hit % & cost telemetry.
- **`R6-4` (`/mcp` & `/router` Slash Commands):** Verifies all 9 operator slash commands execute cleanly with `+0` schema tokens and `0` prefix drift.
- **`R6-5` (Mission-Control Cockpit v2 Live Chat, Diff Viewer, Multi-Session Switcher, Model/Ollama & MCP APIs):** Verifies `/api/transcript`, `/api/diff`, `/api/sessions` (`SessionManager.list` + `switchSession`), `/api/models` (Ollama + model switch), and `/api/mcp` over live HTTP/SSE with zero `localhost`/`127.0.0.1` client literals and zero `X-Frame-Options` blocks.
- **`R6-6` (Portable Release Archive Verification):** Runs `scripts/package-release.sh`, verifies `/home/user/pi-apex-v3.6.0-personal.tar.gz` + SHA-256 manifest, extracts into a clean temp directory, links `node_modules`, builds native C broker, and passes `bin/pi-apex --version` (`3.6.0`) and `bin/pi-apex -p "/doctor"` (`ALL HEALTHY`).

---

## 8. Ring 7 — Capstone Autonomous Orchestration: Issue-to-PR Pipeline, Session Handoff/Presets/Bookmarks, Real Headless Chromium CDP Driver, Multi-Workspace Cockpit v3 & `v3.7.0` Bundle Specification

### 8.1 Architectural Objectives & Upstream Open-Source Reuse

Ring 7 completes the autonomous engineering loop across live web SPAs, multi-PR context handoffs, and isolated branch-to-PR delivery while maintaining every Ring 0–6 confinement and token-budget invariant (`1,073 === 1,073 o200k_base` active schema tokens across **14 deferred specialist tools** and **13 zero-token slash commands**, plus **`0` mid-session static prefix drift**):

1. **Zero-Dependency Native Node 22 WebSocket Chromium CDP Driver (`src/ring7/chromium-cdp-driver.ts` + `src/ring2/agent-browser-ref.ts`):**
   - **Upstream OSS Reuse:** Extends our `vercel-labs/agent-browser @ 372ac5ce20fa` (`cli/src/native/snapshot.rs` & `eve/lib/browser.ts`, Apache-2.0) `@e1` ARIA snapshotter (`RawAXNode`, `buildAriaTree`, `formatAriaSnapshotFromNodes`, `RoleNameTracker`, Issue `#1443` `STALE_SNAPSHOT_REF`, Issue `#2147` `StaticText` compact retention) with a real headless Chromium DevTools Protocol (CDP) backend over Node 22's built-in `WebSocket`.
   - **Clean-Env Chromium Isolation & SSRF Fence:** Spawns local `chromium` / `chromium-browser` / `google-chrome` (`--headless=new --no-sandbox --disable-gpu --disable-dev-shm-usage --remote-debugging-port=0`) with `inheritEnv: false` and a minimal sanitized env (`PATH`, `HOME`, `TMPDIR`, `LANG`) so host `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `AWS_SECRET_ACCESS_KEY` never enter the Chromium child environment; blocks `file://` URLs outside `<workspaceRoot>` and link-local cloud metadata (`169.254.169.254`) SSRF targets.
   - **Live V8 `MutationObserver` Stale-Ref Guard (`Issue #1443`):** Installs `window.__apexDomRevision` via `Page.addScriptToEvaluateOnNewDocument` (`MutationObserver` tracking `childList`, `attributes`, and `characterData`). Every `Accessibility.getFullAXTree` `@eN` snapshot records the live V8 `domRevision`; before `click(@eN)`, `fill(@eN, text)`, or `getText(@eN)` executes via `DOM.resolveNode({ backendNodeId })` + `Runtime.callFunctionOn`, it verifies `liveDomRevision === snapshotDomRevision` and fails closed (`STALE_SNAPSHOT_REF`) if asynchronous JS mutated the page after the snapshot!
   - **Real Multimodal PNG Screenshots:** `Page.captureScreenshot({ format: "png" })` returns real Chromium-rendered PNG bytes (`ImageContent` `{ type: "image", mimeType: "image/png", data }`), while retaining automatic offline fallback to the deterministic virtual DOM when Chromium is disabled or unavailable.

2. **Focused Context Handoff, Zero-Drift Named Presets & Entry Bookmarks (`src/ring7/handoff-presets-bookmarks.ts`):**
   - **Upstream OSS Reuse:** Directly adapts `@earendil-works/pi-coding-agent@1.4.0` `examples/extensions/handoff.ts` (`SYSTEM_PROMPT`, `entryToMessage`, `getHandoffMessages`, `convertToLlm`, `serializeConversation`, `parentSession` tracking), `examples/extensions/preset.ts` (`Preset`, `PresetsConfig`, `loadPresets`, `buildPresetDescription`, `preset-state`), and `examples/extensions/bookmark.ts` (`setLabel`, `/bookmark`, `/unbookmark`).
   - **Multi-Mode Secret-Scrubbed `/handoff <goal>` (`HandoffController`):** Unlike upstream `handoff.ts` (which rejects non-TUI invocations with `"handoff requires interactive mode"`), `HandoffController` operates across TUI, `-p` Print, JSON, RPC, and Web Cockpit modes. It extracts compaction-aware branch messages via `getHandoffMessages`, passes `serializeConversation` through `scrubSecretsInfallible()`, synthesizes a self-contained `## Context` + `Files involved` + `## Task` Handoff Brief (using `ModelRuntime` completion when configured or deterministic branch/tool extraction offline), and creates a clean child session via `runtimeHost.newSession({ parentSession })` preserving verifiable `.jsonl` `parentSession` lineage!
   - **Cache-Preserving Zero-Prefix-Drift `/preset` (`PresetController`):** Upstream `preset.ts` mutates `event.systemPrompt` inside `before_agent_start`, which breaks prompt caching mid-session and violates Invariant `I-01` (`0` mid-session prefix drift). `PresetController` loads global (`<agentDir>/presets.json`), project (`<cwd>/.pi/presets.json`), and built-in presets (`plan`, `implement`, `review`, `fast-local`), applies model/thinking-level/core-tool subsets (`<= 1,073` schema tokens), and injects preset `instructions` strictly at the **turn message tail (`<preset_guidance>`)** rather than mutating `session.systemPrompt` — guaranteeing **`0` live static-prefix SHA-256 drift**!
   - **Turn Bookmarking (`/bookmark [label]`, `/unbookmark`):** Labels session entries via `SessionManager.appendLabelChange` / `pi.setLabel` so operators can bookmark milestones and inspect or `/tree`-rewind directly to bookmarked checkpoints from TUI or Cockpit v3.

3. **Autonomous 6-Stage Issue-to-PR Pipeline (`src/ring7/autonomous-pr-pipeline.ts` + deferred `pr_pipeline` tool + `/pr`):**
   - Orchestrates an end-to-end engineering task from issue spec to review-verified Git branch & PR bundle:
     1. **Stage 1 (`Branch Isolation`):** Validates clean/committable Git state, records `baseBranch` & `baseSha`, and creates/checks out dedicated branch `apex/<slug>` (refusing invalid refs or secret files).
     2. **Stage 2 (`Plan Trust Artifact`):** Records & approves a structured `plan` Trust Artifact documenting scope, disjoint `ownedPaths`, and verification criteria.
     3. **Stage 3 (`Disjoint Worktree Execution`):** Executes parallel/scoped task patches across `WorktreeSubagentPool` (`execute` role with OpenCode PR `#14649` guaranteed worktree cleanup) or deterministic patch tasks under `openat2` `writeFileDurable()`.
     4. **Stage 4 (`Codex Three-Dot Branch Diff Review + BugBot Rules`):** Commits staged work onto `apex/<slug>` (blocking `.env`/`.pem`/`.key` basenames) and runs `BugBotAndCiEngine.reviewChanges({ type: "baseBranch", branch: baseBranch })` (`git diff <mergeBase>...HEAD`, Codex Issues `#8404/#17160` fix). Blocks promotion (`status: "blocked_by_review"`) on high-priority P0/P1 findings!
     5. **Stage 5 (`Sandboxed bwrap CI Verification`):** Runs `BugBotAndCiEngine.runCiVerificationLoop` (`testCommand`) inside Ring 0's `bwrap` sandbox and records a `verification` Trust Artifact.
     6. **Stage 6 (`PR Bundle & SQLite Audit Receipt`):** Writes secret-scrubbed PR summary `.harness/prs/<prId>.md`, records a `diff` Trust Artifact, persists a durable row in `autonomous_prs` (`StateDb`), and optionally restores checkout or stays on `apex/<slug>` ready for merge / `gh pr create`.

### 8.2 Mission-Control Cockpit v3 API & Multi-Workspace Switcher (`src/ring5/mission-control-server.ts`, `src/ring5/mission-control-ui.ts`)

Extends Cockpit v2 (`0.0.0.0:4310`, strictly relative `./api/...` URLs, zero external CDNs, zero `localhost`/`127.0.0.1` literals in client HTML/JS) with **Tab 7 (`PR Pipeline, Handoff, Browser CDP & Workspaces`)** and 5 new operator endpoints:

| New Endpoint | Method | Purpose |
|---|---|---|
| `/api/pr-pipeline` | `GET` / `POST` | `GET` lists autonomous Issue-to-PR runs & PR markdown artifacts; `POST` executes a 6-stage `AutonomousPrPipeline` run (`apex/<slug>` branch, Plan, worktree tasks, BugBot diff review, `bwrap` CI, PR bundle). |
| `/api/handoff` | `POST` | Extracts secret-scrubbed context from the active session for `<goal>` and optionally spawns/switches to a clean `parentSession`-linked child `.jsonl` session. |
| `/api/presets` | `GET` / `POST` | `GET` lists available & active presets + bookmarks; `POST` activates/clears a named preset (`0` static-prefix drift) or creates/removes a turn bookmark. |
| `/api/browser` | `GET` / `POST` | Drives `AgentBrowserController` in live Headless Chromium CDP (`mode: "cdp"`) or deterministic virtual mode (`navigate`, `snapshot`, `click`, `fill`, `screenshot`) and returns `@e1` ARIA trees + live PNG base64 previews. |
| `/api/workspaces` | `GET` / `POST` | `GET` lists registered local Git workspaces + active workspace root; `POST` registers or switches `Ring4RuntimeController` to another local Git repo (`runtimeHost.newSession` with `cwd` override) cleanly disposing prior handles! |

### 8.3 Ring 7 Acceptance Gate (`test/ring7/run-ring7-tests.ts`, `R7-1`–`R7-6`)

- **`R7-1` (Real Headless Chromium 156 CDP `@e1` ARIA Snapshotter, Live JS Execution, Async `MutationObserver` `STALE_SNAPSHOT_REF` `#1443` & Real PNG Screenshot):** Spawns real headless `chromium` via `ChromiumCdpSession` (`inheritEnv: false` clean env + SSRF block), navigates to a live JS interactive SPA, captures `Accessibility.getFullAXTree` `@e1`–`@eN` refs, fills an input & clicks a button executing real V8 JS DOM updates, proves async JS DOM mutation triggers `STALE_SNAPSHOT_REF` until re-snapshotted, captures a real Chromium PNG `ImageContent` screenshot, and tears down cleanly with `0` orphan Chromium processes.
- **`R7-2` (`HandoffController`, Zero-Prefix-Drift `PresetController` & `BookmarkController`):** Verifies secret-scrubbed `/handoff <goal>` (`getHandoffMessages` + `parentSession` `.jsonl` header lineage), verifies `/preset` (`plan`, `implement`, custom `.pi/presets.json`) applies model/thinking/tail-guidance while keeping `session.systemPrompt` SHA-256 **100% identical (`0` drift)** and active schema tokens `<= 1,073`, and verifies `/bookmark` + `/unbookmark` entry labeling.
- **`R7-3` (6-Stage Autonomous Issue-to-PR Pipeline + BugBot Gate + QuickJS WASM `codemode`):** Runs `AutonomousPrPipeline` end-to-end on a multi-module Git repo (`apex/<slug>` branch $\to$ Plan Trust Artifact $\to$ parallel disjoint `git worktree` tasks $\to$ Codex `mergeBase...HEAD` BugBot review $\to$ `bwrap` CI pass $\to$ `.harness/prs/<prId>.md` + conventional commit, `0` leaked worktrees), AND verifies a second run introducing a `REVIEW_RULES.md` P0 violation fails closed (`blocked_by_review`). Also verifies deferred `pr_pipeline` keeps `1,073 === 1,073` schema tokens!
- **`R7-4` (All 13 Zero-Token Operator Slash Commands):** Executes `/pr`, `/handoff`, `/preset`, and `/bookmark` alongside `/doctor` (`13` total slash commands) with `+0` active schema tokens and `0` live prefix drift.
- **`R7-5` (Mission-Control Cockpit v3 Live HTTP/SSE Verification):** Verifies `/api/pr-pipeline`, `/api/handoff`, `/api/presets`, `/api/browser` (live Chromium CDP snapshot + PNG screenshot over HTTP!), and `/api/workspaces` (live multi-repo workspace switch!) with zero `localhost`/`127.0.0.1` client literals.
- **`R7-6` (Portable `pi-apex-v3.7.0-personal.tar.gz` Release Bundle Verification):** Builds `/home/user/pi-apex-v3.7.0-personal.tar.gz` + `.sha256`, extracts into a clean temp dir, compiles `linux_fs_bridge.node`, and passes `bin/pi-apex --version` (`3.7.0`) and `bin/pi-apex -p "/doctor"` (`ALL HEALTHY`, `schema=1073`).

---

## 9. Ring 8 — Live-LLM Self-Healing `/pr` & GitHub Quarantine Bridge, VS Code / Cursor RPC Extension, & Personal SWE Eval / Prompt-Cache Benchmark Suite (`v3.8.0` — Implemented & Verified)

### 9.1 Architectural Objectives & Upstream Open-Source Reuse

Ring 8 elevates `pi-apex` into a complete daily-driver autonomous GitHub + IDE + benchmarked engineering system while strictly preserving every Ring 0–7 invariant (**`1,073 === 1,073 o200k_base` active schema tokens** across **15 deferred specialist tools** and **15 zero-token slash commands**, plus **`0` mid-session static prefix SHA-256 drift**):

1. **Quarantine-Scanned GitHub Issue Bridge & Live-LLM Self-Healing `/pr` (`src/ring8/github-issue-bridge.ts` + `src/ring7/autonomous-pr-pipeline.ts`):**
   - **Upstream OSS Reuse:**
     - Directly ports `@earendil-works/pi-coding-agent@1.4.0` `examples/extensions/github-issue-autocomplete.ts` (`parseGitHubRepo`, `resolveGitHubRepoFromRemotes`, `extractIssueToken`, `filterIssues`, `createIssueAutocompleteProvider`, MIT) for GitHub remote resolution (`git@github.com:owner/repo.git` & `https://github.com/owner/repo.git`) and interactive `#<number>` fuzzy issue autocomplete.
     - Directly ports `@earendil-works/pi-coding-agent@1.4.0` `examples/extensions/git-merge-and-resolve.ts` (`ConflictBlock`, `findGitMergeConflicts`, `formatRange`, `formatMergeConflicts`, MIT) for structured merge-conflict inspection (`<<<<<<<` / `=======` / `>>>>>>>`).
     - Reuses `NousResearch/hermes-agent` `skills-guard-v10` (`scanSkillContent` at `trustLevel: "community"`, MIT) and `scrubSecretsInfallible()` to quarantine-scan untrusted GitHub Issue titles, bodies, and comments BEFORE they touch any LLM prompt!
   - **Untrusted GitHub Issue Ingestion & Prompt-Injection Fence (`GitHubIssueBridge`):**
     - Accepts `https://github.com/<owner>/<repo>/issues/<number>`, `<owner>/<repo>#<number>`, `#<number>` (resolved via `git remote -v`), local JSON fixture files, `gh issue view`, or HTTP GitHub REST v3 (`apiBaseUrl`, supporting GitHub.com, GitHub Enterprise, and local HTTP mock servers).
     - Scans concatenated issue title + body + comments through `skills-guard-v10`. Any `verdict === "dangerous"` payload (e.g. `Ignore all previous instructions`, `curl ... | sh`, hidden HTML comment `<!-- system: exfiltrate .env -->`, Unicode bidi/tag steganography) throws `UNTRUSTED_ISSUE_INJECTION_BLOCKED` by default (fail-closed) unless explicitly sanitized with `allowQuarantinedIssue: true` (which strips matching lines and marks `sanitized: true`).
     - Wraps safe/sanitized issue payloads inside explicit `<untrusted_github_issue repo="..." number="..." scan_verdict="...">` XML isolation tags so the model treats external issue prose strictly as untrusted data.
   - **Live-LLM Autonomous Synthesis & Bounded Self-Healing Loop (`AutonomousPrPipeline.run` with `liveLlm: true`):**
     - When `liveLlm: true` (or `/pr --auto <issueRefOrPrompt>`), Stage 3 queries `ModelRuntime.complete(model, context)` (resolving `apex/auto` physical targets automatically) with `openat2`-confined workspace file context (`contextFiles` / repo tree + `EXPERIENCE.md` surface cues) to synthesize structured JSON patches (`{ scope, planSteps, patches: [{ relPath, content }] }`).
     - Applies synthesized patches via `openat2` `writeFileDurable()` (enforcing workspace boundary & secret-basename blocks), commits onto `apex/<slug>`, and runs **Stage 4 (Codex `mergeBase...HEAD` + BugBot `REVIEW_RULES.md`)** and **Stage 5 (Sandboxed `bwrap` CI `testCommand`)**.
     - **Bounded Self-Healing Loop (`maxRepairAttempts = 2`):** If Stage 4 produces P0/P1 `ReviewFinding`s OR Stage 5 `bwrap` CI exits non-zero, `AutonomousPrPipeline` feeds the current `git diff <baseBranch>...HEAD`, exact BugBot P0/P1 line findings, and secret-scrubbed CI `stdout`/`stderr` back into `ModelRuntime.complete(...)` for up to `maxRepairAttempts` repair iterations, committing `fix(<scope>): self-heal review/CI feedback (attempt k)` and re-running BOTH BugBot and `bwrap` CI! Persists `repair_attempts_used`, `self_healed`, and `llm_usage_json` (`inputTokens`, `outputTokens`, `cacheReadTokens`, `costUsd`) in SQLite `autonomous_prs` and `.harness/prs/<prId>.md`.

2. **Installable VS Code / Cursor Extension over `--mode rpc` (`src/ring8/vscode-rpc-bridge.ts` + `extensions/vscode-pi-apex/`):**
   - **Upstream OSS Reuse:** Directly adapts `@earendil-works/pi-coding-agent@1.4.0` `dist/modes/rpc/rpc-client.js` & `examples/rpc-extension-ui.ts` (`ExtensionUIRequest`, `extension_ui_response` NDJSON stdio protocol for `select`, `confirm`, `input`, `editor`, `notify`, `setStatus`, `setWidget`, `set_editor_text`, plus `get_state`, `get_commands`, `prompt`, `steer`, `abort`, `new_session`, MIT).
   - **Zero-Drift Editor Context Envelope (`formatEditorSelectionEnvelope`):** Formats active IDE tab path (relativized inside `<workspaceRoot>` and checked against `isSecretBasename` so `.env` selections are redacted automatically!), 1-indexed line/column selection range, selected snippet, and IDE LSP `Diagnostic[]` (`error`/`warning`, line, message, source) into an append-only `<ide_active_editor>` user-message block — adding **`0` static prefix drift**!
   - **`IdeRpcBridge` (`src/ring8/vscode-rpc-bridge.ts`):** Headless, deterministic Node/VS Code bridge spawning `bin/pi-apex --mode rpc`, routing `extension_ui_request` dialogs to pluggable IDE UI callbacks (`onSelect`, `onConfirm`, `onInput`, `onEditor`, `onNotify`, `onStatusChange`), streaming real-time `text_delta` chunks, and exposing high-level IDE actions (`askWithEditorContext`, `togglePlanMode`, `runBugBotReview`, `handoffFromSelection`, `runAutonomousPr`, `getWorkspaceState`).
   - **Packaged Extension (`extensions/vscode-pi-apex/`):** Complete VS Code / Cursor extension manifest (`package.json` with commands `piApex.askSelection`, `piApex.togglePlan`, `piApex.reviewDiff`, `piApex.handoff`, `piApex.autonomousPr`, `piApex.openCockpit`, keybindings, status bar item, and Webview Cockpit panel + `src/extension.ts`) installable via `scripts/install-personal.sh --install-vscode`.

3. **Personal SWE Eval & Prompt-Cache Benchmark Suite (`src/ring8/swe-eval-bench.ts` + `src/cli/bench-cli.ts` + `npm run bench` + `/bench`):**
   - **Upstream OSS Reuse:** Combines `deepseek-ai/deepseek-harness` (`master @ 22ddee379240`, MIT) multi-task Git bugfix evaluation metrics with `google-research/harness2` (`main @ 1cfe254e8d25`, Apache-2.0, `proposer.py` / `selection.py`) before/after `EXPERIENCE.md` A/B benchmarking.
   - **Built-In 3-Repo SWE Bugfix Corpus + Custom JSON Suites:**
     1. `swe-01-jwt-expiry-boundary`: Fixes off-by-one boundary bug in `src/auth/jwt.ts` verified under real `bwrap` Node test runner.
     2. `swe-02-sanitizer-bugbot-heal`: Fixes `src/sanitize/expr.ts` where an initial `eval()` patch triggers a P0 BugBot `REVIEW_RULES.md` violation and autonomously self-heals on repair attempt #1.
     3. `swe-03-cursor-paginator-ci-heal`: Fixes `src/db/paginate.ts` where an incomplete initial edge-case patch fails `bwrap` CI (`AssertionError`) and autonomously self-heals from CI stderr on repair attempt #1.
   - **Metrics & Harness² A/B Delta (`SweBenchmarkReport`):**
     - Computes `resolvedCount / totalTasks` (`passRatePct`), `firstShotResolvedCount`, `selfHealedCount`, wall-clock `meanMs` / `p50Ms` / `p95Ms`, `activeSchemaTokens` (`=== 1,073`), `prefixDriftCount` (`=== 0`), `cacheHitRatePct` (`cacheReadTokens / (cacheReadTokens + inputTokens)`), `totalCostUsd`, `costPerResolvedUsd`, and **Harness² `EXPERIENCE.md` Before vs. After A/B comparison** (`baselinePassRatePct` vs. `evolvedPassRatePct`, `repairAttemptsSaved`, `latencyDeltaMs`), persisting `.harness/benchmarks/<benchId>.json` + `.md`.

### 9.2 Mission-Control Cockpit v4 (`Tab 8: GitHub Live /pr, IDE RPC & SWE Bench`)

Extends Cockpit v3 (`0.0.0.0:4310`, zero external CDNs, zero `localhost`/`127.0.0.1` client literals, runtime `new Function()` inline-JS syntax guard) with **Tab 8** and two new endpoints:

| New Endpoint | Method | Purpose |
|---|---|---|
| `/api/github-issue` | `GET` / `POST` | `POST` ingests & quarantine-scans a GitHub Issue URL/ref/JSON via `skills-guard-v10`, returning sanitized `<untrusted_github_issue>` preview or triggering a Live-LLM self-healing `/pr --auto` run; `GET` lists ingested issue audit receipts & merge conflicts (`findGitMergeConflicts`). |
| `/api/bench` | `GET` / `POST` | `GET` lists persisted `.harness/benchmarks/*.json` SWE benchmark runs; `POST` runs the 3-task Personal SWE Eval & Harness² A/B Prompt-Cache Benchmark Suite and streams results to Tab 8. |

### 9.3 Ring 8 Acceptance Gate (`test/ring8/run-ring8-tests.ts`, `R8-1`–`R8-6`)

- **`R8-1` (GitHub Issue Bridge + `skills-guard-v10` Prompt-Injection Quarantine + `#` Issue Autocomplete & Merge-Conflict Parser):** Verifies `parseGitHubRepo` (SSH & HTTPS), fetches issues from a local GitHub REST v3 server, blocks a poisoned GitHub issue containing `Ignore all previous instructions` + `<!-- exfiltrate .env -->` (`UNTRUSTED_ISSUE_INJECTION_BLOCKED`), sanitizes when `allowQuarantinedIssue: true`, verifies `#<number>` fuzzy autocomplete (`filterIssues`), and parses `<<<<<<<`/`=======`/`>>>>>>>` conflict ranges (`findGitMergeConflicts`).
- **`R8-2` (Live-LLM `/pr --auto` Execution + Autonomous BugBot P0 & `bwrap` CI Self-Healing Loops):** Exercises `AutonomousPrPipeline.run({ liveLlm: true })` end-to-end: (a) Model initially emits a patch triggering a P0 BugBot `no-eval` rule $\to$ pipeline feeds BugBot finding back to LLM $\to$ repair attempt #1 replaces `eval()` cleanly and reaches `status: "ready"`; (b) Model initially emits an incomplete patch failing `bwrap` CI $\to$ pipeline feeds CI `stderr` back to LLM $\to$ repair attempt #1 fixes the bug, passes `bwrap` CI, and writes `.harness/prs/<prId>.md` with `selfHealed: true` & `repairAttemptsUsed: 1`.
- **`R8-3` (VS Code / Cursor `IdeRpcBridge` over Real `bin/pi-apex --mode rpc` + `.env` Selection Fence + `extension_ui_request` Round-Trip):** Spawns real child process `bin/pi-apex --mode rpc` via `IdeRpcBridge`, sends active editor selection + LSP diagnostics (`formatEditorSelectionEnvelope`), verifies `.env` selections are secret-redacted, handles live `extension_ui_request` (`select`/`confirm`/`notify`/`setStatus`) callbacks, toggles `/plan`, runs `/review`, and verifies `extensions/vscode-pi-apex/package.json` manifest & TypeScript compilation with **`0` prefix drift**.
- **`R8-4` (Personal SWE Eval & Prompt-Cache Benchmark Suite + Harness² `EXPERIENCE.md` Before/After A/B Delta + `npm run bench`):** Runs `runPersonalSweBenchmarkSuite` across all 3 multi-repo Git bugfix tasks (`bwrap` CI + BugBot + `apex/auto` cache telemetry) in both `baseline` and `evolved` (`EXPERIENCE.md`) modes, verifying `100%` evolved pass rate, measurable repair-turn reduction (`repairAttemptsSaved >= 1`), `activeSchemaTokens === 1,073`, `prefixDriftCount === 0`, non-zero `cacheHitRatePct`, and persisted `.harness/benchmarks/<benchId>.json` + CLI `npm run bench`.
- **`R8-5` (All 15 Deferred Tools + 15 Zero-Token Slash Commands + Mission-Control Cockpit v4 Tab 8 Live Chromium E2E):** Verifies `/issue` & `/bench` slash commands + deferred `github_issue` tool keep **`1,073 === 1,073 o200k_base` active schema tokens**, tests `/api/github-issue` & `/api/bench` over HTTP, and opens Cockpit v4 in **real Headless Chromium 156** verifying `#workspaceLabel` hydrates and all **8 tabs** (`tab-chat`..`tab-ring8`) switch cleanly!
- **`R8-6` (Portable `pi-apex-v3.8.0-personal.tar.gz` + VS Code Extension Installer Verification):** Builds `/home/user/pi-apex-v3.8.0-personal.tar.gz` + `.sha256`, extracts cleanly, builds `linux_fs_bridge.node`, verifies `extensions/vscode-pi-apex` is bundled, and passes `bin/pi-apex --version` (`3.8.0`) and `bin/pi-apex -p "/doctor"` (`ALL HEALTHY`, `schema=1073`).

---

## 10. Ring 9 — Omni-Channel Messaging Gateway, Multi-Agent DAG/Swarm Orchestrator, Quarantine-Scanned External Plugin Host, & Hash-Chained Unified Self-Learning Ledger (`v3.9.0`)

### 10.1 Architectural Objectives & Upstream Open-Source Reuse

Ring 9 turns `pi-apex` into a persistent, omni-channel, multi-agent, plugin-extensible, self-improving personal workstation harness while strictly preserving **100% of Ring 0–8 invariants**:
- **Active Tool Schema Locked at `1,073 === 1,073 o200k_base` Tokens:** All 4 new Ring 9 specialist tools (`gateway_dispatch`, `swarm_orchestrate`, `plugin_manager`, `learning_ledger`) AND any dynamically loaded third-party plugin tools (`plugin_<pluginId>_<toolName>`) register exclusively in the deferred `CodemodeCatalog` (`19` built-in deferred tools + $N$ plugin tools, invoked via QuickJS WASM `codemode`).
- **Zero Mid-Session Static Prefix Drift (`0` SHA-256 Drift):** All 6 new operator slash commands (`/gateway`, `/send`, `/agents`, `/swarm`, `/plugin`, `/ledger` $\to$ `21` total slash commands), inbound messaging channel context (`<channel_context>`), custom agent blackboard context (`<blackboard_context>`), and Self-Learning Ledger updates operate without mutating `session.systemPrompt` or `session.agent.state.tools` mid-session; materialized surface updates (`surfaces/EXPERIENCE.md`, `.agents/REVIEW_RULES.md`, `surfaces/MEMORY.md`) take effect on `/new` or next boot.

---

### 10.2 Pillar 1 — Omni-Channel Messaging Gateway (`src/ring9/messaging-gateway.ts`)

1. **Upstream Open-Source Provenance:**
   - Directly adapts **`NousResearch/hermes-agent`** (`gateway/` multi-platform router, `hermes whatsapp` personal Baileys multi-device QR/pairing-code bridge, `hermes whatsapp-cloud` Meta Business Cloud API adapter, `hermes slack` Socket Mode + native slash-command manifest generator, `hermes send` zero-LLM outbound notification CLI, DM sender allowlists & pairing codes, MIT) and **`openclaw/openclaw`** (`src/channels/` normalized `InboundEnvelope` / `OutboundDelivery` & channel session routing, MIT).

2. **Six Built-In Platform Adapters + Plugin-Extensible Custom Channels (`GatewayPlatform`):**
   - **`whatsapp_baileys` (Personal-Account Multi-Device QR & 8-Char Pairing Bridge):** Manages `0700`-mode `.harness/whatsapp-auth/` credential state, generates terminal/Cockpit QR & phone-number pairing codes (`requestWhatsAppPairing`), and connects to a pluggable Baileys/WebSocket frame stream so personal accounts work immediately without requiring a Meta Business verification or public webhook.
   - **`whatsapp_cloud` (Official Meta WhatsApp Business Cloud API v21.0):** Handles `GET` `hub.mode=subscribe` + `hub.verify_token` challenge verification, `POST` `X-Hub-Signature-256` (`sha256=<hmac>`) payload authentication against `appSecret`, inbound `entry[].changes[].value.messages[]` extraction, and outbound REST `POST /{phoneNumberId}/messages`.
   - **`telegram` (Telegram Bot API):** Supports `X-Telegram-Bot-Api-Secret-Token` webhook verification + `getUpdates` long-polling cursor, inline approval `callback_query` (`approve:<id>` / `deny:<id>`), and `sendMessage` / `answerCallbackQuery`.
   - **`discord` (Discord Gateway v10 & Interactions/Webhook):** Dispatches inbound DM and `@mention` guild channel messages and sends chunked `2,000`-char replies via `/channels/{channelId}/messages`.
   - **`slack` (Slack Socket Mode & Events API + App Manifest Generator):** Verifies `X-Slack-Request-Timestamp` (replay window $\le 300\text{s}$) + `X-Slack-Signature` (`v0=<hmac>`), posts threaded replies via `chat.postMessage`, and includes `generateSlackAppManifest(slashCommands)` (ported from `hermes slack`) exporting all 21 Pi-Apex slash commands as native Slack slash commands.
   - **`signal` (`signal-cli` JSON-RPC 2.0 Adapter):** Speaks JSON-RPC 2.0 (`send`, `receive` envelope notifications) to a local `signal-cli` HTTP/Unix-socket/stdio daemon with strict E.164/UUID sender matching.

3. **Personal Workstation Security Fence (Mandatory):**
   - **Fail-Closed Sender Pairing & Allowlist (`GATEWAY_SENDER_NOT_PAIRED`):** By default, **zero unknown senders can reach the LLM or workspace**. An unpaired DM sender is rejected before prompt construction unless they present a valid one-time cryptographic pairing token (`/pair <CODE>`, 10-minute TTL, issued locally by the operator via `/gateway pair <platform>` or Cockpit Tab 9) or are pre-listed in `allowedSenders`. Group/guild channels additionally require `allowlistedChannelIds` AND explicit `@bot` mention.
   - **`skills-guard-v10` Inbound Prompt-Injection Gate:** Every inbound message text/caption is secret-scrubbed and scanned via `scanSkillContent(..., "community")`; `verdict === "dangerous"` payloads are blocked (`UNTRUSTED_CHANNEL_INJECTION_BLOCKED`) and audited in SQLite `gateway_messages`.
   - **Interactive Remote Approval Cards (`apr_<id>`):** Sensitive remote requests (e.g. `/pr --auto` or destructive edits from mobile chat) can require explicit `/approve apr_<id>` / `/deny apr_<id>` confirmation from an allowlisted operator device.

---

### 10.3 Pillar 2 — Multi-Agent Persona Registry & DAG/Swarm Orchestrator (`src/ring9/multi-agent-orchestrator.ts`)

1. **Upstream Open-Source Provenance:**
   - Extends `src/ring2/worktree-subagent-pool.ts` (`@earendil-works/pi-coding-agent@1.4.0` `examples/extensions/subagent/{index,agents}.ts` + `anomalyco/opencode` `worktree.ts` PR `#14649`, MIT) with **`google-research/harness2`** Proposer/Judge multi-candidate tournament selection (`selection.py`, Apache-2.0) and a typed shared blackboard.

2. **Quarantine-Scanned Custom Agent Personas (`.agents/agents/<name>.md`):**
   - Discovers and manages Markdown+YAML persona files in `.agents/agents/` (`name`, `description`, `role ∈ {'explore','plan','execute','verify','review'}`, `preferredModel`, `thinkingLevel`, `tools`, `defaultOwnedPaths`, and body `systemPrompt`), seeded alongside 5 built-in specialist personas (`architect`, `backend-engineer`, `frontend-engineer`, `security-auditor`, `qa-verifier`).
   - Every `.agents/agents/*.md` file is scanned via `skills-guard-v10` on load and creation (`AGENT_PERSONA_POISONED` block) so cloning an untrusted repository cannot smuggle prompt injections through custom subagent definitions.

3. **Shared Typed Blackboard (`AgentBlackboard`) & Four Orchestration Topologies (`MultiAgentOrchestrator`):**
   - **`dag` (Topological Wave Execution over Disjoint `git worktree`s):** Validates graph acyclicity (`Kahn's algorithm` $\to$ `DAG_CYCLE_DETECTED` on cycles), partitions nodes into topological execution waves, enforces `assertDisjointOwnedPaths` across every concurrent `execute` wave, injects upstream `{dep:<nodeId>}` outputs and `<blackboard_context>` facts, executes workers in isolated Git worktrees (`0` leaked worktrees guaranteed in `finally`), checks `findConflictsInText`, and harvests owned-path mutations atomically via `openat2` `writeFileDurable()`.
   - **`supervisor` (Plan $\to$ Parallel Disjoint Execute $\to$ Review & Verify):** `architect` decomposes the goal onto the blackboard, parallel `execute` personas implement disjoint `ownedPaths`, and `security-auditor` / `qa-verifier` sign off.
   - **`debate` (Multi-Persona Parallel Propose + Judge Synthesis):** Runs $N \ge 2$ independent persona proposals in parallel, evaluates trade-offs via a `judge` persona, selects the winning architecture/patch strategy, and logs the distilled decision cue into `SelfLearningLedger`.
   - **`map_reduce`:** Shards read-only analysis across directory scopes in parallel and reduces findings into a single cited synthesis.

---

### 10.4 Pillar 3 — Quarantine-Scanned External Plugin Host (`src/ring9/external-plugin-host.ts`)

1. **Upstream Open-Source Provenance:**
   - Combines `@earendil-works/pi-coding-agent` Extension/Package architecture (MIT), `openclaw/openclaw` capability-manifest plugin hub (MIT), and `NousResearch/hermes-agent` `skills-guard-v10` quarantine scanner (MIT).

2. **Capability Manifest (`apex-plugin.json`) & Static Quarantine Fence:**
   - Each external plugin declares `apex-plugin.json`:
     ```json
     {
       "id": "changelog-helper",
       "name": "Changelog Helper",
       "version": "1.0.0",
       "description": "Generates structured Keep-a-Changelog entries from git log",
       "entry": "index.mjs",
       "capabilities": {
         "codemodeTools": ["format_changelog"],
         "slashCommands": ["changelog"],
         "gatewayPlatforms": [],
         "allowChildProcess": false,
         "allowEnvRead": false
       }
     }
     ```
   - **Pre-Load Security Audit (`auditPluginDirectory`):** Before `import()` is ever called on a plugin entrypoint, `ExternalPluginHost` scans `apex-plugin.json` and every `.js`/`.mjs`/`.cjs`/`.ts` file in the plugin directory (blocking symlinks escaping the plugin root):
     1. Runs `skills-guard-v10` (`scanSkillContent` at `"community"` trust) — blocking reverse shells, exfiltration, prompt injection inside tool descriptions, and obfuscated payloads (`PLUGIN_QUARANTINE_BLOCKED`).
     2. Enforces **Static Capability Conformance**: if `allowChildProcess !== true`, any import/use of `child_process` or `node:child_process` is rejected (`PLUGIN_UNDECLARED_CAPABILITY: child_process`); if `allowEnvRead !== true`, `process.env` harvesting is rejected; dynamic `eval(` / `new Function(` is rejected unconditionally in untrusted plugins.
   - **Zero-Schema-Bloat Registration:** Clean, enabled plugins register tools exclusively via `CodemodeCatalog.registerDynamicTool(...)` as `plugin_<id>_<tool>` (`+0` active `o200k_base` schema tokens — keeping `1,073 === 1,073`!), register optional slash commands, or register custom `OmniChannelGateway` platform adapters, with instant `disablePlugin(id)` / `uninstallPlugin(id)` revocation.

---

### 10.5 Pillar 4 — Cryptographically Hash-Chained Unified Self-Learning Ledger (`src/ring9/self-learning-ledger.ts`)

1. **Upstream Open-Source Provenance & Architectural Role:**
   - Unifies `google-research/harness2` (`EXPERIENCE.md` `cue`/`lesson`/`evidence` library, Apache-2.0), `NousResearch/hermes-agent` (`memory_manager.py` & `curator.py` secret-scrubbed closed learning loop, MIT), and Cursor BugBot (`REVIEW_RULES.md`) behind a **single tamper-evident, append-only ledger**.

2. **SQLite + JSONL Hash-Chained Storage (`learning_ledger` + `.harness/ledger/SELF_LEARNING_LEDGER.jsonl`):**
   - Genesis hash `GENESIS_HASH = "0".repeat(64)`. Every appended entry `seq` computes:
     `entry_hash = sha256(canonicalJson({ seq, entryId, prevHash, timestampMs, sourceEvent, kind, domain, cue, lesson, evidence, status }))`
     where `prevHash` equals entry `seq - 1`'s `entry_hash` (`GENESIS_HASH` for `seq = 1`).
   - `verifyIntegrity()` validates both SQLite `learning_ledger` rows AND `.harness/ledger/SELF_LEARNING_LEDGER.jsonl` from Genesis to tip, returning `{ valid: boolean, totalEntries, activeEntries, headHash, brokenAtSeq? }`.

3. **Automatic Closed-Loop Capture, Anti-Poisoning, Bayesian Utility & Rollback:**
   - **Inbound Hygiene:** Every candidate lesson is scrubbed with `scrubSecretsInfallible()` (preventing Hermes `#115104`-class secret memorization) and scanned with `skills-guard-v10`; poisoned lessons are logged with `status = 'quarantined'` so the hash chain records the attempted poisoning while excluding it from active surfaces.
   - **Automatic Triggers:**
     - `AutonomousPrPipeline` automatically calls `ledger.recordSelfHealRecovery(...)` whenever a BugBot P0/P1 violation or `bwrap` CI failure is autonomously repaired!
     - `PlanModeController` / `/ledger` / `MultiAgentOrchestrator` (`debate` consensus) record operator corrections, review violations, and architectural decisions (`kind ∈ {'experience_cue', 'review_rule', 'memory_fact', 'skill_draft', 'routing_hint'}`).
   - **Bayesian Confidence & Auto-Demotion:** `recordOutcome(entryId, helped)` tracks `applied_count`, `helped_count`, and `regressed_count`, updating `confidence = (helped + 2) / (applied + 3)` and auto-demoting entries (`status = 'demoted'`) when `regressed_count >= 2 && regressed_count > helped_count`.
   - **Append-Only Rollback (`rollbackEntry`) & Next-Boot Materialization (`materializeSurfaces`):** Rolling back an entry marks it `rolled_back` in read projections while appending a hash-chained `tombstone` record so history is never rewritten. `materializeSurfaces()` deterministically compiles top-confidence active `experience_cue` entries into `surfaces/EXPERIENCE.md` (`<= 220` `o200k_base` tokens) and `review_rule` entries into `.agents/REVIEW_RULES.md` for next boot (**`0` mid-session prefix drift**).

---

### 10.6 Mission-Control Cockpit v5 (`Tab 9: Gateway, Swarm, Plugins & Ledger`)

Extends Cockpit v4 (`0.0.0.0:4310`, zero external CDNs, zero `localhost`/`127.0.0.1` client literals, `new Function()` inline-JS syntax guard) with **Tab 9** and four new REST endpoints:

| New Endpoint | Method | Purpose |
|---|---|---|
| `/api/gateway` | `GET` / `POST` | Inspect configured platforms (WhatsApp Baileys QR/Pairing, WhatsApp Cloud API, Telegram, Discord, Slack + App Manifest export, Signal), issue 6-digit pairing codes, simulate/verify inbound webhook turns, approve/deny remote cards, or send outbound messages. |
| `/api/swarm` | `GET` / `POST` | List/create custom `.agents/agents/*.md` personas and run `dag`, `supervisor`, `debate`, or `map_reduce` multi-agent orchestrations with live `AgentBlackboard` inspection. |
| `/api/plugins` | `GET` / `POST` | Audit, install, enable, disable, or inspect external `apex-plugin.json` plugins and their deferred `CodemodeCatalog` tools. |
| `/api/ledger` | `GET` / `POST` | Inspect the SHA-256 hash-chained `SelfLearningLedger`, verify cryptographic chain integrity (`verifyIntegrity`), record lessons/outcomes, rollback entries, or materialize next-boot `EXPERIENCE.md` / `REVIEW_RULES.md`. |

---

### 10.7 Ring 9 Acceptance Gate (`test/ring9/run-ring9-tests.ts`, `R9-1`–`R9-6`)

- **`R9-1` (Omni-Channel Messaging Gateway across All 6 Adapters: WhatsApp Baileys Pairing + WhatsApp Cloud HMAC + Telegram + Discord + Slack HMAC/Manifest + Signal JSON-RPC):** Verifies unpaired senders are hard-blocked (`GATEWAY_SENDER_NOT_PAIRED`), completes cryptographic 6-digit `/pair <CODE>` flow, verifies Meta `X-Hub-Signature-256` & Slack `v0=` HMAC signatures + `generateSlackAppManifest()`, routes real messages across WhatsApp Baileys, WhatsApp Cloud, Telegram, Discord, Slack, and Signal, blocks a prompt-injected inbound chat (`UNTRUSTED_CHANNEL_INJECTION_BLOCKED`), exercises remote `/approve apr_<id>`, and verifies `send()` outbound delivery with `0` prefix drift.
- **`R9-2` (Custom Agent Personas + Multi-Agent `dag`, `supervisor`, & `debate` Orchestration + Shared Blackboard):** Verifies `.agents/agents/*.md` persona discovery + `skills-guard-v10` poisoned-persona block (`AGENT_PERSONA_POISONED`), detects cyclic graphs (`DAG_CYCLE_DETECTED`) and overlapping parallel `ownedPaths`, runs a real multi-wave `dag` orchestration across isolated Git worktrees passing typed facts via `AgentBlackboard` (`0` leaked worktrees), and runs `debate` + `supervisor` modes.
- **`R9-3` (Quarantine-Scanned External Plugin Host + Zero Active Schema Bloat):** Blocks a malicious plugin importing `child_process` / `process.env` / prompt injection (`PLUGIN_QUARANTINE_BLOCKED` / `PLUGIN_UNDECLARED_CAPABILITY`), installs and enables a valid external `apex-plugin.json` plugin, executes its dynamically registered `plugin_<id>_<tool>` inside real QuickJS WASM `codemode` AND its custom slash command, verifies active schema stays strictly **`1,073 === 1,073 o200k_base` tokens**, and verifies clean `disablePlugin` revocation.
- **`R9-4` (Hash-Chained Unified Self-Learning Ledger + Automatic `/pr` Self-Heal Capture + Tamper Detection + Next-Boot Surface Materialization):** Verifies `AutonomousPrPipeline` (`liveLlm: true`) automatically records a BugBot/`bwrap`-CI self-heal recovery into `SelfLearningLedger`, verifies `verifyIntegrity().valid === true`, scrubs secrets & quarantines poisoned lessons, tests Bayesian confidence reinforcement/auto-demotion + append-only `rollbackEntry()`, materializes `EXPERIENCE.md` (`<= 220` tokens) with **`0` live prefix drift**, and proves tamper detection (`valid === false`) when a raw JSONL/DB row is mutated!
- **`R9-5` (All 19 Built-In Deferred Tools + 21 Zero-Token Slash Commands + Mission-Control Cockpit v5 All 9 Tabs in Headless Chromium 156):** Verifies `/gateway`, `/send`, `/agents`, `/swarm`, `/plugin`, and `/ledger` + deferred `gateway_dispatch`, `swarm_orchestrate`, `plugin_manager`, and `learning_ledger` keep `1,073` schema tokens & `0` drift, tests `/api/gateway`, `/api/swarm`, `/api/plugins`, and `/api/ledger`, and verifies all **9 tabs** (`tab-chat`..`tab-ring9`) interactively in **real Headless Chromium 156**.
- **`R9-6` (Portable `pi-apex-v3.9.0-personal.tar.gz` Release Bundle & `--gateway` CLI Verification):** Builds `/home/user/pi-apex-v3.9.0-personal.tar.gz` + `.sha256`, extracts cleanly, builds `linux_fs_bridge.node`, and passes `bin/pi-apex --version` (`3.9.0`) and `bin/pi-apex -p "/doctor"` (`ALL HEALTHY`, `schema=1073`).

---

## 11. Ring 10 — Warm Editorial Agent Studio UI Overhaul (`Cockpit Studio v6`) & 1-Click Provider / Local Ollama / Messaging Onboarding Vault (`v4.0.0`)

### 11.1 Architectural & Visual Design Objectives

Ring 10 replaces the utilitarian developer-tab testbench with an **Anthropic / Warm Editorial Agent Studio (`v4.0.0`)** paired with a **zero-JSON 1-Click Onboarding Vault**, while preserving **100% of Ring 0–9 invariants** (`1,073 === 1,073 o200k_base` active schema tokens across `20` deferred specialist tools and `22` zero-token slash commands, `0` mid-session static prefix drift, zero external CDNs, and zero `localhost`/`127.0.0.1` client literals):

1. **Anthropic / Warm Editorial Design System (`src/ring5/mission-control-ui.ts`):**
   - **Dual Tactile Theme Engine (`data-theme="light" | "dark"`, Warm Editorial Paper default + Warm Espresso toggle):**
     - **Warm Editorial Paper (`light`):** Archival alabaster canvas (`#FAF8F5`), soft warm linen sidebar rail (`#F3EFE9`), pure paper elevated cards (`#FFFFFF`) with subtle stone borders (`#E7E2DA`) and soft diffused elevation (`0 2px 10px rgba(28, 25, 23, 0.04)`), charcoal ink (`#1C1917`), muted stone (`#6B655E`), signature warm terracotta accent (`#C96442`), botanical sage (`#2E6F4E`), ochre amber (`#B4691E`), and crimson (`#B83B33`).
     - **Warm Espresso (`dark`):** Deep warm espresso-charcoal canvas (`#171614`), `#121110` sidebar rail, `#201E1B` elevated surfaces with `#302D28` hairline borders, warm parchment ivory ink (`#F2ECE4`), and `#D97757` terracotta accent — zero cold developer navy.
   - **Editorial Typography (100% Offline System Stack):**
     - Display & section titles in classic editorial serif (`"Iowan Old Style", "Palatino Linotype", "Book Antiqua", Georgia, serif`, `-0.02em` tracking); UI controls in humanist sans; hashes/diffs/metrics in crisp monospace.
   - **Vertical Grouped Left Studio Sidebar (`<nav class="tabs sidebar-nav">`) + Calm Minimal Top Bar:**
     - Replaces the crowded 9-button horizontal strip with a `248px` collapsible left rail organized into four calm editorial sections (**`WORKSPACE`**, **`AUTONOMY & PRs`**, **`SWARM & CHANNELS`**, **`TRUST & MEMORY`**) with bespoke vector SVG icons, active pill highlight, and keyboard shortcuts (`Alt+1`..`Alt+9`).
     - Top bar is decluttered to editorial essentials: Workspace Selector, compact Health & Schema status pill (`1,073 o200k · Verified`), **`⌘K` Command Palette button**, **`Quick Setup` Onboarding button**, and **`Paper / Espresso` Theme Toggle**.
   - **Signature Interactive Studio Components:**
     - **Floating Tactile Chat Composer + Quick-Action Chips:** Rounded `18px` warm card composer with inline preset pills (`Implement`, `Plan`, `Review`, `Fast-Local`), `/` slash quick-insert chips, streaming delta bubble, and warm terracotta circular send button.
     - **Syntax-Colored Unified Git Diff Renderer (`renderColoredDiff`):** Parses `git diff` hunks (`@@ ... @@`), rendering `+` additions in soft botanical sage, `-` deletions in soft rose, and file headers as clean editorial banners with line-gutter indicators.
     - **`⌘K` / `Ctrl+K` Global Command Palette Modal:** Fuzzy-searchable modal launching any of the 22 slash commands, switching Studio views, toggling themes, opening Quick Setup, or switching presets via keyboard (`↑`/`↓`/`Enter`/`Esc`).
     - **Interactive SVG Multi-Agent Topology Graph & Visual Hash-Chain Ledger Blocks:** Renders live curved-Bezier SVG wave graphs for `dag`/`supervisor`/`debate` runs (`Plan` $\to$ parallel `Worktree` nodes $\to$ `Review`/`Judge`), visual cryptographic SHA-256 block cards with confidence progress bars, and deterministic SVG QR-matrix cards for WhatsApp Baileys pairing.

2. **1-Click Provider, Local Ollama & Channel Onboarding Vault (`src/ring10/onboarding-vault.ts` + `/setup` + `/api/onboarding`):**
   - **Upstream OSS Reuse:** Adapts `NousResearch/hermes-agent` (`hermes setup` unified provider + messaging onboarding wizard, MIT) and `@earendil-works/pi-coding-agent@1.4.0` (`ModelRuntime.setRuntimeApiKey`, `auth.json` credential persistence, and OpenAI-compatible `registerProvider`, MIT).
   - **Out-of-Workspace `0600` Credential Vault (`<agentDir>/apex-vault.json`):**
     - Stores personal API keys and messaging bot tokens strictly inside `<agentDir>/apex-vault.json` with `0o600` POSIX permissions — **never** inside `<workspaceRoot>`, so Git commits, worktrees, or workspace tools can never touch it.
     - Exposes **masked-only** read summaries (`maskSecretValue`: e.g. `sk-ant-...4f9a`, never returning raw keys over HTTP `/api/onboarding` or `codemode`!).
   - **Three 1-Click Onboarding Flows:**
     1. **Cloud LLM Provider Key Activation (`saveProviderKey`):** Supports `anthropic`, `openai`, `google`, `openrouter`, `groq`, `xai`, and `mistral` — persists to `0600` vault, calls `modelRuntime.setRuntimeApiKey(provider, apiKey)` immediately in-memory, and optionally pings provider readiness.
     2. **Local Ollama Auto-Discovery (`discoverAndRegisterOllama`):** Probes `<ollamaBaseUrl>/api/tags` (default `http://127.0.0.1:11434`), parses installed local models (`qwen2.5-coder`, `deepseek-coder-v2`, `llama3.3`, etc.), registers each into `ApexProviderRouterController.registerOllamaModel(...)`, and optionally binds `apex/auto` (`planner` + `coder`) in one click!
     3. **Messaging Channel Credential Hot-Reload (`saveChannelCredentials`):** Saves Telegram Bot Token, Discord Bot Token, Slack Bot Token + Signing Secret, Signal `signal-cli` RPC URL + E.164, or Meta WhatsApp Cloud credentials, hot-updating `OmniChannelGateway.updateCredentials(...)` live without restarting the Cockpit!

### 11.2 Studio v6 & Onboarding API (`/api/onboarding`)

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/onboarding` | `GET` / `POST` | `GET` returns masked provider & channel readiness checklist (`configuredProviders`, `configuredChannels`, `ollamaBaseUrl`, `readinessScorePct`); `POST` handles `save_provider_key`, `remove_provider_key`, `discover_ollama`, and `save_channel_credentials` with immediate live runtime activation. |

### 11.3 Ring 10 Acceptance Gate (`test/ring10/run-ring10-tests.ts`, `R10-1`–`R10-6`)

- **`R10-1` (`OnboardingVault` `0600` Out-of-Workspace Storage + Secret Masking + Live `ModelRuntime` Activation):** Saves Anthropic & OpenAI keys into `<agentDir>/apex-vault.json`, verifies `0o600` file mode and zero files written inside `<workspaceRoot>`, verifies `getVaultStatus()` masks every secret (`sk-ant-...`), and confirms `modelRuntime` resolves the credential immediately.
- **`R10-2` (1-Click Local Ollama `/api/tags` Auto-Discovery + `apex/auto` Binding):** Starts a local mock Ollama `/api/tags` HTTP server advertising `qwen2.5-coder:14b` & `deepseek-r1:14b`, runs `discoverAndRegisterOllama()`, and verifies both models register into `ModelRuntime` and bind cleanly to `apex/auto`.
- **`R10-3` (1-Click Messaging Channel Hot-Reload into Live `OmniChannelGateway`):** Configures Telegram & Slack tokens via `OnboardingVault.saveChannelCredentials(...)` on a running harness, verifies `gateway.getStatusSummary()` flips `telegram` & `slack` from `UNCONFIGURED` to `READY` without restart, and delivers a real outbound message through the newly wired token.
- **`R10-4` (Deferred `onboarding_status` Tool + `/setup` Slash Command + `1,073 === 1,073` Schema Invariant):** Verifies `onboarding_status` inside QuickJS WASM `codemode` (confirming raw secrets are never exposed to QuickJS) and `/setup` (`status`, `ollama`, `channel`) keep **`1,073 === 1,073 o200k_base` active schema tokens** and **`0` live prefix drift** across all **20 deferred tools** and **22 slash commands**.
- **`R10-5` (Warm Editorial Studio UI v6 Live Headless Chromium 156 Visual & Interactive Audit):** Opens Cockpit Studio v6 in **real Headless Chromium 156 (`1440x900`)**, verifies the Warm Editorial Paper (`#faf8f5` / `rgb(250, 248, 245)`) computed background & serif headings, toggles to Warm Espresso Dark (`[data-theme="dark"]`), opens and searches the **`⌘K` Command Palette**, opens the **1-Click Quick Setup Drawer** and saves a provider key + discovers Ollama over `/api/onboarding`, verifies syntax-colored diff lines (`.diff-line-add` / `.diff-line-del`) & SVG topology rendering, and clicks all **9 left-sidebar views** cleanly with zero JS console errors!
- **`R10-6` (Portable `pi-apex-v4.0.0-personal.tar.gz` Release Bundle Verification):** Builds `/home/user/pi-apex-v4.0.0-personal.tar.gz` + `.sha256`, extracts cleanly, builds `linux_fs_bridge.node`, and passes `bin/pi-apex --version` (`4.0.0`) and `bin/pi-apex -p "/doctor"` (`ALL HEALTHY`, `schema=1073`).

---

## 12. Ring 11 — Streaming Studio Voice, Multimodal, Model/Persona Profiles & Execution Modes (`v4.1.0`)

### 12.1 Product Goal & Non-Negotiable Safety Contract

Ring 11 upgrades the multi-turn Streaming Agent Studio from text-only controls into a **configurable voice-and-multimodal interaction surface** while preserving the existing Ring 0–10 security spine. The operator can choose a configured catalog model, model reasoning effort (`low`, `medium`, `high`, `max`), a chat persona, and a task/build profile in the chat view. Speech and model controls are first-class but remain server-mediated, provider-aware, and secret-safe.

**Turbo semantics are explicitly bounded by the operator’s selected `approval_only` interpretation:** `turbo` skips confirmation prompts only; it does not disable Bubblewrap, network isolation, path boundaries, filesystem brokers, secret masking, kernel protections, capability checks, or hard-deny guardrails. There is no "unrestricted host mode" in this feature. The separately existing `danger-full-access` sandbox setting remains an explicit underlying configuration and is never activated by a UI execution-mode selector.

### 12.2 Voice & Speech I/O Provider Architecture (`src/ring11/speech-io.ts`)

- **Provider-neutral adapter interface:** `SpeechIOProvider.transcribe(audio, options)` and `synthesize(text, options)` with explicit capability/status descriptions. UI/API responses return readiness and safe error details; never provider credentials.
- **Cloud option:** OpenAI-compatible audio endpoints, using a provider key retrieved only server-side from `OnboardingVault`; multipart upload to transcription and streamed-or-buffered audio response for synthesis. Initial supported cloud profile uses OpenAI-compatible `/v1/audio/transcriptions` and `/v1/audio/speech`; model/voice IDs are selectable from validated configuration. No key is exposed to browser JavaScript or QuickJS Codemode.
- **Local option:** Optional `whisper.cpp`-compatible STT executable/model and Piper-compatible TTS executable/voice model, detected only when explicitly configured. Invoke absolute executable paths with `spawn`/argument arrays (never shell interpolation), bounded input/output, no ambient environment inheritance, private `0700` temporary directory under the user agent directory, and cleanup after completion. If local dependencies/models are absent, show `UNAVAILABLE` instead of silently falling back to cloud.
- **Secrets:** Speech provider credentials reuse the out-of-workspace `0600` Onboarding Vault; browser receives only a masked provider readiness record. Cloud speech routes use an explicit backend-owned egress policy in the same provider class configured by the operator; no implicit anonymous third-party service or browser-to-cloud direct request.
- **Audio capture:** Browser `MediaRecorder` microphone capture requests permission only after an explicit user click; also supports drag/drop or file upload for approved audio MIME types. A visible recording indicator, stop/cancel, duration and size limits, and transcription preview are mandatory. Speech is not captured in the background.
- **Audio output:** Per-message **Listen** action plus optional `Auto-read assistant replies` toggle. TTS output is generated through the selected speech provider and rendered in a keyboard-accessible `<audio controls>` player. Auto-read is off by default; browser audio does not autoplay without operator action.

### 12.3 Image Multimodal Input & Request Safety

- **Image attachments:** Add paste-from-clipboard, file picker, and drag/drop for JPEG/PNG/WebP, with local thumbnail preview, remove controls, max `8 MiB` per image and max `4` images per message. Convert to Pi `ImageContent[]` only on the server and pass via the SDK-supported `session.prompt(text, { images })` API; do not serialize image data into transcript HTML or hidden prompt text.
- **Validation:** Reject non-image formats, malformed base64, empty or oversized payloads, excessive image count, and unsupported model modalities with precise errors. Do not attempt SVG/HTML/document execution. No image bytes are written into the workspace or session transcript files by the adapter. Existing Pi model capability (`model.input` includes `image`) determines whether the chosen model accepts image input; otherwise ask operator to switch model or send text-only.
- **Audio + image:** Audio is transcribed into a visible editable transcript before it enters the chat session; a separate opt-in `Send transcript` action preserves the human review opportunity. Image and text can be sent together to multimodal models.
- **Video:** Explicitly deferred from v4.1; no video capture/upload, frame extraction, or background microphone/camera collection.

### 12.4 Chat Controls & Selection Semantics

- **Catalog model selector:** Compact model dropdown within the Streaming Agent composer, populated from `GET /api/models` (the configured in-background `ModelRuntime` catalog, including local Ollama and virtual `apex/auto`). Selection calls `POST /api/models { action: "set_model", provider, modelId }` and is session-only; missing/unconfigured keys and unsupported modalities are indicated before send. Chat refresh and SSE stream never expose API keys.
- **Reasoning effort:** `low`, `medium`, `high`, `max` dropdown persists only for the active session via `AgentSession.setThinkingLevel()`. `max` maps to the active model’s strongest supported thinking level, clamped by the Pi SDK’s model capability (for example, models may support up to `high` or `xhigh`, or no extended reasoning); UI displays the effective level so it never promises unsupported capability.
- **Chat personas:** Built-in `General`, `Architect`, `Builder`, `Reviewer`, and `Pair Programmer`; optional workspace custom persona can be selected only after `.agents/agents/*.md` discovery and `skills-guard-v10` validation. Persona is supplied as an explicit, escaped per-turn operator context wrapper, not by mutating `session.systemPrompt`; it cannot relax global guardrails or grant tools.
- **Build profiles:** `Implement`, `Plan`, `Review`, `Fast local`, and `Custom`. Profiles set session-local defaults for persona, reasoning level, and (where a referenced configured catalog model exists) an optional preferred model. Explicit model/reasoning choices after profile selection override profile defaults. Profiles never grant tools or permissions and never mutate the boot-pinned system prefix.
- **Current turn metadata:** Show model, effective reasoning, persona, build profile, and execution mode near the transcript/composer. Store safe selection metadata in message details for transcript rendering; no raw media content or secrets.

### 12.5 Four Operator Execution Modes (`src/ring11/execution-mode-controller.ts`)

These modes change **approval/confirmation policy**, not the hard security boundary:

1. **`review` — Approve Every Command:** Every shell command and every potentially side-effecting tool operation requires an operator confirmation before execution. Read-only inspection can be separately displayed as non-mutating but remains visible in the review queue. Decline/cancel fails closed.
2. **`default` — Ask Before Sensitive Operations (default):** Preserve current Pi-Apex behavior; statically identified sensitive actions (writes/deletes, network/API side effects, credential or configuration changes, package installation, Git mutation, and high-impact commands) ask for confirmation. Routine safe reads proceed under existing tool permissions.
3. **`auto` — Deterministic Policy Decision:** A local deterministic action classifier (never an LLM-only decision) classifies each pending action `allow`, `confirm`, or `deny` against the same immutable guardrails and operator-maintained allowlist. Safe read-only operations and explicitly allowed low-risk actions can proceed unattended; ambiguous/high-impact actions ask; hard-deny actions block. Every decision records action, classification, rationale, timestamp, and outcome in the existing audit stream.
4. **`turbo` — No Confirmation Prompts, Same Hard Boundary:** Automatically executes commands already permitted by configured tool/policy settings, with `0` confirmation prompts. It does **not** disable `bwrap`, network isolation, secret masking, workspace restrictions, denied plugin capabilities, or hard-deny rules; it is not root/full-host access. Persistent amber UI indicator, per-session timeout, and explicit click-to-enable required.

- **Mode transition:** Mode changes apply to the next tool action only, are session-local and visible, and never mutate immutable `GUARDRAILS.yaml`, static prefixes, sandbox mode, or host privileges. `review` and `default` are initial-safe modes; `auto`/`turbo` require explicit in-UI enablement. User can cancel an in-flight prompt/action; cancellation must not mark an uncommitted effect as successful.
- **Prompt injection defense:** Instructions from images/audio transcripts, custom personas, and model output remain untrusted data; neither attachments nor transcripts may grant execution approval. The UI mode is an operator-set policy state, not model-controlled.

### 12.6 API & Deferred Specialist Tools

| Route | Method | Purpose |
|---|---|---|
| `/api/prompt` | `POST` | Accepts `text` + validated optional `ImageContent[]`, `personaId`, and safe profile metadata; forwards images via SDK prompt options. Steer requests remain text-only. |
| `/api/models` | `GET` / `POST` | Adds `set_thinking_level` and returns effective/clamped reasoning capability; existing model catalog and `set_model` remain canonical. |
| `/api/speech` | `GET` / `POST` | Reports provider readiness; transcribes an explicitly uploaded/recorded audio payload; synthesizes explicitly requested text; supports speech provider selection without returning credentials. |
| `/api/interaction` | `GET` / `POST` | Reads/updates session persona, build profile, and execution mode; validates mode transitions and records audit events. |

Add a **deferred** `speech_io` specialist tool (`exposure: "deferred"`) that supports only explicit `transcribe`/`synthesize` actions; no microphone access and no arbitrary local command path are exposed to the model. Expected active tool schema remains exactly `1,073 === 1,073 o200k_base`; slash command `/interaction` remains zero-token.

### 12.7 Ring 11 Acceptance Gates (`test/ring11/run-ring11-tests.ts`, `R11-1`–`R11-8`)

- **`R11-1` (Cloud/Local Speech Adapter Unit & Vault Secret Boundary):** Mock compatible cloud transcription/TTS endpoints and fake local Whisper/Piper executables; verify no browser response, log, or Codemode result contains API tokens; wrong MIME, malformed payload, oversized audio, local binary timeout, and missing local models fail closed.
- **`R11-2` (Microphone & Audio Upload UX):** Headless Chromium verifies mic starts only after click, active recording indicator, stop/cancel, upload, visible editable transcript, explicit transcript send, Listen button, audio controls, and auto-read disabled by default (cloud calls mocked).
- **`R11-3` (Image Attachment Multimodal Prompt):** Verify JPEG/PNG/WebP validation, clipboard/file attach preview/remove, four-image/8-MiB cap, unsupported model rejection, no workspace/temp leakage, and images passed in SDK `prompt` options with expected Pi `ImageContent[]` shape.
- **`R11-4` (Model Catalog + Reasoning Clamp):** Switch among configured catalog provider/local/virtual models, validate unknown model rejection, set low/medium/high/max, and verify effective reasoning correctly clamps to model/provider capabilities.
- **`R11-5` (Persona & Build Profile Session Semantics):** Verify built-ins, safe custom persona discovery and poisoned persona block, profile defaults/explicit overrides, per-turn context wrapper, zero `session.systemPrompt` mutation, zero static-prefix drift, and no persona-based permission grants.
- **`R11-6` (Review/Default/Auto/Turbo Approval-State Matrix):** Simulate read, write, delete, package install, outbound network and denied operations under all four modes. Ensure review asks on every command, default asks on sensitive operations, auto deterministic allow/confirm/deny + audit, turbo skips confirms but preserves exact hard deny and `bwrap` policy; model/provider cannot switch the current mode.
- **`R11-7` (Streaming Chat v7 End-to-End in Chromium):** Exercise multi-turn SSE while changing model/persona/profile/reasoning/mode between turns; attach an image; transcribe audio then send reviewed text; generate and play synthesized audio; confirm every mode/status badge updates and no console exceptions or secret leaks occur.
- **`R11-8` (Release Archive):** Builds `/home/user/pi-apex-v4.1.0-personal.tar.gz` + SHA-256, verifies install, `/doctor`, UI launch, speech dependency readiness reporting, and unchanged `1,073` active schema tokens.






# Ring 12 Specification — Provider Connections & Model Catalog Manager (`v4.2.0`, in progress)

**Status:** specification approved for implementation on 2026-10-26, with these operator decisions: runtime + optional models.dev metadata; API keys and Ollama first; multiple isolated connections per provider. Implementation is in progress. Current implementation exposes the installed runtime provider inventory, searchable/paginated runtime + advisory models.dev catalog, explicit runtime/remote refresh, custom OpenAI-/Anthropic-compatible connections, vault-backed credentials, explicit connection tests, enable/disable/disconnect, model favorites/recents, and local connection persistence. Unit, API, and Chromium integration tests cover the first slice. Remaining gates include live models.dev contract testing, deeper endpoint/DNS-rebinding security review, catalog virtualization at very large sizes, richer built-in provider setup/auth diagnostics, and final Ring 12 release acceptance. This scope uses Pi-Apex `ModelRuntime`; it does not claim every OpenCode integration is drop-in compatible.

## Goal

Replace the current narrow onboarding/model dropdown with a first-class, local-first management experience for connecting multiple model providers and browsing large model catalogs. Support many provider integrations and hundreds of models where the installed runtime/provider catalog can actually serve them. Provider setup, credentials, model discovery, selection, and per-conversation model persistence must be understandable and safe.

## Product requirements

1. **Provider inventory and connection flow**
   - Add a dedicated **Providers & Models** page/drawer separate from the existing onboarding quick setup.
   - List supported built-in integrations discovered from the installed Pi AI/runtime provider registry; include each provider's supported auth modes and model APIs where available.
   - Add validated generic adapters for OpenAI-compatible endpoints, Anthropic-compatible endpoints, and local Ollama. Do not label a provider supported unless a real runtime API adapter exists.
   - Support adding, editing, testing, disabling, and removing a connection. Provider IDs and model IDs are stable normalized identifiers; names/URLs/headers are displayed with safe escaping.
   - Connection test is an explicit operator action. It reports safe status/error summaries and never returns credentials, authorization headers, or raw provider error bodies.

2. **Catalog discovery and management**
   - Aggregate models from the Pi runtime's built-in catalog, configured providers, local Ollama discovery, and an optional remote catalog source (default proposal: models.dev) fetched server-side with bounded timeout/response size and cached locally.
   - Remote catalog metadata is advisory only: it can populate a provider/model chooser but cannot execute code, silently add credentials, or auto-enable an integration. Importing a model/provider requires operator confirmation and successful runtime validation. Attribute the metadata source as models.dev (MIT; `https://models.dev/api.json`); no upstream provider code is copied or executed.
   - Provide server-side search, provider/type filters, capability badges (text/image/reasoning/context window), favorites, and recently used models. The UI must remain responsive with hundreds/thousands of entries (paginate/virtualize; do not ship an unbounded catalog into every chat render).
   - Permit explicit custom model definitions for compatible endpoints with validated required fields and conservative defaults. Unsupported/unknown capability claims are not presented as verified.
   - Refresh catalog on demand and at a bounded low-frequency cadence; show `last refreshed`, cache age, and stale/offline state. No startup network call is required for saved local/runtime catalogs.

3. **Credentials and endpoint security**
   - All secrets live only in the existing out-of-workspace `OnboardingVault` with restrictive file permissions; UI/API return only masked readiness, credential source, and last-validated status. Never write keys to workspace config, session transcripts, audit entries, errors, browser storage, or HTML.
   - Credential updates/removals take effect in the live `ModelRuntime` without restart when supported; otherwise clearly indicate restart requirement.
   - Validate endpoint schemes/hosts; default to HTTPS except loopback/local endpoints explicitly selected by the operator. Prevent SSRF to cloud metadata/private networks for non-local providers, restrict redirects, set request timeouts/size limits, and avoid forwarding ambient credentials across origins.
   - Secrets are sent only to the configured provider endpoint. Custom headers are secret-capable fields, stored encrypted/secret-side in vault (not plain provider metadata), masked in the UI, and must not override host/origin routing.

4. **Models in Studio**
   - Keep current per-conversation model persistence and session switching. Model selection is per saved conversation; switching one conversation must not mutate another. One active conversation per runtime remains the supported contract unless concurrent runtimes are separately designed.
   - Show unavailable/unconfigured states and a direct “Connect provider” action; prevent selection of models without valid configuration. Model capability checks (including image/reasoning) remain authoritative from runtime model metadata.
   - Keep virtual `apex/auto` behavior explicit and preserve existing profiles/reasoning clamp. Profile defaults cannot override a later explicit model choice.
   - Model/provider errors are safe, actionable, and do not leak provider response bodies or secrets.

5. **API proposal**
   - `GET /api/providers`: provider status summaries, auth modes, connection IDs; no secret values.
   - `POST /api/providers`: add/update/disable/remove/test/refresh actions, schema-validated; destructive removal requires explicit confirmation token/action.
   - `GET /api/models`: paginated/filterable catalog query and active conversation selection, retaining existing response compatibility where practical.
   - `POST /api/models`: retain existing set-model/reasoning actions and add favorite/refresh/import operations with strict validation.
   - Separate `/api/catalog` only if it improves boundary clarity; all provider/network operations execute server-side.
   - SSE events announce catalog/provider status changes without credentials or unbounded payloads.

6. **Observability and privacy**
   - Persistent audit records record provider/model IDs and action outcomes only; never credentials, custom secret headers, raw endpoint response bodies, or prompt content.
   - Connection testing and catalog refresh are operator-triggered, visible actions. No silent outbound telemetry.
   - Provide per-provider connection diagnostics and an exportable redacted configuration snapshot; import/export excludes secrets by default and requires explicit secure re-entry on another installation.

## Non-goals / boundaries

- Do not clone OpenCode branding or imply upstream code/provenance. Reuse Pi-Apex runtime/SDK functionality honestly and attribute any reused OSS code.
- Do not promise every OpenCode provider or automatic OAuth login flow until the installed SDK exposes and tests that specific integration.
- No arbitrary user-supplied plugin code, shell-based credential helpers, browser-direct provider calls, credential sharing across unrelated providers, or provider-controlled changes to execution modes/guardrails.
- No simultaneous independent active chat runtimes as part of this feature; per-saved-conversation model selection is retained.

## Acceptance gates (`R12-1`–`R12-7`)

- **R12-1 Provider inventory:** fixture the runtime registry; prove every advertised provider has a concrete registered adapter/auth path; generic compatible adapters reject malformed IDs, URLs, headers, and model definitions.
- **R12-2 Vault boundary:** add/update/remove credentials; assert `0600` and out-of-workspace storage; scan API/UI/log/audit/session/export responses for secrets; verify live runtime credential changes.
- **R12-3 Catalog scale:** serve large deterministic catalog fixtures; test pagination/search/filter/favorites/capability flags and bounded UI render size; cached/offline/stale/refresh behavior.
- **R12-4 Endpoint security:** SSRF/redirect/timeout/oversize tests, HTTPS-default tests, loopback opt-in tests, credential-origin isolation, and error-body redaction.
- **R12-5 Model/session semantics:** connect two providers, select models in two saved conversations, switch back/forth, verify independent selection, image/reasoning capability enforcement, and unchanged `apex/auto` behavior.
- **R12-6 Chromium UX:** connect/test/disconnect provider with mocked network, edit custom compatible model, search/filter large catalog, refresh/cache status, and verify no console errors or secret leakage.
- **R12-7 Release:** run complete suite and typecheck, package, extract/install, `/doctor`, UI launch, and verify schema/prefix invariants remain unchanged.

## Open decisions requiring user review before implementation

1. Should optional remote catalog metadata use **models.dev**, runtime-only catalogs, or both? Recommended: both, with remote metadata optional/advisory and explicitly refreshable.
2. Should initial credentials support be API keys only plus local Ollama, or also SDK-native OAuth flows where available? Recommended: API keys/local first; include OAuth only for integrations with complete SDK-native login/refresh lifecycle and tests.
3. Should users be able to add multiple named connections for the same provider (for example work/personal endpoints)? Recommended: yes, with separate connection IDs and isolated credentials.
4. Should the first implementation prioritize broad known-provider presets or a robust OpenAI-compatible custom endpoint workflow? Recommended: custom-compatible + Ollama + all genuinely supported built-in providers, catalogued from actual runtime capability rather than a fixed aspirational count.
