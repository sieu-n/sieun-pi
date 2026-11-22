// Reactions after idle gaps on a kept-alive connection, as tailscale serve sends them: one connection per lane through a keep-alive agent,
// each lane waiting its gap and then sending a reaction with no requestId, which a proxy does not send twice. A reset, a hang-up or a
// non-200 answer fails. Lanes wait 4 to 8 s (around Node's default 5 s close) and 10, 30, 60 and 89 s (below tailscale serve's 90 s).
// Usage: node idle-gaps.mjs <port> [rounds=2]; point it at a fixture server, for example
//   node --import tsx server/main.ts --fixture --port 5795 --listen 127.0.0.1 --data-dir <dir>
import { Agent, request } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";

const [portText, roundsText = "2"] = process.argv.slice(2);
const port = Number(portText);
const rounds = Number(roundsText);
const call = (method, path, body, agent = false) => new Promise(resolve => {
  const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  const req = request({ host: "127.0.0.1", port, path, method, agent, timeout: 20_000, headers: data ? { "content-type": "application/json", "content-length": data.length } : {} }, res => {
    let text = "";
    res.setEncoding("utf8");
    res.on("data", chunk => (text += chunk));
    res.on("end", () => resolve({ status: res.statusCode, text, reused: req.reusedSocket }));
  });
  req.on("timeout", () => req.destroy(new Error("no answer in 20 s")));
  req.on("error", error => resolve({ status: 0, text: error.code ?? error.message, reused: req.reusedSocket }));
  req.end(data);
});

const room = JSON.parse((await call("POST", "/api/rooms", { kind: "channel", name: `gaps-${Date.now()}`, members: [], test: true })).text);
const roomId = room.id ?? room.room?.id;
const sent = JSON.parse((await call("POST", `/api/c/${roomId}/send`, { text: "idle gap target", requestId: `gaps-${Date.now()}` })).text);
const postId = sent.item.id;
const gaps = [...Array.from({ length: 40 }, (_, i) => 4000 + i * 100), 10_000, 30_000, 60_000, 89_000];
const results = [];
const lane = async gap => {
  const agent = new Agent({ keepAlive: true, maxSockets: 1 });
  let on = true;
  for (let n = 0; n <= rounds; n++) {
    const answer = await call("POST", `/api/c/${roomId}/posts/${postId}/reactions`, { emoji: "eyes", on }, agent);
    if (n > 0) results.push({ gap, n, status: answer.status, reused: answer.reused, error: answer.status === 200 ? undefined : answer.text.slice(0, 80) });
    on = !on;
    if (n < rounds) await sleep(gap);
  }
  agent.destroy();
};
await Promise.all(gaps.map(lane));
const failed = results.filter(each => each.status !== 200);
const reused = results.filter(each => each.reused).length;
console.log(JSON.stringify({ port, calls: results.length, reused, failed: failed.length, failedGaps: failed.map(each => `${each.gap} ms: ${each.error}`), pass: failed.length === 0 }, null, 1));
process.exit(failed.length ? 1 : 0);
