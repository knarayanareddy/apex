import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type ParserNamespace from "web-tree-sitter";
import Parser from "web-tree-sitter";
import { countO200kTokens } from "../core/prefix-budget.ts";
import {
  isSecretBasename,
  readWorkspaceFileSafe,
  scanWorkspaceSecretsAndHardlinks
} from "../core/safe-path.ts";
import type { StateDb } from "../core/state-db.ts";

const require = createRequire(import.meta.url);

export interface RepoSymbolItem {
  name: string;
  kind: "class" | "interface" | "type" | "function" | "method" | "struct" | "enum" | "const";
  line: number;
  signature: string;
}

export interface IndexedRepoFile {
  relPath: string;
  language: string;
  size: number;
  mtimeMs: number;
  contentSha256: string;
  symbols: RepoSymbolItem[];
  referencedIdentifiers: string[];
}

export interface RepoMapResult {
  rootMerkleHash: string;
  totalIndexedFiles: number;
  reparsedFiles: number;
  cacheHitFiles: number;
  tokenCount: number;
  rankedFiles: Array<{ relPath: string; score: number; symbolCount: number }>;
  renderedMap: string;
}

const EXT_TO_GRAMMAR: Record<string, { lang: string; wasmFile: string }> = {
  ".ts": { lang: "typescript", wasmFile: "tree-sitter-typescript.wasm" },
  ".mts": { lang: "typescript", wasmFile: "tree-sitter-typescript.wasm" },
  ".cts": { lang: "typescript", wasmFile: "tree-sitter-typescript.wasm" },
  ".tsx": { lang: "tsx", wasmFile: "tree-sitter-tsx.wasm" },
  ".js": { lang: "javascript", wasmFile: "tree-sitter-javascript.wasm" },
  ".mjs": { lang: "javascript", wasmFile: "tree-sitter-javascript.wasm" },
  ".cjs": { lang: "javascript", wasmFile: "tree-sitter-javascript.wasm" },
  ".jsx": { lang: "javascript", wasmFile: "tree-sitter-javascript.wasm" },
  ".py": { lang: "python", wasmFile: "tree-sitter-python.wasm" },
  ".go": { lang: "go", wasmFile: "tree-sitter-go.wasm" },
  ".rs": { lang: "rust", wasmFile: "tree-sitter-rust.wasm" },
  ".c": { lang: "c", wasmFile: "tree-sitter-c.wasm" },
  ".h": { lang: "c", wasmFile: "tree-sitter-c.wasm" }
};

const EXCLUDED_DIRS = new Set([
  ".git",
  ".harness",
  "node_modules",
  ".venv",
  "dist",
  "build",
  "coverage",
  ".next",
  "target"
]);

let parserInitPromise: Promise<void> | null = null;
const loadedGrammars = new Map<string, Promise<ParserNamespace.Language>>();

async function loadTreeSitterLanguage(wasmFile: string): Promise<ParserNamespace.Language> {
  if (!parserInitPromise) {
    parserInitPromise = Parser.init();
  }
  await parserInitPromise;

  let cached = loadedGrammars.get(wasmFile);
  if (!cached) {
    const pkgPath = require.resolve("tree-sitter-wasms/package.json");
    const wasmAbsPath = path.join(path.dirname(pkgPath), "out", wasmFile);
    cached = Parser.Language.load(wasmAbsPath);
    loadedGrammars.set(wasmFile, cached);
  }
  return cached;
}

function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Splits camelCase, PascalCase, snake_case, and kebab-case identifiers into lowercase sub-tokens
 * for hybrid BM25 lexical matching (e.g., `computeIdempotencyKey` -> `["computeidempotencykey", "compute", "idempotency", "key"]`).
 */
export function splitIdentifierTokens(raw: string): string[] {
  const tokens = new Set<string>();
  const words = raw.split(/[^A-Za-z0-9_]+/).filter((w) => w.length >= 2);
  for (const w of words) {
    tokens.add(w.toLowerCase());
    const parts = w
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[_\s-]+/)
      .map((s) => s.toLowerCase())
      .filter((s) => s.length >= 2);
    for (const p of parts) {
      tokens.add(p);
    }
  }
  return Array.from(tokens);
}

