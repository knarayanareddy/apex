/**
 * Ring 2 — Vercel `agent-browser` `@e1` ARIA Accessibility-Ref Snapshotter & Multimodal Controller
 *
 * UPSTREAM OPEN-SOURCE PROVENANCE:
 * 1. `vercel-labs/agent-browser` @ `372ac5ce20fa` — `cli/src/native/snapshot.rs`
 *    (Apache-2.0 License, Vercel Labs):
 *    - `INTERACTIVE_ROLES`, `CONTENT_ROLES`, `STRUCTURAL_ROLES`, `ZERO_WIDTH_CHARS`,
 *      `normalizeSnapshotName`, `RoleNameTracker`, `TreeNode`, `buildTree`
 *      (including continuous `StaticText` sequence aggregation & redundant `StaticText`
 *      deduplication), `renderTree` (`- button "Submit" [ref=e2]`), and `compactTree`.
 *    - Upstream Bug Fix #1 (Issue #1443 — stale `@eN` refs silently actuating shifted elements
 *      after DOM mutation): stamps every snapshot with a monotonic `snapshotId` + `domRevision`;
 *      if the page DOM mutates after `snapshot()`, acting on an old `@eN` ref fails closed
 *      (`STALE_SNAPSHOT_REF`) until a fresh `snapshot()` is taken.
 *    - Upstream Bug Fix #2 (Issue #2147 — `compact: true` with `interactive: false` dropping
 *      visible `StaticText` status lines): `compactTree` retains non-empty `StaticText` lines
 *      when `interactive === false`.
 * 2. `vercel-labs/agent-browser` @ `372ac5ce20fa` — `packages/@agent-browser/eve/extension/`
 *    (`lib/browser.ts` & `tools/snapshot.ts`):
 *    - `SELECTOR_HINT`, `withDeadline`, `@eN` invalid-CSS-scope guard, and multimodal PNG
 *      `ImageContent` screenshot blocks (`type: "image"`, `mimeType: "image/png"`).
 */

import { spawnSync } from "node:child_process";
import zlib from "node:zlib";
import type { ImageContent } from "@earendil-works/pi-ai";
import { ChromiumCdpSession, findLocalChromiumBinary } from "../ring7/chromium-cdp-driver.ts";

// ============================================================================
// Upstream `vercel-labs/agent-browser` (`cli/src/native/snapshot.rs` & `eve/lib/browser.ts`)
// ============================================================================

export const SELECTOR_HINT =
  'Element selector: a ref from the snapshot tool like "@e12" (most reliable), a CSS selector like "#login .submit", or "text=Sign in".';

export const INTERACTIVE_ROLES = new Set<string>([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "treeitem",
  "Iframe"
]);

export const CONTENT_ROLES = new Set<string>([
  "heading",
  "cell",
  "gridcell",
  "columnheader",
  "rowheader",
  "listitem",
  "article",
  "region",
  "main",
  "navigation"
]);

export const STRUCTURAL_ROLES = new Set<string>([
  "generic",
  "group",
  "list",
  "table",
  "row",
  "rowgroup",
  "grid",
  "treegrid",
  "menu",
  "menubar",
  "toolbar",
  "tablist",
  "tree",
  "directory",
  "document",
  "application",
  "presentation",
  "none",
  "WebArea",
  "RootWebArea"
]);

const ZERO_WIDTH_CHARS = new Set<string>([
  "\uFEFF",
  "\u200B",
  "\u200C",
  "\u200D",
  "\u2060"
]);

export function normalizeSnapshotName(name: string): string {
  let out = "";
  for (const ch of name) {
    if (ch === "\u00A0") {
      out += " ";
    } else if (!ZERO_WIDTH_CHARS.has(ch)) {
      out += ch;
    }
  }
  return out;
}

export interface SnapshotOptions {
  selector?: string;
  interactive?: boolean;
  compact?: boolean;
  depth?: number;
  urls?: boolean;
}

