import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import type { GuardrailsConfig } from "../types.ts";

/**
 * Trusted host-compiled SHA-256 digest of `surfaces-immutable/GUARDRAILS.yaml`.
 * Stored in host source code (outside `<workspaceRoot>` and hidden inside `bwrap`),
 * NOT in a co-located writable `.sha256` file.
 */
export const COMPILED_GUARDRAILS_SHA256 =
  "3a01d91065a39b6d54df8e416207b1d71a9ae942617283e99e02f68b53bb7867" as const;

export class GuardrailPinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardrailPinError";
  }
}

export function getDefaultImmutableGuardrailsPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../surfaces-immutable/GUARDRAILS.yaml");
}

export function loadVerifiedGuardrails(
  guardrailsPath: string = getDefaultImmutableGuardrailsPath(),
  expectedSha256: string = COMPILED_GUARDRAILS_SHA256
): { config: GuardrailsConfig; sha256: string } {
  if (!fs.existsSync(guardrailsPath)) {
    throw new GuardrailPinError(`GUARDRAILS_MISSING: ${guardrailsPath}`);
  }
  const rawBytes = fs.readFileSync(guardrailsPath);
  const actualSha256 = crypto.createHash("sha256").update(rawBytes).digest("hex");
  if (actualSha256 !== expectedSha256) {
    throw new GuardrailPinError(
      `GUARDRAIL_PIN_MISMATCH: expected ${expectedSha256}, got ${actualSha256} for ${guardrailsPath}`
    );
  }
  const parsed = YAML.parse(rawBytes.toString("utf8")) as GuardrailsConfig;
  return { config: Object.freeze(parsed), sha256: actualSha256 };
}
