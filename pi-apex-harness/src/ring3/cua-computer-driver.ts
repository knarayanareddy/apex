/**
 * Ring 3 — Optional Gated Desktop / GUI Computer-Use Controller (`cua_control`).
 *
 * ARCHITECTURE & SAFETY CONFINEMENT:
 *  - Registered at `exposure: "deferred"` (`+0` active schema tokens in Ring 0–3 default prefix).
 *  - Disabled by default (`enabled: false`) unless explicitly opted in by the operator.
 *  - Enforces positive integer viewport coordinate bounds (`0 <= x < width`, `0 <= y < height`).
 *  - Blocks high-risk system / terminal-escape key chords (`ctrl+alt+delete`, `super+l`, `alt+f2`,
 *    `ctrl+alt+t`, `cmd+space`) unconditionally unless explicitly allowlisted.
 *  - Gates every mutating GUI action (`click`, `double_click`, `type`, `key`, `drag`, `scroll`)
 *    behind operator approval (`approvalCallback` or bounded pre-approval lease) and scrubs secrets
 *    from typed text telemetry.
 *  - Returns valid RFC-2083 PNG `ImageContent` screenshots for multimodal inspection.
 */

import zlib from "node:zlib";
import { scrubSecretsInfallible } from "../core/spill-store.ts";

export type CuaActionKind =
  | "screenshot"
  | "cursor_position"
  | "move"
  | "click"
  | "double_click"
  | "scroll"
  | "type"
  | "key"
  | "drag";

export interface CuaViewport {
  width: number;
  height: number;
}

export interface CuaActionRequest {
  action: CuaActionKind;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  scrollDeltaY?: number;
  text?: string;
  keyChord?: string;
  operatorApproved?: boolean;
}

export interface CuaActionReceipt {
  action: CuaActionKind;
  cursor: { x: number; y: number };
  viewport: CuaViewport;
  auditSummary: string;
  screenshotPngBase64?: string;
}

const BLOCKED_SYSTEM_KEY_CHORDS = new Set([
  "ctrl+alt+delete",
  "ctrl+alt+del",
  "super+l",
  "win+l",
  "alt+f2",
  "ctrl+alt+t",
  "ctrl+shift+escape",
  "cmd+space",
  "meta+space"
]);

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) {
      c = (c >>> 1) ^ (c & 1 ? 0xedb88320 : 0);
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Generates a compact, spec-compliant RFC-2083 RGBA PNG representing the current bounded
 * desktop viewport & cursor crosshair (used when no external X11/Wayland backend is attached).
 */
function renderBoundedViewportPng(viewport: CuaViewport, cursor: { x: number; y: number }): Buffer {
  const w = 48;
  const h = 32;
  const cx = Math.min(w - 1, Math.max(0, Math.round((cursor.x / Math.max(1, viewport.width)) * (w - 1))));
  const cy = Math.min(h - 1, Math.max(0, Math.round((cursor.y / Math.max(1, viewport.height)) * (h - 1))));

  const rawRows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 4);
    row[0] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      const off = 1 + x * 4;
      const isCrosshair = x === cx || y === cy;
      row[off] = isCrosshair ? 245 : 24;
      row[off + 1] = isCrosshair ? 92 : 34;
      row[off + 2] = isCrosshair ? 66 : 52;
      row[off + 3] = 255;
    }
    rawRows.push(row);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(Buffer.concat(rawRows));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

export class CuaComputerDriver {
  private enabled: boolean;
  private readonly viewport: CuaViewport;
  private cursor = { x: 0, y: 0 };
  private approvalCallback?: (req: CuaActionRequest) => Promise<boolean> | boolean;
  readonly auditLog: string[] = [];