function compactSignatureLine(sourceLines: string[], row: number): string {
  const raw = (sourceLines[row] ?? "").trim();
  // Trim trailing opening brace body while keeping parameters & return type cleanly
  const collapsed = raw.replace(/\s+/g, " ").replace(/\s*\{[\s\S]*$/, "").trim();
  return collapsed.slice(0, 140);
}

/**
 * Walks a real `web-tree-sitter` syntax tree to extract top-level/class symbol declarations
 * and cross-file identifier references.
 */
function extractAstSymbolsAndRefs(
  rootNode: ParserNamespace.SyntaxNode,
  sourceText: string
): { symbols: RepoSymbolItem[]; referencedIdentifiers: string[] } {
  const sourceLines = sourceText.split("\n");
  const symbols: RepoSymbolItem[] = [];
  const refs = new Set<string>();
  const declaredNames = new Set<string>();

  const recordSymbol = (
    node: ParserNamespace.SyntaxNode,
    kind: RepoSymbolItem["kind"],
    nameNode: ParserNamespace.SyntaxNode | null
  ) => {
    const name = nameNode?.text?.trim();
    if (!name || name.length < 2) return;
    const line = node.startPosition.row + 1;
    const sig = compactSignatureLine(sourceLines, node.startPosition.row);
    declaredNames.add(name);
    symbols.push({
      name,
      kind,
      line,
      signature: sig || `${kind} ${name}`
    });
  };

  const walk = (node: ParserNamespace.SyntaxNode, depth: number) => {
    const t = node.type;

    if (t === "class_declaration" || t === "abstract_class_declaration" || t === "class_definition") {
      recordSymbol(node, "class", node.childForFieldName("name"));
    } else if (t === "interface_declaration" || t === "trait_item") {
      recordSymbol(node, "interface", node.childForFieldName("name"));
    } else if (t === "type_alias_declaration" || t === "type_item") {
      recordSymbol(node, "type", node.childForFieldName("name"));
    } else if (t === "enum_declaration" || t === "enum_item") {
      recordSymbol(node, "enum", node.childForFieldName("name"));
    } else if (t === "struct_item" || t === "struct_specifier") {
      recordSymbol(node, "struct", node.childForFieldName("name"));
    } else if (
      t === "function_declaration" ||
      t === "function_definition" ||
      t === "function_item" ||
      t === "method_declaration"
    ) {
      if (depth <= 4) {
        recordSymbol(node, "function", node.childForFieldName("name") ?? node.childForFieldName("declarator"));
      }
    } else if (t === "method_definition") {
      recordSymbol(node, "method", node.childForFieldName("name"));
    } else if (t === "lexical_declaration" && depth <= 2) {
      for (const child of node.namedChildren) {
        if (child.type === "variable_declarator") {
          const val = child.childForFieldName("value");
          const nameNode = child.childForFieldName("name");
          if (val && (val.type === "arrow_function" || val.type === "function_expression")) {
            recordSymbol(node, "function", nameNode);
          } else if (depth <= 2 && node.parent?.type === "export_statement") {
            recordSymbol(node, "const", nameNode);
          }
        }
      }
    } else if (t === "identifier" || t === "type_identifier" || t === "property_identifier") {
      const txt = node.text;
      if (txt.length >= 3 && txt.length <= 64) {
        refs.add(txt);
      }
    }

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) walk(child, depth + 1);
    }
  };

  walk(rootNode, 0);

  for (const d of declaredNames) {
    refs.delete(d);
  }

  return {
    symbols,
    referencedIdentifiers: Array.from(refs).slice(0, 250)
  };
}

export class MerkleRepoMapEngine {
  readonly workspaceRoot: string;
  private readonly stateDb: StateDb;

  constructor(workspaceRoot: string, stateDb: StateDb) {
    this.workspaceRoot = fs.realpathSync(workspaceRoot);
    this.stateDb = stateDb;
    this.initSchema();
  }

