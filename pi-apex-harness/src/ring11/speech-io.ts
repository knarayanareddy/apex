/** Ring 11 — Explicit-user-action speech transcription and synthesis adapters. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { OnboardingVault } from "../ring10/onboarding-vault.ts";

export const AUDIO_MIME_TYPES = ["audio/webm", "audio/ogg", "audio/wav", "audio/mpeg", "audio/mp4", "audio/aac"] as const;
const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_CHARS = 12_000;

function matchesAudioSignature(bytes: Buffer, mimeType: string): boolean {
  if (mimeType === "audio/wav") return bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE";
  if (mimeType === "audio/ogg") return bytes.length >= 4 && bytes.toString("ascii", 0, 4) === "OggS";
  if (mimeType === "audio/webm") return bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3;
  if (mimeType === "audio/mp4") return bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp";
  if (mimeType === "audio/mpeg") return bytes.length >= 2 && (bytes.toString("ascii", 0, 3) === "ID3" || (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0));
  if (mimeType === "audio/aac") return bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xf6) === 0xf0;
  return false;
}

export interface SpeechStatus {
  cloud: { configured: boolean; provider: "openai-compatible"; sttModel: string; ttsModel: string };
  local: { sttConfigured: boolean; ttsConfigured: boolean; note: string };
}

export class SpeechIoService {
  private opts: {
    vault: OnboardingVault;
    agentDir: string;
    cloudBaseUrl?: string;
    localSttBinary?: string;
    localSttModel?: string;
    localTtsBinary?: string;
    localTtsModel?: string;
  };
  constructor(opts: {
    vault: OnboardingVault;
    agentDir: string;
    cloudBaseUrl?: string;
    localSttBinary?: string;
    localSttModel?: string;
    localTtsBinary?: string;
    localTtsModel?: string;
  }) { this.opts = opts; }

  public getStatus(): SpeechStatus {
    return {
      cloud: {
        configured: Boolean(this.opts.vault.hasProviderKey("openai")),
        provider: "openai-compatible",
        sttModel: process.env.PI_APEX_STT_MODEL?.trim() || "whisper-1",
        ttsModel: process.env.PI_APEX_TTS_MODEL?.trim() || "gpt-4o-mini-tts"
      },
      local: {
        sttConfigured: Boolean(this.opts.localSttBinary && this.opts.localSttModel && fs.existsSync(this.opts.localSttBinary) && fs.existsSync(this.opts.localSttModel)),
        ttsConfigured: Boolean(this.opts.localTtsBinary && this.opts.localTtsModel && fs.existsSync(this.opts.localTtsBinary) && fs.existsSync(this.opts.localTtsModel)),
        note: "Optional whisper.cpp / Piper binaries and model files must be explicitly configured by the operator. No silent cloud fallback."
      }
    };
  }

  public async transcribe(input: { audioBase64: string; mimeType: string; provider?: "cloud" | "local" }): Promise<{ text: string; provider: string }> {
    const mimeType = input.mimeType.toLowerCase().split(";")[0]!.trim();
    if (!(AUDIO_MIME_TYPES as readonly string[]).includes(mimeType)) throw new Error("AUDIO_MIME_UNSUPPORTED");
    const data = Buffer.from(input.audioBase64, "base64");
    if (!data.length || data.length > MAX_AUDIO_BYTES || data.toString("base64").replace(/=+$/, "") !== input.audioBase64.replace(/=+$/, "")) throw new Error("AUDIO_PAYLOAD_INVALID_OR_TOO_LARGE");
    if (!matchesAudioSignature(data, mimeType)) throw new Error("AUDIO_CONTENT_MISMATCH: audio bytes do not match the declared MIME type.");
    if ((input.provider ?? "cloud") === "local") return { text: await this.localTranscribe(data, mimeType), provider: "local-whisper.cpp" };
    return { text: await this.cloudTranscribe(data, mimeType), provider: "cloud-openai-compatible" };
  }

  public async synthesize(input: { text: string; voice?: string; provider?: "cloud" | "local" }): Promise<{ audioBase64: string; mimeType: string; provider: string }> {
    const text = input.text.trim();
    if (!text || text.length > MAX_TEXT_CHARS) throw new Error("TTS_TEXT_EMPTY_OR_TOO_LONG");
    if ((input.provider ?? "cloud") === "local") {
      const bytes = await this.localSynthesize(text);
      return { audioBase64: bytes.toString("base64"), mimeType: "audio/wav", provider: "local-piper" };
    }
    const key = this.opts.vault.getProviderKeyForBackend("openai");
    if (!key) throw new Error("SPEECH_PROVIDER_NOT_CONFIGURED: save an OpenAI-compatible API key in Quick Setup.");
    const base = (this.opts.cloudBaseUrl ?? process.env.PI_APEX_OPENAI_AUDIO_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const response = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: process.env.PI_APEX_TTS_MODEL?.trim() || "gpt-4o-mini-tts", voice: input.voice || "alloy", input: text, response_format: "mp3" }),
      signal: AbortSignal.timeout(60_000)
    });
    if (!response.ok) throw new Error(`TTS_PROVIDER_ERROR: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("TTS_OUTPUT_INVALID_OR_TOO_LARGE");
    return { audioBase64: bytes.toString("base64"), mimeType: response.headers.get("content-type")?.split(";")[0] || "audio/mpeg", provider: "cloud-openai-compatible" };
  }

  private async cloudTranscribe(audio: Buffer, mimeType: string): Promise<string> {
    const key = this.opts.vault.getProviderKeyForBackend("openai");
    if (!key) throw new Error("SPEECH_PROVIDER_NOT_CONFIGURED: save an OpenAI-compatible API key in Quick Setup.");
    const base = (this.opts.cloudBaseUrl ?? process.env.PI_APEX_OPENAI_AUDIO_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    const form = new FormData();
    const ext = mimeType === "audio/wav" ? "wav" : mimeType === "audio/mpeg" ? "mp3" : mimeType === "audio/mp4" ? "m4a" : mimeType === "audio/aac" ? "aac" : mimeType === "audio/ogg" ? "ogg" : "webm";
    form.append("file", new Blob([audio], { type: mimeType }), `recording.${ext}`);
    form.append("model", process.env.PI_APEX_STT_MODEL?.trim() || "whisper-1");
    const response = await fetch(`${base}/audio/transcriptions`, { method: "POST", headers: { authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(90_000) });
    if (!response.ok) throw new Error(`STT_PROVIDER_ERROR: HTTP ${response.status}`);
    const json = await response.json() as { text?: string };
    const text = String(json.text ?? "").trim();
    if (!text || text.length > MAX_TEXT_CHARS) throw new Error("STT_EMPTY_OR_TOO_LONG");
    return text;
  }

  private async localTranscribe(audio: Buffer, mimeType: string): Promise<string> {
    if (!this.opts.localSttBinary || !this.opts.localSttModel) throw new Error("LOCAL_STT_UNAVAILABLE");
    const dir = fs.mkdtempSync(path.join(this.opts.agentDir, "speech-stt-")); fs.chmodSync(dir, 0o700);
    const ext = mimeType === "audio/wav" ? "wav" : mimeType === "audio/mpeg" ? "mp3" : "webm";
    const input = path.join(dir, `input.${ext}`); fs.writeFileSync(input, audio, { mode: 0o600 });
    try {
      const output = await this.spawnBounded(this.opts.localSttBinary, ["-m", this.opts.localSttModel, "-f", input, "-nt"], "", 90_000);
      const text = output.trim(); if (!text || text.length > MAX_TEXT_CHARS) throw new Error("LOCAL_STT_EMPTY_OR_TOO_LONG"); return text;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  private async localSynthesize(text: string): Promise<Buffer> {
    if (!this.opts.localTtsBinary || !this.opts.localTtsModel) throw new Error("LOCAL_TTS_UNAVAILABLE");
    const dir = fs.mkdtempSync(path.join(this.opts.agentDir, "speech-tts-")); fs.chmodSync(dir, 0o700);
    const outputFile = path.join(dir, "output.wav");
    try {
      await this.spawnBounded(this.opts.localTtsBinary, ["--model", this.opts.localTtsModel, "--output_file", outputFile], text, 90_000);
      const bytes = fs.readFileSync(outputFile); if (!bytes.length || bytes.length > 20 * 1024 * 1024) throw new Error("LOCAL_TTS_OUTPUT_INVALID"); return bytes;
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  }

  private spawnBounded(binary: string, args: string[], stdin: string, timeoutMs: number): Promise<string> {
    if (!path.isAbsolute(binary)) throw new Error("LOCAL_SPEECH_BINARY_MUST_BE_ABSOLUTE");
    const child = spawn(binary, args, { env: { PATH: "/usr/bin:/bin", HOME: this.opts.agentDir }, stdio: ["pipe", "pipe", "pipe"], shell: false });
    let out = "", err = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (s: string) => { out = (out + s).slice(-MAX_TEXT_CHARS * 2); });
    child.stderr.on("data", (s: string) => { err = (err + s).slice(-4000); });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs); timer.unref?.();
    return new Promise((resolve, reject) => {
      child.once("error", (e) => { clearTimeout(timer); reject(new Error(`LOCAL_SPEECH_EXEC_FAILED: ${e.message}`)); });
      child.once("close", (code) => { clearTimeout(timer); if (code === 0) resolve(out); else reject(new Error(`LOCAL_SPEECH_EXIT_${code}: ${err.slice(0, 1000)}`)); });
      child.stdin.on("error", (e) => { if ((e as NodeJS.ErrnoException).code !== "EPIPE") { clearTimeout(timer); reject(new Error(`LOCAL_SPEECH_STDIN_FAILED: ${e.message}`)); } });
      child.stdin.end(stdin);
    });
  }
}