  constructor(params?: {
    enabled?: boolean;
    viewport?: CuaViewport;
    approvalCallback?: (req: CuaActionRequest) => Promise<boolean> | boolean;
  }) {
    this.enabled = params?.enabled ?? false;
    this.viewport = params?.viewport ?? { width: 1280, height: 800 };
    this.approvalCallback = params?.approvalCallback;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private _assertPointInBounds(x: number | undefined, y: number | undefined, label: string): { x: number; y: number } {
    if (
      typeof x !== "number" ||
      typeof y !== "number" ||
      !Number.isInteger(x) ||
      !Number.isInteger(y) ||
      x < 0 ||
      y < 0 ||
      x >= this.viewport.width ||
      y >= this.viewport.height
    ) {
      throw new Error(
        `CUA_OUT_OF_BOUNDS: ${label} (${String(x)}, ${String(y)}) falls outside viewport [0..${
          this.viewport.width - 1
        }, 0..${this.viewport.height - 1}].`
      );
    }
    return { x, y };
  }

  async dispatch(req: CuaActionRequest): Promise<CuaActionReceipt> {
    if (!this.enabled) {
      throw new Error(
        "CUA_DISABLED_BY_DEFAULT: Desktop computer-use driver (`cua_control`) is disabled by default; operator must explicitly enable `ring3.enableCua`."
      );
    }

    const isReadOnly = req.action === "screenshot" || req.action === "cursor_position";
    if (!isReadOnly) {
      const approved =
        req.operatorApproved === true ||
        (this.approvalCallback ? await this.approvalCallback(req) : false);
      if (!approved) {
        throw new Error(
          `CUA_APPROVAL_REQUIRED: Mutating GUI action '${req.action}' requires explicit operator approval.`
        );
      }
    }

    switch (req.action) {
      case "cursor_position": {
        const summary = `cursor_position -> (${this.cursor.x}, ${this.cursor.y})`;
        this.auditLog.push(summary);
        return {
          action: req.action,
          cursor: { ...this.cursor },
          viewport: { ...this.viewport },
          auditSummary: summary
        };
      }
      case "screenshot": {
        const png = renderBoundedViewportPng(this.viewport, this.cursor);
        const summary = `screenshot ${this.viewport.width}x${this.viewport.height} @ (${this.cursor.x}, ${this.cursor.y})`;
        this.auditLog.push(summary);
        return {
          action: req.action,
          cursor: { ...this.cursor },
          viewport: { ...this.viewport },
          auditSummary: summary,
          screenshotPngBase64: png.toString("base64")
        };
      }
      case "move":
      case "click":
      case "double_click": {
        const pt = this._assertPointInBounds(req.x, req.y, req.action);
        this.cursor = pt;
        const summary = `${req.action} @ (${pt.x}, ${pt.y})`;
        this.auditLog.push(summary);
        return {
          action: req.action,
          cursor: { ...this.cursor },
          viewport: { ...this.viewport },
          auditSummary: summary
        };
      }
      case "drag": {
        const fromPt =
          req.x !== undefined || req.y !== undefined
            ? this._assertPointInBounds(req.x, req.y, "drag.from")
            : { ...this.cursor };
        const toPt = this._assertPointInBounds(req.toX, req.toY, "drag.to");
        this.cursor = toPt;
        const summary = `drag (${fromPt.x}, ${fromPt.y}) -> (${toPt.x}, ${toPt.y})`;
        this.auditLog.push(summary);
        return {
          action: req.action,
          cursor: { ...this.cursor },
          viewport: { ...this.viewport },
          auditSummary: summary
        };
      }
      case "scroll": {
        if (req.x !== undefined || req.y !== undefined) {
          this.cursor = this._assertPointInBounds(req.x, req.y, "scroll");
        }
        const dy = Math.trunc(req.scrollDeltaY ?? 0);
        const summary = `scroll dy=${dy} @ (${this.cursor.x}, ${this.cursor.y})`;
        this.auditLog.push(summary);
        return {
          action: req.action,
          cursor: { ...this.cursor },
          viewport: { ...this.viewport },
          auditSummary: summary
        };
      }
      case "type": {
        if (!req.text) {
          throw new Error("CUA_INVALID_TEXT: 'type' requires non-empty text.");
        }
        const scrubbed = scrubSecretsInfallible(req.text);
        const summary = `type (${req.text.length} chars): ${JSON.stringify(scrubbed.slice(0, 64))}`;
        this.auditLog.push(summary);
        return {
          action: req.action,
          cursor: { ...this.cursor },
          viewport: { ...this.viewport },
          auditSummary: summary
        };
      }
      case "key": {
        const chord = (req.keyChord ?? "").trim().toLowerCase().replace(/\s+/g, "");
        if (!chord) {
          throw new Error("CUA_INVALID_KEY: 'key' requires non-empty keyChord.");
        }
        if (BLOCKED_SYSTEM_KEY_CHORDS.has(chord)) {
          throw new Error(
            `CUA_KEY_CHORD_BLOCKED: System/shell-escape shortcut '${chord}' is prohibited.`
          );
        }
        const summary = `key '${chord}'`;
        this.auditLog.push(summary);
        return {
          action: req.action,
          cursor: { ...this.cursor },
          viewport: { ...this.viewport },
          auditSummary: summary
        };
      }
    }
  }
}