  private initSchema(): void {
    this.stateDb.db.exec(`
      CREATE TABLE IF NOT EXISTS merkle_repo_files (
        rel_path              TEXT PRIMARY KEY,
        language              TEXT NOT NULL,
        size                  INTEGER NOT NULL,
        mtime_ms              INTEGER NOT NULL,
        content_sha256        TEXT NOT NULL,
        symbols_json          TEXT NOT NULL,
        refs_json             TEXT NOT NULL,
        updated_at_ms         INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS merkle_repo_dirs (
        dir_rel_path          TEXT PRIMARY KEY,
        merkle_sha256         TEXT NOT NULL,
        updated_at_ms         INTEGER NOT NULL
      );
    `);
  }

  /**
   * Incrementally indexes workspace source files using real `web-tree-sitter` WASM grammars,
   * updating per-file AST symbol rows and rolling up directory Merkle hashes (`Cursor 3.5` design).
   */
  async buildOrRefreshIndex(unmaskedSecretExceptions?: readonly string[]): Promise<{
    files: IndexedRepoFile[];
    rootMerkleHash: string;
    reparsedFiles: number;
    cacheHitFiles: number;
  }> {
    const secretScan = scanWorkspaceSecretsAndHardlinks(this.workspaceRoot, unmaskedSecretExceptions);
    const cachedRows = this.stateDb.db
      .prepare(`SELECT * FROM merkle_repo_files`)
      .all() as Array<{
      rel_path: string;
      language: string;
      size: number;
      mtime_ms: number;
      content_sha256: string;
      symbols_json: string;
      refs_json: string;
    }>;

    const cachedByPath = new Map(cachedRows.map((r) => [r.rel_path, r]));
    const discoveredFiles: Array<{
      relPath: string;
      absPath: string;
      size: number;
      mtimeMs: number;
      grammar: { lang: string; wasmFile: string };
    }> = [];

    const walk = (absDir: string, relDir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(absDir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));

      for (const e of entries) {
        if (EXCLUDED_DIRS.has(e.name) || isSecretBasename(e.name)) continue;
        if (e.isSymbolicLink()) continue;

        const absPath = path.join(absDir, e.name);
        const relPath = relDir ? `${relDir}/${e.name}` : e.name;

        if (e.isDirectory()) {
          if (fs.existsSync(path.join(absPath, ".git"))) continue; // skip nested submodules
          walk(absPath, relPath);
          continue;
        }

        if (!e.isFile()) continue;
        const ext = path.extname(e.name).toLowerCase();
        const grammar = EXT_TO_GRAMMAR[ext];
        if (!grammar) continue;

        let st: fs.Stats;
        try {
          st = fs.lstatSync(absPath);
        } catch {
          continue;
        }
        if (st.size > 512 * 1024) continue; // skip generated bundles > 512 KiB
        if (secretScan.secretInodeKeys.has(`${st.dev}:${st.ino}`)) continue;

        discoveredFiles.push({
          relPath,
          absPath,
          size: st.size,
          mtimeMs: Math.trunc(st.mtimeMs),
          grammar
        });
      }
    };

    walk(this.workspaceRoot, "");

    const activePaths = new Set<string>();
    const indexedFiles: IndexedRepoFile[] = [];
    let reparsedFiles = 0;
    let cacheHitFiles = 0;

    const upsertStmt = this.stateDb.db.prepare(`
      INSERT INTO merkle_repo_files (
        rel_path, language, size, mtime_ms, content_sha256, symbols_json, refs_json, updated_at_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(rel_path) DO UPDATE SET
        language = excluded.language,
        size = excluded.size,
        mtime_ms = excluded.mtime_ms,
        content_sha256 = excluded.content_sha256,
        symbols_json = excluded.symbols_json,
        refs_json = excluded.refs_json,
        updated_at_ms = excluded.updated_at_ms
    `);