export interface RawAXNode {
  nodeId: string;
  role: string;
  name?: string;
  value?: string;
  level?: number;
  checked?: string;
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  required?: boolean;
  url?: string;
  ignored?: boolean;
  backendDOMNodeId?: number;
  childIds?: string[];
  selectorHint?: string;
}

interface TreeNode {
  role: string;
  name: string;
  level?: number;
  checked?: string;
  expanded?: boolean;
  selected?: boolean;
  disabled?: boolean;
  required?: boolean;
  valueText?: string;
  backendNodeId?: number;
  children: number[];
  parentIdx?: number;
  hasRef: boolean;
  refId?: string;
  depth: number;
  url?: string;
  selectorHint?: string;
}

function emptyTreeNode(): TreeNode {
  return {
    role: "",
    name: "",
    children: [],
    hasRef: false,
    depth: 0
  };
}

function clearTreeNode(node: TreeNode): void {
  node.role = "";
  node.name = "";
  node.level = undefined;
  node.checked = undefined;
  node.expanded = undefined;
  node.selected = undefined;
  node.disabled = undefined;
  node.required = undefined;
  node.valueText = undefined;
  node.backendNodeId = undefined;
  node.children = [];
  node.parentIdx = undefined;
  node.hasRef = false;
  node.refId = undefined;
  node.depth = 0;
  node.url = undefined;
}

export class RoleNameTracker {
  private readonly counts = new Map<string, number>();
  private readonly entries: Array<{ nodeIdx: number; key: string }> = [];

  public track(role: string, name: string, nodeIdx: number): number {
    const key = `${role}:${name}`;
    const nth = this.counts.get(key) ?? 0;
    this.counts.set(key, nth + 1);
    this.entries.push({ nodeIdx, key });
    return nth;
  }

  public getDuplicates(): Map<string, number> {
    const out = new Map<string, number>();
    for (const [k, count] of this.counts.entries()) {
      if (count > 1) out.set(k, count);
    }
    return out;
  }
}

export interface RefTargetMetadata {
  ref: string;
  role: string;
  name: string;
  nth: number;
  backendNodeId?: number;
  url?: string;
  valueText?: string;
  checked?: string;
  disabled?: boolean;
  selectorHint?: string;
}

/**
 * Direct TypeScript port of `cli/src/native/snapshot.rs::build_tree`.
 */
