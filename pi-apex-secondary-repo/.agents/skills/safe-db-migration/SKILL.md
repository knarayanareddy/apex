---
name: safe-db-migration
description: Safe SQLite WAL migration checklist
---
# Safe SQLite Migration
1. Take online page backup via node:sqlite backup() API.
2. Run FTS5 integrity-check before and after schema migration.