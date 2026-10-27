export type DurabilityMode = "crash-safe" | "power-loss-safe";

export type MutabilityClass = "PURE_READ" | "LOCAL_REVERSIBLE" | "OPAQUE_EXTERNAL";

export type WalStatus =
  | "INTENT_LOGGED"
  | "EXECUTING"
  | "EFFECT_COMMITTED_RAW"
  | "EFFECT_COMMITTED"
  | "TRANSCRIPT_APPENDED"
  | "OUTCOME_UNKNOWN"
  | "ABORTED_CLEAN"
  | "RESOLVED_BY_USER";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ApprovalPolicy = "untrusted" | "on-request" | "never";

export type GitObjectFormat = "sha1" | "sha256";

export interface GuardrailsConfig {
  version: string;
  sandbox: {
    default_mode: SandboxMode;
    unshare_network_by_default: boolean;
    clear_host_env: boolean;
    allowed_env_vars: string[];
    masked_workspace_globs: string[];
    unmasked_exceptions: string[];
    read_only_workspace_subpaths: string[];
  };
  shell_gate: {
    block_pipe_to_interpreters: string[];
    block_raw_network_tools: string[];
    block_proxy_bypass_flags: string[];
  };
  prefix_caps_o200k: {
    system_md: number;
    tool_guidance_md: number;
    memory_md: number;
    root_agents_md: number;
    direct_tool_schemas: number;
    total_max: number;
  };
  spill: {
    max_inline_bytes: number;
    max_inline_lines: number;
    preview_bytes: number;
    cleanup_days: number;
  };
}

export interface WalIntentRow {
  idempotency_key: string;
  session_id: string;
  leaf_id: string;
  tool_call_id: string;
  parent_tool_call_id: string | null;
  tool_name: string;
  mutability_class: MutabilityClass;
  target_path: string | null;
  before_content_sha256: string | null;
  after_content_sha256: string | null;
  canonical_args: string;
  status: WalStatus;
  raw_receipt_json: string | null;
  result_json: string | null;
  error_text: string | null;
  created_at_ms: number;
  updated_at_ms: number;
}