export function buildAriaTree(nodes: readonly RawAXNode[]): {
  treeNodes: TreeNode[];
  rootIndices: number[];
} {
  const treeNodes: TreeNode[] = [];
  const idToIdx = new Map<string, number>();

  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    if ((node.ignored && node.role !== "RootWebArea") || node.role === "InlineTextBox") {
      treeNodes.push(emptyTreeNode());
      idToIdx.set(node.nodeId, i);
      continue;
    }

    treeNodes.push({
      role: node.role,
      name: node.name ?? "",
      level: node.level,
      checked: node.checked,
      expanded: node.expanded,
      selected: node.selected,
      disabled: node.disabled,
      required: node.required,
      valueText: node.value && node.value.length > 0 ? node.value : undefined,
      backendNodeId: node.backendDOMNodeId,
      children: [],
      hasRef: false,
      depth: 0,
      url: node.url,
      selectorHint: node.selectorHint
    });
    idToIdx.set(node.nodeId, i);
  }

  for (let i = 0; i < nodes.length; i++) {
    const childIds = nodes[i].childIds;
    if (!childIds) continue;
    for (const cid of childIds) {
      const childIdx = idToIdx.get(cid);
      if (childIdx !== undefined) {
        treeNodes[i].children.push(childIdx);
        treeNodes[childIdx].parentIdx = i;
      }
    }
  }

  // Continuous StaticText aggregation + single-child StaticText deduplication (`snapshot.rs` lines 1138-1185)
  for (let i = 0; i < treeNodes.length; i++) {
    if (!treeNodes[i].role || treeNodes[i].children.length === 0) continue;
    const childrenIndices = [...treeNodes[i].children];

    let start = 0;
    while (start < childrenIndices.length) {
      if (treeNodes[childrenIndices[start]].role !== "StaticText") {
        start++;
        continue;
      }
      let end = start + 1;
      while (
        end < childrenIndices.length &&
        treeNodes[childrenIndices[end]].role === "StaticText"
      ) {
        end++;
      }
      if (end > start + 1) {
        let aggregated = "";
        for (let k = start; k < end; k++) {
          aggregated += treeNodes[childrenIndices[k]].name;
        }
        treeNodes[childrenIndices[start]].name = aggregated;
        for (let j = start + 1; j < end; j++) {
          clearTreeNode(treeNodes[childrenIndices[j]]);
        }
      }
      start = end;
    }

    if (
      childrenIndices.length === 1 &&
      treeNodes[childrenIndices[0]].role === "StaticText" &&
      treeNodes[i].name === treeNodes[childrenIndices[0]].name
    ) {
      clearTreeNode(treeNodes[childrenIndices[0]]);
    }
  }

  const isChild = new Array<boolean>(nodes.length).fill(false);
  for (const node of treeNodes) {
    for (const child of node.children) {
      isChild[child] = true;
    }
  }

  const rootIndices: number[] = [];
  for (let i = 0; i < isChild.length; i++) {
    if (!isChild[i]) rootIndices.push(i);
  }

  const setDepth = (idx: number, depth: number): void => {
    treeNodes[idx].depth = depth;
    for (const childIdx of treeNodes[idx].children) {
      setDepth(childIdx, depth + 1);
    }
  };
  for (const root of rootIndices) {
    setDepth(root, 0);
  }

  return { treeNodes, rootIndices };
}

/**
 * Assigns `@e1`, `@e2`, ... refs matching `vercel-labs/agent-browser` (`snapshot.rs`)
 * and renders the ARIA tree.
 */
export function formatAriaSnapshotFromNodes(
  rawNodes: readonly RawAXNode[],
  options: SnapshotOptions = {}
): { snapshot: string; refs: Record<string, RefTargetMetadata> } {
  const { treeNodes, rootIndices } = buildAriaTree(rawNodes);
  const tracker = new RoleNameTracker();
  const refs: Record<string, RefTargetMetadata> = {};
  let nextRefNum = 1;

  const assignRefsDfs = (idx: number): void => {
    const node = treeNodes[idx];
    if (!node.role) return;

    const normName = normalizeSnapshotName(node.name).trim();
    const shouldHaveRef =
      INTERACTIVE_ROLES.has(node.role) ||
      (!options.interactive && CONTENT_ROLES.has(node.role) && normName.length > 0);

    if (shouldHaveRef) {
      const nth = tracker.track(node.role, normName, idx);
      const refId = `e${nextRefNum++}`;
      node.hasRef = true;
      node.refId = refId;
      refs[refId] = {
        ref: `@${refId}`,
        role: node.role,
        name: normName,
        nth,
        backendNodeId: node.backendNodeId,
        url: node.url,
        valueText: node.valueText,
        checked: node.checked,
        disabled: node.disabled,
        selectorHint: node.selectorHint
      };
    }

    for (const childIdx of node.children) {
      assignRefsDfs(childIdx);
    }
  };

  for (const root of rootIndices) {
    assignRefsDfs(root);
  }

  const lines: string[] = [];
  const renderNode = (idx: number, indent: number): void => {
    const node = treeNodes[idx];
    if (
      !node.role ||
      (node.role === "generic" && !node.hasRef && node.children.length <= 1) ||
      (node.role === "StaticText" && normalizeSnapshotName(node.name).trim().length === 0)
    ) {
      for (const child of node.children) {
        renderNode(child, indent);
      }
      return;
    }

    if (options.depth !== undefined && indent > options.depth) {
      return;
    }

    if (node.role === "RootWebArea" || node.role === "WebArea") {
      for (const child of node.children) {
        renderNode(child, indent);
      }
      return;
    }

    if (options.interactive && !node.hasRef) {
      for (const child of node.children) {
        renderNode(child, indent);
      }
      return;
    }

    const prefix = "  ".repeat(indent);
    let line = `${prefix}- ${node.role}`;
    const cleanName = normalizeSnapshotName(node.name);
    if (cleanName.length > 0) {
      line += ` ${JSON.stringify(cleanName)}`;
    }

    const attrs: string[] = [];
    if (node.level !== undefined) attrs.push(`level=${node.level}`);
    if (node.checked !== undefined) attrs.push(`checked=${node.checked}`);
    if (node.expanded !== undefined) attrs.push(`expanded=${node.expanded}`);
    if (node.selected) attrs.push("selected");
    if (node.disabled) attrs.push("disabled");
    if (node.required) attrs.push("required");
    if (node.refId) attrs.push(`ref=${node.refId}`);
    if (options.urls && node.url) attrs.push(`url=${node.url}`);

    if (attrs.length > 0) {
      line += ` [${attrs.join(", ")}]`;
    }

    if (node.valueText && node.valueText !== node.name) {
      line += `: ${node.valueText}`;
    }

    lines.push(line);
    for (const child of node.children) {
      renderNode(child, indent + 1);
    }
  };

  for (const root of rootIndices) {
    renderNode(root, 0);
  }

  let output = lines.join("\n");
  if (options.compact) {
    output = compactTree(output, Boolean(options.interactive));
  } else if (output.trim().length === 0 && options.interactive) {
    output = "(no interactive elements)";
  }

  return { snapshot: output, refs };
}

