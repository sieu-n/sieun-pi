import { createInterface } from "node:readline";
import { appendFileSync } from "node:fs";
// A stand-in for `cua-driver mcp`: logs every request it receives and answers with fixed data.
const log = process.env.FAKE_CUA_LOG;
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (log) appendFileSync(log, line + "\n");
  if (m.id === undefined) return;
  if (m.method === "tools/list") return send({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: "click", inputSchema: { type: "object", properties: { pid: { type: "integer" } } } }, { name: "list_apps", inputSchema: { type: "object", properties: {} } }] } });
  if (m.params?.name === "get_window_state") return send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ pid: 4242, window_id: 7, window_title: "New Message", elements: [
    { element_token: "s1:0", label: "Send", role: "AXButton", frame: { x: 10, y: 10, w: 40, h: 20 } },
    { element_token: "s1:1", label: "Archive", role: "AXButton", frame: { x: 60, y: 10, w: 40, h: 20 } },
  ] }) }] } });
  send({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "done " + m.params?.name }] } });
});
