#!/usr/bin/env python3
"""
Persistent stdio JSON-RPC SQLite 3.46 WAL + FTS5 sidecar ledger for Pi-Apex.
Provides atomic Write-Ahead Intent Logging, Task Leases, Forkable `asOf` Docs,
and FTS5 Episodic Session Search.
"""
import hashlib
import json
import sqlite3
import sys
import time

db_path = sys.argv[1]
conn = sqlite3.connect(db_path, isolation_level=None)
conn.row_factory = sqlite3.Row
conn.execute("PRAGMA journal_mode = WAL;")
conn.execute("PRAGMA synchronous = NORMAL;")
conn.execute("PRAGMA foreign_keys = ON;")

conn.executescript("""
CREATE TABLE IF NOT EXISTS wal_intents (
    idempotency_key TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    leaf_entry_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    canonical_args TEXT NOT NULL,
    mutating INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL, -- INTENT_LOGGED | EXECUTING | EFFECT_COMMITTED | TRANSCRIPT_APPENDED | FAILED
    result_json TEXT,
    lease_owner TEXT,
    lease_expires_ms INTEGER,
    created_ms INTEGER NOT NULL,
    updated_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_docs (
    session_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    doc_kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (session_id, entry_id, doc_kind)
);

CREATE TABLE IF NOT EXISTS git_checkpoints (
    session_id TEXT NOT NULL,
    entry_id TEXT NOT NULL,
    git_tree_oid TEXT NOT NULL,
    created_ms INTEGER NOT NULL,
    PRIMARY KEY (session_id, entry_id)
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_episodes USING fts5(
    session_id UNINDEXED,
    entry_id UNINDEXED,
    role,
    tool_name,
    content
);
""")

def handle(req):
    op = req["op"]
    now = int(time.time() * 1000)

    if op == "log_intent":
        k = req["idempotencyKey"]
        row = conn.execute("SELECT * FROM wal_intents WHERE idempotency_key = ?", (k,)).fetchone()
        if row:
            return {"existing": dict(row)}
        conn.execute(
            """INSERT INTO wal_intents
               (idempotency_key, session_id, leaf_entry_id, tool_call_id, tool_name,
                canonical_args, mutating, status, lease_owner, lease_expires_ms, created_ms, updated_ms)
               VALUES (?, ?, ?, ?, ?, ?, ?, 'INTENT_LOGGED', ?, ?, ?, ?)""",
            (k, req["sessionId"], req["leafEntryId"], req["toolCallId"], req["toolName"],
             req["canonicalArgs"], 1 if req.get("mutating") else 0,
             req["leaseOwner"], now + req.get("leaseTtlMs", 30000), now, now)
        )
        return {"existing": None, "status": "INTENT_LOGGED"}

    elif op == "mark_executing":
        conn.execute(
            "UPDATE wal_intents SET status = 'EXECUTING', updated_ms = ? WHERE idempotency_key = ?",
            (now, req["idempotencyKey"])
        )
        return {"ok": True}

    elif op == "commit_effect":
        conn.execute(
            "UPDATE wal_intents SET status = 'EFFECT_COMMITTED', result_json = ?, updated_ms = ? WHERE idempotency_key = ?",
            (json.dumps(req["result"]), now, req["idempotencyKey"])
        )
        return {"ok": True}

    elif op == "mark_appended":
        conn.execute(
            "UPDATE wal_intents SET status = 'TRANSCRIPT_APPENDED', updated_ms = ? WHERE idempotency_key = ?",
            (now, req["idempotencyKey"])
        )
        return {"ok": True}

    elif op == "reconcile_orphans":
        rows = conn.execute(
            """SELECT * FROM wal_intents
               WHERE session_id = ? AND status IN ('INTENT_LOGGED', 'EXECUTING', 'EFFECT_COMMITTED')
               ORDER BY created_ms ASC""",
            (req["sessionId"],)
        ).fetchall()
        return {"orphans": [dict(r) for r in rows]}

    elif op == "put_doc":
        conn.execute(
            """INSERT OR REPLACE INTO session_docs (session_id, entry_id, doc_kind, payload_json, created_ms)
               VALUES (?, ?, ?, ?, ?)""",
            (req["sessionId"], req["entryId"], req["docKind"], json.dumps(req["payload"]), now)
        )
        return {"ok": True}

    elif op == "get_doc_as_of":
        # Walk ancestor chain in order from leaf -> root, returning closest snapshot
        for eid in req["ancestorChain"]:
            row = conn.execute(
                "SELECT payload_json FROM session_docs WHERE session_id = ? AND entry_id = ? AND doc_kind = ?",
                (req["sessionId"], eid, req["docKind"])
            ).fetchone()
            if row:
                return {"found": True, "entryId": eid, "payload": json.loads(row["payload_json"])}
        return {"found": False, "payload": None}

    elif op == "put_checkpoint":
        conn.execute(
            """INSERT OR REPLACE INTO git_checkpoints (session_id, entry_id, git_tree_oid, created_ms)
               VALUES (?, ?, ?, ?)""",
            (req["sessionId"], req["entryId"], req["gitTreeOid"], now)
        )
        return {"ok": True}

    elif op == "get_checkpoint":
        row = conn.execute(
            "SELECT git_tree_oid FROM git_checkpoints WHERE session_id = ? AND entry_id = ?",
            (req["sessionId"], req["entryId"])
        ).fetchone()
        return {"gitTreeOid": row["git_tree_oid"] if row else None}

    elif op == "index_episode":
        conn.execute(
            "INSERT INTO fts_episodes (session_id, entry_id, role, tool_name, content) VALUES (?, ?, ?, ?, ?)",
            (req["sessionId"], req["entryId"], req["role"], req.get("toolName", ""), req["content"])
        )
        return {"ok": True}

    elif op == "search_episodes":
        rows = conn.execute(
            """SELECT session_id, entry_id, role, tool_name, snippet(fts_episodes, 4, '[', ']', '...', 16) AS snip
               FROM fts_episodes WHERE fts_episodes MATCH ? LIMIT ?""",
            (req["query"], req.get("limit", 5))
        ).fetchall()
        return {"hits": [dict(r) for r in rows]}

    raise ValueError(f"Unknown op: {op}")

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    req = json.loads(line)
    req_id = req.get("id")
    try:
        res = handle(req)
        sys.stdout.write(json.dumps({"id": req_id, "ok": True, "data": res}) + "\n")
    except Exception as exc:
        sys.stdout.write(json.dumps({"id": req_id, "ok": False, "error": str(exc)}) + "\n")
    sys.stdout.flush()