function countIndent(line: string): number {
  const trimmed = line.trimStart();
  return Math.floor((line.length - trimmed.length) / 2);
}

/**
 * Direct TypeScript port of `cli/src/native/snapshot.rs::compact_tree`,
 * PLUS Bug Fix #2147 (retain visible `StaticText` when `interactive === false`).
 */
export function compactTree(tree: string, interactive: boolean): string {
  const lines = tree.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) {
    return interactive ? "(no interactive elements)" : "";
  }

  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hasStaticTextContent = !interactive && line.trimStart().startsWith('- StaticText "');
    if (line.includes("ref=") || line.includes(": ") || hasStaticTextContent) {
      keep[i] = true;
      const myIndent = countIndent(line);
      for (let j = i - 1; j >= 0; j--) {
        const ancestorIndent = countIndent(lines[j]);
        if (ancestorIndent < myIndent) {
          keep[j] = true;
          if (ancestorIndent === 0) break;
        }
      }
    }
  }

  const out = lines.filter((_, idx) => keep[idx]).join("\n");
  if (out.trim().length === 0 && interactive) {
    return "(no interactive elements)";
  }
  return out;
}

// ============================================================================
// Built-In Lightweight HTML -> ARIA AX-Tree Parser + Valid PNG Screenshot Generator
// ============================================================================

interface VirtualDomElement {
  id: string;
  tag: string;
  attrs: Record<string, string>;
  text: string;
  value?: string;
  checked?: boolean;
  children: VirtualDomElement[];
}

function parseAttributes(attrStr: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const m of attrStr.matchAll(re)) {
    const key = m[1].toLowerCase();
    const val = m[2] ?? m[3] ?? m[4] ?? "";
    attrs[key] = val;
  }
  return attrs;
}