    let parser: Parser | null = null;
    try {
      for (const f of discoveredFiles) {
        activePaths.add(f.relPath);
        const prev = cachedByPath.get(f.relPath);

        // Fast stat-level + content-SHA256 Merkle check
        if (prev && prev.size === f.size && prev.mtime_ms === f.mtimeMs) {
          cacheHitFiles += 1;
          indexedFiles.push({
            relPath: f.relPath,
            language: prev.language,
            size: prev.size,
            mtimeMs: prev.mtime_ms,
            contentSha256: prev.content_sha256,
            symbols: JSON.parse(prev.symbols_json) as RepoSymbolItem[],
            referencedIdentifiers: JSON.parse(prev.refs_json) as string[]
          });
          continue;
        }

        let rawBuf: Buffer;
        try {
          rawBuf = readWorkspaceFileSafe({
            workspaceRoot: this.workspaceRoot,
            candidatePath: f.relPath,
            unmaskedExceptions: unmaskedSecretExceptions
          });
        } catch {
          continue;
        }
        const contentSha256 = sha256Hex(rawBuf);
        if (prev && prev.content_sha256 === contentSha256) {
          cacheHitFiles += 1;
          upsertStmt.run(
            f.relPath,
            prev.language,
            f.size,
            f.mtimeMs,
            contentSha256,
            prev.symbols_json,
            prev.refs_json,
            Date.now()
          );
          indexedFiles.push({
            relPath: f.relPath,
            language: prev.language,
            size: f.size,
            mtimeMs: f.mtimeMs,
            contentSha256,
            symbols: JSON.parse(prev.symbols_json) as RepoSymbolItem[],
            referencedIdentifiers: JSON.parse(prev.refs_json) as string[]
          });
          continue;
        }

        // Parse changed/new file via real WASM Tree-Sitter grammar (Parser.init() guaranteed complete!)
        const langObj = await loadTreeSitterLanguage(f.grammar.wasmFile);
        if (!parser) {
          parser = new Parser();
        }
        parser.setLanguage(langObj);
        const srcText = rawBuf.toString("utf8");
        const tree = parser.parse(srcText);
        let extracted: { symbols: RepoSymbolItem[]; referencedIdentifiers: string[] };
        try {
          extracted = extractAstSymbolsAndRefs(tree.rootNode, srcText);
        } finally {
          tree.delete();
        }

        reparsedFiles += 1;
        const symbolsJson = JSON.stringify(extracted.symbols);
        const refsJson = JSON.stringify(extracted.referencedIdentifiers);
        upsertStmt.run(
          f.relPath,
          f.grammar.lang,
          f.size,
          f.mtimeMs,
          contentSha256,
          symbolsJson,
          refsJson,
          Date.now()
        );

        indexedFiles.push({
          relPath: f.relPath,
          language: f.grammar.lang,
          size: f.size,
          mtimeMs: f.mtimeMs,
          contentSha256,
          symbols: extracted.symbols,
          referencedIdentifiers: extracted.referencedIdentifiers
        });
      }
    } finally {
      if (parser) parser.delete();
    }

    // Prune deleted files from `merkle_repo_files`
    for (const oldPath of cachedByPath.keys()) {
      if (!activePaths.has(oldPath)) {
        this.stateDb.db.prepare(`DELETE FROM merkle_repo_files WHERE rel_path = ?`).run(oldPath);
      }
    }

    // Roll up bottom-up directory Merkle hashes (`dirRel -> sha256(sorted child entries)`)
    const dirChildren = new Map<string, string[]>();
    dirChildren.set("", []);

    const ensureDir = (d: string) => {
      if (!dirChildren.has(d)) dirChildren.set(d, []);
      const parts = d.split("/").filter(Boolean);
      for (let i = 0; i < parts.length; i++) {
        const cur = parts.slice(0, i + 1).join("/");
        const par = i === 0 ? "" : parts.slice(0, i).join("/");
        if (!dirChildren.has(cur)) dirChildren.set(cur, []);
        if (!dirChildren.has(par)) dirChildren.set(par, []);
      }
    };

    for (const file of indexedFiles) {
      const dir = path.posix.dirname(file.relPath) === "." ? "" : path.posix.dirname(file.relPath);
      ensureDir(dir);
      dirChildren.get(dir)!.push(`F:${path.posix.basename(file.relPath)}:${file.contentSha256}`);
    }

