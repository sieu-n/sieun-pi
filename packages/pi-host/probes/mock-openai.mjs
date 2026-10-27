/**
 * A local OpenAI chat-completions endpoint for host probes. Each request streams `CHUNKS` text deltas, one every `GAP_MS`, then usage and
 * [DONE], so ten requests at once overlap for about `CHUNKS * GAP_MS`. It logs each request's body size to stderr.
 *
 *   node pi-host/probes/mock-openai.mjs <port> [chunks=60] [gapMs=40]
 */
import { createServer } from "node:http";

const port = Number(process.argv[2] ?? 0);
const CHUNKS = Number(process.argv[3] ?? 60);
const GAP_MS = Number(process.argv[4] ?? 40);
let requests = 0;

const server = createServer((req, res) => {
  let bytes = 0;
  req.on("data", chunk => { bytes += chunk.length; });
  req.on("end", async () => {
    const n = ++requests;
    process.stderr.write(`request ${n} ${req.method} ${req.url} body ${bytes} bytes\n`);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const base = { id: `mock-${n}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock-1" };
    for (let i = 0; i < CHUNKS; i++) {
      const delta = i === 0 ? { role: "assistant", content: "word " } : { content: `word${i} ` };
      res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      await new Promise(resolve => setTimeout(resolve, GAP_MS));
    }
    res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: Math.round(bytes / 4), completion_tokens: CHUNKS, total_tokens: Math.round(bytes / 4) + CHUNKS } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
server.listen(port, "127.0.0.1", () => process.stdout.write(`${server.address().port}\n`));