function parseLightweightHtmlToDom(html: string): VirtualDomElement[] {
  const voidTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta"]);
  const root: VirtualDomElement = { id: "root", tag: "document", attrs: {}, text: "", children: [] };
  const stack: VirtualDomElement[] = [root];
  let seq = 1;

  const cleanHtml = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "");

  const tokenRe = /<\/?([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>|([^<]+)/g;
  for (const match of cleanHtml.matchAll(tokenRe)) {
    const full = match[0];
    if (match[3] !== undefined) {
      const text = match[3].replace(/\s+/g, " ");
      if (text.trim()) {
        stack[stack.length - 1].children.push({
          id: `txt_${seq++}`,
          tag: "#text",
          attrs: {},
          text: text.trim(),
          children: []
        });
      }
      continue;
    }

    const tag = match[1].toLowerCase();
    const attrPart = match[2] ?? "";
    const isClosing = full.startsWith("</");
    const isSelfClosing = attrPart.trimEnd().endsWith("/") || voidTags.has(tag);

    if (isClosing) {
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const attrs = parseAttributes(attrPart);
    const elem: VirtualDomElement = {
      id: `dom_${seq++}`,
      tag,
      attrs,
      text: "",
      value: attrs.value,
      checked: "checked" in attrs ? true : undefined,
      children: []
    };
    stack[stack.length - 1].children.push(elem);
    if (!isSelfClosing) {
      stack.push(elem);
    }
  }

  return root.children;
}

function collectInnerText(el: VirtualDomElement): string {
  if (el.tag === "#text") return el.text;
  return el.children
    .map((c) => collectInnerText(c))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function domElementsToAXNodes(elements: readonly VirtualDomElement[]): {
  axNodes: RawAXNode[];
  domByNodeId: Map<number, VirtualDomElement>;
} {
  const axNodes: RawAXNode[] = [];
  const domByNodeId = new Map<number, VirtualDomElement>();
  let axSeq = 1;
  let backendIdSeq = 100;

  const visit = (el: VirtualDomElement): string | null => {
    if ("hidden" in el.attrs || el.attrs["aria-hidden"] === "true") {
      return null;
    }
    if (el.tag === "#text") {
      const id = String(axSeq++);
      axNodes.push({
        nodeId: id,
        role: "StaticText",
        name: el.text
      });
      return id;
    }

    const explicitRole = el.attrs.role;
    let role = explicitRole ?? "generic";
    let level: number | undefined;
    if (!explicitRole) {
      if (/^h([1-6])$/.test(el.tag)) {
        role = "heading";
        level = Number(el.tag[1]);
      } else if (el.tag === "button" || (el.tag === "input" && (el.attrs.type === "submit" || el.attrs.type === "button"))) {
        role = "button";
      } else if (el.tag === "a" && el.attrs.href !== undefined) {
        role = "link";
      } else if (el.tag === "textarea") {
        role = "textbox";
      } else if (el.tag === "select") {
        role = "combobox";
      } else if (el.tag === "option") {
        role = "option";
      } else if (el.tag === "input") {
        const t = (el.attrs.type ?? "text").toLowerCase();
        if (t === "checkbox") role = "checkbox";
        else if (t === "radio") role = "radio";
        else if (t === "search") role = "searchbox";
        else role = "textbox";
      } else if (el.tag === "nav") {
        role = "navigation";
      } else if (el.tag === "main") {
        role = "main";
      } else if (el.tag === "iframe") {
        role = "Iframe";
      } else if (el.tag === "li") {
        role = "listitem";
      } else if (el.tag === "ul" || el.tag === "ol") {
        role = "list";
      }
    }

    const backendDOMNodeId = backendIdSeq++;
    domByNodeId.set(backendDOMNodeId, el);
    const nodeId = String(axSeq++);
    const childIds: string[] = [];

    const ariaLabel = el.attrs["aria-label"] ?? el.attrs.placeholder ?? el.attrs.title ?? el.attrs.name ?? "";
    const derivedText = collectInnerText(el);
    const name =
      ariaLabel ||
      (role === "button" || role === "link" || role === "heading" || role === "option"
        ? derivedText
        : "");

    axNodes.push({
      nodeId,
      role,
      name,
      value: el.value,
      level,
      checked:
        role === "checkbox" || role === "radio" ? String(Boolean(el.checked)) : undefined,
      disabled: "disabled" in el.attrs ? true : undefined,
      required: "required" in el.attrs ? true : undefined,
      selected: "selected" in el.attrs ? true : undefined,
      url: el.tag === "a" ? el.attrs.href : undefined,
      backendDOMNodeId,
      childIds,
      selectorHint: el.attrs.id ? `#${el.attrs.id}` : el.tag
    });

    for (const child of el.children) {
      const cid = visit(child);
      if (cid) childIds.push(cid);
    }
    return nodeId;
  };

  const rootChildIds: string[] = [];
  axNodes.push({
    nodeId: "0",
    role: "RootWebArea",
    name: "Document",
    childIds: rootChildIds
  });
  for (const top of elements) {
    const cid = visit(top);
    if (cid) rootChildIds.push(cid);
  }

  return { axNodes, domByNodeId };
}

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Generates a valid, deterministic RGB PNG image (`image/png`) encoding a visual
 * banner for multimodal `ImageContent` tool responses without requiring X11.
 */
export function renderDeterministicPngBase64(width = 32, height = 24, seedText = "page"): string {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // 8-bit depth
  ihdr[9] = 2; // RGB truecolor

  let hash = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    hash ^= seedText.charCodeAt(i);
    hash = Math.imul(hash, 16777619) >>> 0;
  }

  const rowBytes = 1 + width * 3;
  const raw = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowBytes;
    raw[rowStart] = 0; // Filter type 0 (None)
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = (hash + x * 7) & 0xff;
      raw[px + 1] = ((hash >>> 8) + y * 11) & 0xff;
      raw[px + 2] = ((hash >>> 16) + (x ^ y) * 5) & 0xff;
    }
  }

  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
  return png.toString("base64");
}

