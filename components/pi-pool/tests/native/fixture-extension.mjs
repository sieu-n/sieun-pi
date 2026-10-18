export default function (pi) {
  pi.registerTool({
    name: "fixture_echo",
    label: "Fixture echo",
    description: "Return the synthetic fixture marker.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return { content: [{ type: "text", text: "SYNTHETIC_TOOL_OK" }], details: {} };
    },
  });
}
