import { fileURLToPath } from "node:url";

/**
 * Real stdio `Content-Length` JSON-RPC 2.0 LSP server for deterministic Tier-B verification
 * of `LspClientManager` (all 9 OpenCode semantic operations + `publishDiagnostics` + `env` sanitization check!).
 */
interface DocEntry {
  uri: string;
  version: number;
  text: string;
}

const docs = new Map<string, DocEntry>();
let readBuf: Buffer = Buffer.alloc(0);

function sendFrame(payload: unknown): void {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  process.stdout.write(Buffer.concat([header, body]));
}

function analyzeAndPublishDiagnostics(uri: string, text: string): void {
  const diagnostics: Array<{
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
    severity: number;
    code: string;
    source: string;
    message: string;
  }> = [];

  const lines = text.split("\n");
  lines.forEach((ln, idx) => {
    const errIdx = ln.indexOf("TYPE_ERROR_MARKER");
    if (errIdx !== -1) {
      diagnostics.push({
        range: {
          start: { line: idx, character: errIdx },
          end: { line: idx, character: errIdx + "TYPE_ERROR_MARKER".length }
        },
        severity: 1,
        code: "TS2322",
        source: "pi-apex-ts-lsp",
        message: "Type 'string' is not assignable to type 'number' (TYPE_ERROR_MARKER)."
      });
    }
  });

  sendFrame({
    jsonrpc: "2.0",
    method: "textDocument/publishDiagnostics",
    params: { uri, diagnostics }
  });
}

function findSymbolDeclarations(uri: string, text: string) {
  const symbols: Array<{
    name: string;
    kind: number;
    line: number;
    character: number;
    uri: string;
  }> = [];

  const lines = text.split("\n");
  const declRe = /(?:export\s+)?(?:async\s+)?(?:function|class|interface|const)\s+([A-Za-z_][A-Za-z0-9_]*)/;
  lines.forEach((ln, idx) => {
    const m = ln.match(declRe);
    if (m) {
      const col = ln.indexOf(m[1]);
      symbols.push({
        name: m[1],
        kind: ln.includes("class ") ? 5 : ln.includes("interface ") ? 11 : 12,
        line: idx,
        character: Math.max(0, col),
        uri
      });
    }
  });
  return symbols;
}

function getWordAt(text: string, line: number, character: number): string {
  const ln = text.split("\n")[line] ?? "";
  let start = Math.min(character, ln.length);
  let end = start;
  while (start > 0 && /[A-Za-z0-9_]/.test(ln[start - 1])) start--;
  while (end < ln.length && /[A-Za-z0-9_]/.test(ln[end])) end++;
  return ln.slice(start, end);
}