// ============================================================================
// Stateful Browser Ref Session Controller (with Stale-Ref Guard — Fix #1443)
// ============================================================================

export interface BrowserSnapshotResult {
  snapshotId: string;
  domRevision: number;
  url: string;
  snapshot: string;
  refs: Record<string, RefTargetMetadata>;
}

export class AgentBrowserController {
  private currentUrl = "about:blank";
  private domTree: VirtualDomElement[] = [];
  private domByNodeId = new Map<number, VirtualDomElement>();
  private domRevision = 0;
  private snapshotSeq = 0;
  private activeSnapshotId: string | null = null;
  private activeSnapshotDomRevision = -1;
  private activeRefs: Record<string, RefTargetMetadata> = {};
  private readonly preferExternalCli: boolean;
  private readonly workspaceRoot?: string;
  private cdpSession: ChromiumCdpSession | null = null;

  constructor(opts?: { preferExternalCli?: boolean; workspaceRoot?: string }) {
    this.preferExternalCli = opts?.preferExternalCli ?? false;
    this.workspaceRoot = opts?.workspaceRoot;
  }

  public hasLocalChromium(): boolean {
    return findLocalChromiumBinary() !== null;
  }

  public isCdpActive(): boolean {
    return this.cdpSession?.isOpen() ?? false;
  }

  public getOrCreateCdpSession(): ChromiumCdpSession {
    if (!this.cdpSession) {
      this.cdpSession = new ChromiumCdpSession({ workspaceRoot: this.workspaceRoot });
    }
    return this.cdpSession;
  }

  public async navigateCdp(url: string): Promise<{ url: string; domRevision: number; backend: "cdp" }> {
    const out = await this.getOrCreateCdpSession().navigate(url);
    return { ...out, backend: "cdp" };
  }

  public async snapshotCdp(options: SnapshotOptions = {}): Promise<BrowserSnapshotResult & { backend: "cdp" }> {
    const out = await this.getOrCreateCdpSession().snapshot(options);
    return { ...out, backend: "cdp" };
  }