    const sortedDirsDeepestFirst = Array.from(dirChildren.keys()).sort(
      (a, b) => b.split("/").filter(Boolean).length - a.split("/").filter(Boolean).length || b.localeCompare(a)
    );

    const dirHashes = new Map<string, string>();
    for (const d of sortedDirsDeepestFirst) {
      const entries = [...(dirChildren.get(d) ?? [])].sort();
      const digest = sha256Hex(entries.join("\n"));
      dirHashes.set(d, digest);
      if (d !== "") {
        const parent = path.posix.dirname(d) === "." ? "" : path.posix.dirname(d);
        dirChildren.get(parent)!.push(`D:${path.posix.basename(d)}:${digest}`);
      }
    }

    const nowMs = Date.now();
    this.stateDb.db.exec("BEGIN IMMEDIATE");
    try {
      this.stateDb.db.exec(`DELETE FROM merkle_repo_dirs`);
      const insDir = this.stateDb.db.prepare(
        `INSERT INTO merkle_repo_dirs (dir_rel_path, merkle_sha256, updated_at_ms) VALUES (?, ?, ?)`
      );
      for (const [d, h] of dirHashes.entries()) {
        insDir.run(d, h, nowMs);
      }
      this.stateDb.db.exec("COMMIT");
    } catch (err) {
      this.stateDb.db.exec("ROLLBACK");
      throw err;
    }

