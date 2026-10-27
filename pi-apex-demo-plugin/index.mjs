export function activate(api) {
  api.registerTool({
    name: "format_changelog",
    description: "Formats release bullets cleanly",
    execute: ({ version, items }) => ({
      heading: `## [${version || "3.9.0"}]`,
      bullets: (items || []).map((i) => `- ${i}`)
    })
  });
  api.registerCommand({
    name: "changelog",
    description: "Preview formatted changelog",
    execute: (arg) => `## Changelog (${arg || "v3.9.0"})`
  });
  api.registerGatewayAdapter({
    platform: "plugin:matrix",
    send: async (req) => ({ externalMessageId: "mtx_live_1", transportDetail: `matrix:${req.channelId}` })
  });
}