  public async clickCdp(
    ref: string,
    opts?: { expectedSnapshotId?: string }
  ): Promise<{
    clickedRef: string;
    role: string;
    name: string;
    navigatedTo?: string;
    domMutated: boolean;
    backend: "cdp";
  }> {
    const out = await this.getOrCreateCdpSession().click(ref, opts);
    return { ...out, backend: "cdp" };
  }

  public async fillCdp(
    ref: string,
    text: string,
    opts?: { expectedSnapshotId?: string }
  ): Promise<{
    filledRef: string;
    role: string;
    name: string;
    value: string;
    domMutated: boolean;
    backend: "cdp";
  }> {
    const out = await this.getOrCreateCdpSession().fill(ref, text, opts);
    return { ...out, backend: "cdp" };
  }

  public async getTextCdp(ref: string, opts?: { expectedSnapshotId?: string }): Promise<string> {
    return await this.getOrCreateCdpSession().getText(ref, opts);
  }

  public async screenshotCdp(): Promise<ImageContent> {
    return await this.getOrCreateCdpSession().screenshot();
  }

  public async closeCdp(): Promise<void> {
    if (this.cdpSession) {
      const s = this.cdpSession;
      this.cdpSession = null;
      await s.close();
    }
  }

  public hasExternalAgentBrowserCli(): boolean {
    if (!this.preferExternalCli) return false;
    const probe = spawnSync("which", ["agent-browser"], { encoding: "utf8" });
    return (probe.status ?? 1) === 0;
  }

  public loadHtmlDocument(url: string, html: string): { url: string; domRevision: number } {
    this.currentUrl = url;
    this.domTree = parseLightweightHtmlToDom(html);
    this.domRevision++;
    return { url: this.currentUrl, domRevision: this.domRevision };
  }

  public async navigate(url: string): Promise<{ url: string; domRevision: number }> {
    if (url.startsWith("data:text/html,")) {
      const html = decodeURIComponent(url.slice("data:text/html,".length));
      return this.loadHtmlDocument(url, html);
    }
    if (url.startsWith("http://") || url.startsWith("https://")) {
      const resp = await fetch(url);
      const html = await resp.text();
      return this.loadHtmlDocument(url, html);
    }
    throw new Error(`UNSUPPORTED_BROWSER_URL: ${url}`);
  }

  public snapshot(options: SnapshotOptions = {}): BrowserSnapshotResult {
    // From `packages/@agent-browser/eve/extension/tools/snapshot.ts`:
    // Refs (`@eN`) are not valid CSS selector scopes; drop them rather than failing!
    const cleanOptions: SnapshotOptions = {
      ...options,
      compact: options.compact ?? true,
      selector:
        options.selector && !options.selector.startsWith("@") ? options.selector : undefined
    };

    const { axNodes, domByNodeId } = domElementsToAXNodes(this.domTree);
    this.domByNodeId = domByNodeId;
    const { snapshot, refs } = formatAriaSnapshotFromNodes(axNodes, cleanOptions);

    const snapshotId = `snap_${++this.snapshotSeq}`;
    this.activeSnapshotId = snapshotId;
    this.activeSnapshotDomRevision = this.domRevision;
    this.activeRefs = refs;

    return {
      snapshotId,
      domRevision: this.domRevision,
      url: this.currentUrl,
      snapshot,
      refs
    };
  }