function handleMessage(msg: {
  id?: number;
  method?: string;
  params?: Record<string, any>;
}): void {
  const { id, method, params } = msg;

  if (method === "initialize") {
    // Verify host secret env vars were NOT leaked into LSP subprocess!
    if (process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY) {
      sendFrame({
        jsonrpc: "2.0",
        id,
        error: { code: -32001, message: "HOST_SECRET_ENV_LEAKED_TO_LSP" }
      });
      return;
    }
    sendFrame({
      jsonrpc: "2.0",
      id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          definitionProvider: true,
          referencesProvider: true,
          hoverProvider: true,
          documentSymbolProvider: true,
          workspaceSymbolProvider: true,
          implementationProvider: true,
          callHierarchyProvider: true
        }
      }
    });
    return;
  }

  if (method === "initialized") return;

  if (method === "textDocument/didOpen") {
    const td = params?.textDocument;
    if (td?.uri && typeof td.text === "string") {
      docs.set(td.uri, { uri: td.uri, version: td.version ?? 1, text: td.text });
      analyzeAndPublishDiagnostics(td.uri, td.text);
    }
    return;
  }

  if (method === "textDocument/didChange") {
    const uri = params?.textDocument?.uri;
    const text = params?.contentChanges?.[0]?.text;
    if (uri && typeof text === "string") {
      docs.set(uri, { uri, version: params?.textDocument?.version ?? 2, text });
      analyzeAndPublishDiagnostics(uri, text);
    }
    return;
  }

  if (method === "shutdown") {
    sendFrame({ jsonrpc: "2.0", id, result: null });
    return;
  }

  if (method === "exit") {
    process.exit(0);
  }

  if (typeof id !== "number") return;

  const uri: string | undefined = params?.textDocument?.uri;
  const pos: { line: number; character: number } = params?.position ?? { line: 0, character: 0 };
  const curDoc = uri ? docs.get(uri) : undefined;

  if (method === "textDocument/definition" || method === "textDocument/implementation") {
    const targetWord = curDoc ? getWordAt(curDoc.text, pos.line, pos.character) : "";
    for (const d of docs.values()) {
      for (const s of findSymbolDeclarations(d.uri, d.text)) {
        if (s.name === targetWord) {
          sendFrame({
            jsonrpc: "2.0",
            id,
            result: [
              {
                uri: d.uri,
                range: {
                  start: { line: s.line, character: s.character },
                  end: { line: s.line, character: s.character + s.name.length }
                }
              }
            ]
          });
          return;
        }
      }
    }
    sendFrame({ jsonrpc: "2.0", id, result: [] });
    return;
  }

  if (method === "textDocument/references") {
    const targetWord = curDoc ? getWordAt(curDoc.text, pos.line, pos.character) : "";
    const refs: Array<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }> = [];
    if (targetWord) {
      const wordRe = new RegExp(`\\b${targetWord}\\b`, "g");
      for (const d of docs.values()) {
        d.text.split("\n").forEach((ln, lIdx) => {
          let m: RegExpExecArray | null;
          while ((m = wordRe.exec(ln)) !== null) {
            refs.push({
              uri: d.uri,
              range: {
                start: { line: lIdx, character: m.index },
                end: { line: lIdx, character: m.index + targetWord.length }
              }
            });
          }
        });
      }
    }
    sendFrame({ jsonrpc: "2.0", id, result: refs });
    return;
  }

  if (method === "textDocument/hover") {
    const targetWord = curDoc ? getWordAt(curDoc.text, pos.line, pos.character) : "";
    sendFrame({
      jsonrpc: "2.0",
      id,
      result: targetWord
        ? {
            contents: {
              kind: "markdown",
              value: `**Symbol** \`${targetWord}\` in \`${uri ? fileURLToPath(uri) : ""}\``
            }
          }
        : null
    });
    return;
  }

  if (method === "textDocument/documentSymbol") {
    const syms = curDoc ? findSymbolDeclarations(curDoc.uri, curDoc.text) : [];
    sendFrame({
      jsonrpc: "2.0",
      id,
      result: syms.map((s) => ({
        name: s.name,
        kind: s.kind,
        range: {
          start: { line: s.line, character: 0 },
          end: { line: s.line, character: s.character + s.name.length }
        },
        selectionRange: {
          start: { line: s.line, character: s.character },
          end: { line: s.line, character: s.character + s.name.length }
        }
      }))
    });
    return;
  }

  if (method === "workspace/symbol") {
    const q = String(params?.query ?? "").toLowerCase();
    const all: unknown[] = [];
    for (const d of docs.values()) {
      for (const s of findSymbolDeclarations(d.uri, d.text)) {
        if (!q || s.name.toLowerCase().includes(q)) {
          all.push({
            name: s.name,
            kind: s.kind,
            location: {
              uri: d.uri,
              range: {
                start: { line: s.line, character: s.character },
                end: { line: s.line, character: s.character + s.name.length }
              }
            }
          });
        }
      }
    }
    sendFrame({ jsonrpc: "2.0", id, result: all });
    return;
  }

  if (method === "textDocument/prepareCallHierarchy") {
    const targetWord = curDoc ? getWordAt(curDoc.text, pos.line, pos.character) : "fn";
    sendFrame({
      jsonrpc: "2.0",
      id,
      result: [
        {
          name: targetWord,
          kind: 12,
          uri: uri ?? "",
          range: { start: pos, end: { line: pos.line, character: pos.character + targetWord.length } },
          selectionRange: { start: pos, end: { line: pos.line, character: pos.character + targetWord.length } }
        }
      ]
    });
    return;
  }

  if (method === "callHierarchy/incomingCalls") {
    const itemName = String(params?.item?.name ?? "");
    const callers: unknown[] = [];
    for (const d of docs.values()) {
      d.text.split("\n").forEach((ln, idx) => {
        if (itemName && ln.includes(`${itemName}(`) && !ln.includes(`function ${itemName}`)) {
          callers.push({
            from: {
              name: "callerBlock",
              kind: 12,
              uri: d.uri,
              range: { start: { line: idx, character: 0 }, end: { line: idx, character: ln.length } },
              selectionRange: { start: { line: idx, character: 0 }, end: { line: idx, character: ln.length } }
            },
            fromRanges: [{ start: { line: idx, character: 0 }, end: { line: idx, character: ln.length } }]
          });
        }
      });
    }
    sendFrame({ jsonrpc: "2.0", id, result: callers });
    return;
  }

  if (method === "callHierarchy/outgoingCalls") {
    const itemUri = String(params?.item?.uri ?? "");
    const doc = docs.get(itemUri);
    const callees: unknown[] = [];
    if (doc) {
      const callRe = /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
      doc.text.split("\n").forEach((ln, idx) => {
        let m: RegExpExecArray | null;
        while ((m = callRe.exec(ln)) !== null) {
          if (m[1] !== "function" && m[1] !== "if" && m[1] !== params?.item?.name) {
            callees.push({
              to: {
                name: m[1],
                kind: 12,
                uri: doc.uri,
                range: { start: { line: idx, character: m.index }, end: { line: idx, character: m.index + m[1].length } },
                selectionRange: {
                  start: { line: idx, character: m.index },
                  end: { line: idx, character: m.index + m[1].length }
                }
              },
              fromRanges: [{ start: { line: idx, character: m.index }, end: { line: idx, character: m.index + m[1].length } }]
            });
          }
        }
      });
    }
    sendFrame({ jsonrpc: "2.0", id, result: callees });
    return;
  }

  sendFrame({ jsonrpc: "2.0", id, result: null });
}

process.stdin.on("data", (chunk: Buffer) => {
  readBuf = Buffer.concat([readBuf, chunk]);
  while (true) {
    const sep = readBuf.indexOf("\r\n\r\n");
    if (sep === -1) return;
    const hdr = readBuf.subarray(0, sep).toString("ascii");
    const m = hdr.match(/Content-Length:\s*(\d+)/i);
    if (!m) {
      readBuf = readBuf.subarray(sep + 4);
      continue;
    }
    const len = Number.parseInt(m[1], 10);
    if (readBuf.length < sep + 4 + len) return;
    const body = readBuf.subarray(sep + 4, sep + 4 + len).toString("utf8");
    readBuf = readBuf.subarray(sep + 4 + len);
    handleMessage(JSON.parse(body));
  }
});