    return {
      files: indexedFiles,
      rootMerkleHash: dirHashes.get("") ?? sha256Hex(""),
      reparsedFiles,
      cacheHitFiles
    };
  }

  /**
   * Computes PageRank call-graph centrality + identifier-split BM25 lexical relevance
   * and renders a token-bounded (`countO200kTokens <= maxTokens`) repository symbol map.
   */
  async generateRepoMap(params?: {
    query?: string;
    focusFiles?: string[];
    maxTokens?: number;
  }): Promise<RepoMapResult> {
    const maxTokens = Math.max(128, Math.min(params?.maxTokens ?? 1024, 8192));
    const idx = await this.buildOrRefreshIndex();
    const files = idx.files;

    if (files.length === 0) {
      return {
        rootMerkleHash: idx.rootMerkleHash,
        totalIndexedFiles: 0,
        reparsedFiles: idx.reparsedFiles,
        cacheHitFiles: idx.cacheHitFiles,
        tokenCount: 0,
        rankedFiles: [],
        renderedMap: "# Repo-Map (0 source files indexed)"
      };
    }

    // 1. Build symbol definition index (`symbolName -> defining file indices`)
    const symbolDefs = new Map<string, number[]>();
    files.forEach((f, fIdx) => {
      for (const sym of f.symbols) {
        const arr = symbolDefs.get(sym.name) ?? [];
        if (arr.length < 8) arr.push(fIdx);
        symbolDefs.set(sym.name, arr);
      }
    });

    // 2. Damped PageRank over cross-file symbol reference graph (`callerFile -> calleeDefFile`)
    const n = files.length;
    const outEdges: number[][] = Array.from({ length: n }, () => []);
    for (let i = 0; i < n; i++) {
      const targets = new Set<number>();
      for (const refName of files[i].referencedIdentifiers) {
        const defs = symbolDefs.get(refName);
        if (!defs) continue;
        for (const targetIdx of defs) {
          if (targetIdx !== i) targets.add(targetIdx);
        }
      }
      outEdges[i] = Array.from(targets);
    }

    let ranks = new Float64Array(n).fill(1 / n);
    const damping = 0.85;
    for (let iter = 0; iter < 15; iter++) {
      const next = new Float64Array(n).fill((1 - damping) / n);
      let danglingMass = 0;
      for (let i = 0; i < n; i++) {
        const outs = outEdges[i];
        if (outs.length === 0) {
          danglingMass += ranks[i];
        } else {
          const share = (damping * ranks[i]) / outs.length;
          for (const tgt of outs) {
            next[tgt] += share;
          }
        }
      }
      if (danglingMass > 0) {
        const add = (damping * danglingMass) / n;
        for (let j = 0; j < n; j++) next[j] += add;
      }
      ranks = next;
    }

    // 3. Identifier-split BM25 lexical scoring when `query` is provided
    const queryTokens = params?.query ? splitIdentifierTokens(params.query) : [];
    const focusSet = new Set((params?.focusFiles ?? []).map((p) => p.replace(/\\/g, "/").replace(/^\.\//, "")));

    const docTokenFreqs: Array<Map<string, number>> = files.map((f) => {
      const tf = new Map<string, number>();
      const rawDoc = [f.relPath, ...f.symbols.map((s) => `${s.name} ${s.signature}`)].join(" ");
      for (const tok of splitIdentifierTokens(rawDoc)) {
        tf.set(tok, (tf.get(tok) ?? 0) + 1);
      }
      return tf;
    });

    const docFreq = new Map<string, number>();
    for (const tf of docTokenFreqs) {
      for (const tok of tf.keys()) {
        docFreq.set(tok, (docFreq.get(tok) ?? 0) + 1);
      }
    }

    const avgDocLen =
      docTokenFreqs.reduce((acc, tf) => acc + Array.from(tf.values()).reduce((a, b) => a + b, 0), 0) / n || 1;

    const scored = files.map((f, i) => {
      let bm25 = 0;
      if (queryTokens.length > 0) {
        const tf = docTokenFreqs[i];
        const docLen = Array.from(tf.values()).reduce((a, b) => a + b, 0) || 1;
        for (const qt of queryTokens) {
          const freq = tf.get(qt) ?? 0;
          if (freq === 0) continue;
          const df = docFreq.get(qt) ?? 1;
          const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5));
          const k1 = 1.2;
          const b = 0.75;
          bm25 += idf * ((freq * (k1 + 1)) / (freq + k1 * (1 - b + b * (docLen / avgDocLen))));
        }
      }

      const focusBoost = focusSet.has(f.relPath) ? 5.0 : 0;
      const centralityScore = ranks[i] * n;
      const combinedScore = Number((centralityScore + bm25 * 2.5 + focusBoost).toFixed(4));
      return {
        file: f,
        score: combinedScore
      };
    });

    scored.sort((a, b) => b.score - a.score || a.file.relPath.localeCompare(b.file.relPath));

    // 4. Pack top-ranked file blocks strictly inside `maxTokens` (`o200k_base`)
    const headerLine = `# Repo-Map (merkle=${idx.rootMerkleHash.slice(0, 12)}, files=${files.length})`;
    const blocks: string[] = [headerLine];
    let usedTokens = countO200kTokens(headerLine);

    for (const item of scored) {
      const symLines =
        item.file.symbols.length > 0
          ? item.file.symbols.slice(0, 20).map((s) => `  L${s.line}: ${s.signature}`)
          : [`  (module: ${item.file.language}, ${item.file.size}B)`];
      const candidateBlock = `\n${item.file.relPath}:\n${symLines.join("\n")}`;
      const blockTokens = countO200kTokens(candidateBlock);
      if (usedTokens + blockTokens > maxTokens) {
        if (blocks.length === 1) {
          // Always fit at least a truncated summary of the top file
          const minimal = `\n${item.file.relPath}:\n  ${symLines[0]}`;
          if (usedTokens + countO200kTokens(minimal) <= maxTokens) {
            blocks.push(minimal);
            usedTokens += countO200kTokens(minimal);
          }
        }
        break;
      }
      blocks.push(candidateBlock);
      usedTokens += blockTokens;
    }

    const renderedMap = blocks.join("");
    return {
      rootMerkleHash: idx.rootMerkleHash,
      totalIndexedFiles: files.length,
      reparsedFiles: idx.reparsedFiles,
      cacheHitFiles: idx.cacheHitFiles,
      tokenCount: countO200kTokens(renderedMap),
      rankedFiles: scored.map((s) => ({
        relPath: s.file.relPath,
        score: s.score,
        symbolCount: s.file.symbols.length
      })),
      renderedMap
    };
  }
}