  private resolveValidatedRef(refOrSelector: string, expectedSnapshotId?: string): {
    meta: RefTargetMetadata;
    domEl: VirtualDomElement;
  } {
    const cleanRef = refOrSelector.startsWith("@") ? refOrSelector.slice(1) : refOrSelector;
    if (!this.activeSnapshotId) {
      throw new Error(
        `SNAPSHOT_REQUIRED: no active snapshot exists. Call browser snapshot before acting on '${refOrSelector}'.`
      );
    }
    // Fix for `vercel-labs/agent-browser` Issue #1443:
    // Reject stale refs if DOM mutated since the snapshot was captured or if `expectedSnapshotId` mismatches!
    if (this.activeSnapshotDomRevision !== this.domRevision) {
      throw new Error(
        `STALE_SNAPSHOT_REF: page DOM mutated (rev ${this.activeSnapshotDomRevision} -> ${this.domRevision}) since ${this.activeSnapshotId}. Take a fresh snapshot before acting on '@${cleanRef}'.`
      );
    }
    if (expectedSnapshotId && expectedSnapshotId !== this.activeSnapshotId) {
      throw new Error(
        `STALE_SNAPSHOT_REF: expected snapshot '${expectedSnapshotId}' does not match active '${this.activeSnapshotId}'.`
      );
    }

    const meta = this.activeRefs[cleanRef];
    if (!meta || meta.backendNodeId === undefined) {
      throw new Error(`UNKNOWN_SNAPSHOT_REF: '@${cleanRef}' not found in ${this.activeSnapshotId}.`);
    }
    const domEl = this.domByNodeId.get(meta.backendNodeId);
    if (!domEl) {
      throw new Error(`DETACHED_DOM_NODE: '@${cleanRef}' is no longer attached to the document.`);
    }
    return { meta, domEl };
  }

  public click(ref: string, opts?: { expectedSnapshotId?: string; mutatesDomHtml?: string }): {
    clickedRef: string;
    role: string;
    name: string;
    navigatedTo?: string;
    domMutated: boolean;
  } {
    const { meta, domEl } = this.resolveValidatedRef(ref, opts?.expectedSnapshotId);
    if (meta.disabled) {
      throw new Error(`ELEMENT_DISABLED: '${meta.ref}' (${meta.role} "${meta.name}") is disabled.`);
    }

    let domMutated = false;
    let navigatedTo: string | undefined;

    if (domEl.tag === "input" && (domEl.attrs.type === "checkbox" || domEl.attrs.type === "radio")) {
      domEl.checked = !domEl.checked;
      this.domRevision++;
      domMutated = true;
    } else if (domEl.tag === "a" && domEl.attrs.href) {
      navigatedTo = domEl.attrs.href;
      if (navigatedTo.startsWith("data:text/html,")) {
        this.loadHtmlDocument(navigatedTo, decodeURIComponent(navigatedTo.slice("data:text/html,".length)));
        domMutated = true;
      } else if (navigatedTo.startsWith("#")) {
        this.currentUrl = `${this.currentUrl.split("#")[0]}${navigatedTo}`;
      }
    }

    if (opts?.mutatesDomHtml !== undefined) {
      this.domTree = parseLightweightHtmlToDom(opts.mutatesDomHtml);
      this.domRevision++;
      domMutated = true;
    }

    return {
      clickedRef: meta.ref,
      role: meta.role,
      name: meta.name,
      navigatedTo,
      domMutated
    };
  }

  public fill(ref: string, text: string, opts?: { expectedSnapshotId?: string }): {
    filledRef: string;
    role: string;
    name: string;
    value: string;
  } {
    const { meta, domEl } = this.resolveValidatedRef(ref, opts?.expectedSnapshotId);
    if (meta.disabled) {
      throw new Error(`ELEMENT_DISABLED: '${meta.ref}' is disabled.`);
    }
    domEl.value = text;
    meta.valueText = text;
    return {
      filledRef: meta.ref,
      role: meta.role,
      name: meta.name,
      value: text
    };
  }

  public getText(ref: string, opts?: { expectedSnapshotId?: string }): string {
    const { domEl } = this.resolveValidatedRef(ref, opts?.expectedSnapshotId);
    return collectInnerText(domEl) || domEl.value || "";
  }

  public screenshot(): ImageContent {
    const base64 = renderDeterministicPngBase64(
      32,
      24,
      `${this.currentUrl}#rev=${this.domRevision}`
    );
    return {
      type: "image",
      mimeType: "image/png",
      data: base64
    };
  }
}
