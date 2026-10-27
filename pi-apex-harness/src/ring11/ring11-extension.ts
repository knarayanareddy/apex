/** Ring 11 — Deferred speech specialist + zero-schema `/interaction` operator command. */
import type { TextContent } from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ExecutionModeController } from "./execution-mode-controller.ts";
import type { SpeechIoService } from "./speech-io.ts";
export const RING11_SLASH_COMMANDS = ["interaction"] as const;
export function createRing11Extension(bridge: { getSpeech: () => SpeechIoService; getInteraction: () => ExecutionModeController }): ExtensionFactory {
  return (pi) => {
    pi.registerTool({
      name: "speech_io", label: "Speech Input & Output", exposure: "deferred",
      description: "Inspect speech readiness, transcribe an explicitly provided audio payload, or synthesize explicitly provided text. No microphone access or arbitrary executable paths are available.",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("status"), Type.Literal("transcribe"), Type.Literal("synthesize")]),
        provider: Type.Optional(Type.Union([Type.Literal("cloud"), Type.Literal("local")])),
        audioBase64: Type.Optional(Type.String({ maxLength: 11_200_000 })),
        mimeType: Type.Optional(Type.String()),
        text: Type.Optional(Type.String({ maxLength: 12_000 }))
      }),
      async execute(_id, params) {
        let payload: unknown;
        if (params.action === "status") payload = bridge.getSpeech().getStatus();
        else if (params.action === "transcribe") {
          if (!params.audioBase64 || !params.mimeType) throw new Error("SPEECH_TRANSCRIBE_REQUIRES_AUDIO_AND_MIME");
          payload = await bridge.getSpeech().transcribe({ audioBase64: params.audioBase64, mimeType: params.mimeType, provider: params.provider });
        } else {
          if (typeof params.text !== "string") throw new Error("SPEECH_SYNTHESIZE_REQUIRES_TEXT");
          payload = await bridge.getSpeech().synthesize({ text: params.text, provider: params.provider });
        }
        const content:TextContent[]=[{type:"text",text:JSON.stringify(payload)}];
        return {content,details:payload};
      }
    });
    pi.registerCommand("interaction", {
      description: "Inspect or change session interaction profile and execution mode",
      handler: async (args, ctx) => {
        const parts=args.trim().split(/\s+/).filter(Boolean);
        if(parts[0]==="mode"&&parts[1]) bridge.getInteraction().setMode(parts[1] as any);
        if(parts[0]==="persona"&&parts[1]) bridge.getInteraction().setPersonaProfile(parts[1]);
        const st=bridge.getInteraction().getInteractionState();
        const md=`# Interaction Settings\n- **Mode:** ${st.mode}\n- **Persona:** ${st.persona}\n- **Build profile:** ${st.buildProfile}\n- **Pending approvals:** ${st.pending.length}`;
        if(ctx.hasUI)ctx.ui.notify(md,"info");
        pi.sendMessage({customType:"pi-apex-command",content:md,display:true,details:{command:"interaction",...st}},{triggerTurn:false});
      }
    });
  };
}
