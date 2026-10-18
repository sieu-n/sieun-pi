// Times a send to a scratch thread through the live chat service, the way the page does it: POST api/threads/<id>/prompt, then the
// api/ws thread feed. It logs every feed frame with its size to a jsonl file and prints, per send, the ms to the HTTP answer, to the user
// message in the feed, to the first assistant token and to agent_end. Run it on the chat's box (it reads the service's configuration.json):
//   node components/user-history/scripts/latency-probe.mjs --host=mac|box [--sends=3] [--model=anthropic/claude-opus-5-5] [--thinking=off]
//     [--long] [--imgs=<dir of png> --imgs-per-send=2] [--id=<thread id>] [--open-only] [--out=<file.jsonl>]
// Without --id it creates a thread named "latency-probe <host> <time>" and archives it on exit (--keep leaves it). 10-18: a 9.9 MB attach snapshot over a
// ~0.43 MB/s Mac relay made frontend bro's attaches time out at 30 s, and its owner sends never left the box.
import { readFileSync, appendFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? "1"]));
const cfg = JSON.parse(readFileSync(`${homedir()}/.prime/agent/browser-chat/configuration.json`, "utf8"));
const origin = `http://127.0.0.1:${cfg.port}`;
const base = `${origin}/${cfg.capability}/`;
const out = args.out ?? `/tmp/latency-probe-${Date.now()}.jsonl`;
const now = () => performance.now();
const T0 = Date.now() - now();
const log = (o) => appendFileSync(out, JSON.stringify({ t: now(), wall: new Date(T0 + now()).toISOString(), ...o }) + "\n");

async function post(route, body, timeout = 180000) {
  const t = now();
  const res = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Token": cfg.csrfToken, Origin: origin }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeout) });
  const text = await res.text();
  log({ kind: "http", route, status: res.status, ms: now() - t, body: text.slice(0, 300) });
  if (!res.ok) throw new Error(`${route} ${res.status} ${text}`);
  return JSON.parse(text);
}

const ws = new WebSocket(`${base.replace("http", "ws")}api/ws?token=${cfg.csrfToken}`, { headers: { Origin: origin }, perMessageDeflate: true });
let listeners = [];
ws.on("message", (data, isBinary) => {
  const raw = data.toString();
  let frame; try { frame = JSON.parse(raw); } catch { return; }
  const t = now();
  for (const l of listeners) l(frame, raw.length, t);
});
await new Promise((ok, bad) => { ws.once("open", ok); ws.once("error", bad); });
log({ kind: "ws-open" });

function waitFor(pred, timeout = 300000) {
  return new Promise((ok, bad) => {
    const timer = setTimeout(() => { listeners = listeners.filter(x => x !== l); bad(new Error("timeout")); }, timeout);
    const l = (frame, size, t) => { const v = pred(frame, size, t); if (v) { clearTimeout(timer); listeners = listeners.filter(x => x !== l); ok({ frame, size, t, v }); } };
    listeners.push(l);
  });
}

let sub = 10;
const threadSubs = new Map();
// Every thread frame goes to the log with its size, so the analysis can count bytes and event kinds.
listeners.push((frame, size, t) => {
  if (frame.event !== "thread") return;
  const d = frame.data ?? {};
  const ev = d.type === "event" ? d.event : null;
  const snap = d.type === "snapshot" ? d.snapshot : null;
  const tail = snap ? snap.messages.slice(-3).map(m => `${m.role}:${JSON.stringify(m.content ?? m.text ?? "").slice(0, 60)}`) : undefined;
  log({ kind: "frame", sub: frame.sub, type: d.type, ev: ev?.type, role: ev?.message?.role, ame: ev?.assistantMessageEvent?.type, size, conn: d.connection, err: d.error, ...(snap ? { snapKind: snap.kind, nmsg: snap.messages.length, tail, streaming: !!snap.streaming } : {}) });
});

function subscribe(id) {
  const s = ++sub; threadSubs.set(s, id);
  ws.send(JSON.stringify({ type: "subscribe", sub: s, feed: "thread", id }));
  return s;
}
const isOn = (s) => (f) => f.sub === s && f.event === "thread";
const evType = (f) => f.data?.type === "event" ? f.data.event?.type : null;
const snapHas = (f, m, role) => f.data?.type === "snapshot" && f.data.snapshot.messages.some((x, i, all) => role === "user" ? x.role === "user" && JSON.stringify(x.content).includes(m) : x.role === "assistant" && all.slice(0, i).some(u => u.role === "user" && JSON.stringify(u.content).includes(m)));

const marker = () => `latency-probe ${randomUUID().slice(0, 8)}`;
const [provider, modelId] = (args.model ?? "anthropic/claude-opus-5-5").split("/");
const thinkingLevel = args.thinking ?? "off";
const host = args.host === "box" ? undefined : (args.host ?? "mac");
const cwd = args.cwd ?? (host === "mac" ? "/Users/sieunpark" : homedir());
const sends = Number(args.sends ?? 3);
const prompt = (m) => args.long ? `${m}. Count from 1 to 300 in words, comma separated, nothing else.` : `${m}. Reply with exactly: ok`;

async function timedSend(s, id, first) {
  const m = marker();
  const t0 = now();
  // Reply frames count only after this send's user message, so a reply to an earlier queued turn is not timed as this one.
  let seenUser = false;
  const userShown = waitFor((f) => (seenUser ||= isOn(s)(f) && ((evType(f) === "message_start" && f.data.event.message?.role === "user" && JSON.stringify(f.data.event.message.content).includes(m)) || snapHas(f, m, "user"))), 120000);
  const firstToken = waitFor((f) => seenUser && isOn(s)(f) && ((["message_update", "message_end"].includes(evType(f)) && f.data.event.message?.role === "assistant") || snapHas(f, m, "assistant")), 120000);
  const done = waitFor((f) => seenUser && isOn(s)(f) && (evType(f) === "agent_end" || snapHas(f, m, "assistant")), 120000);
  let accepted, idOut = id;
  if (first) { const r = await post("api/threads", first(m)); idOut = r.id; accepted = now(); }
  else { await post(`api/threads/${encodeURIComponent(id)}/prompt`, { requestId: randomUUID().replaceAll("-", ""), message: prompt(m), mode: "followUp", images: nextImages() }); accepted = now(); }
  const r = { marker: m, acceptedMs: accepted - t0 };
  if (!first) {
    const [u, f, d] = await Promise.all([userShown, firstToken, done]);
    Object.assign(r, { userShownMs: u.t - t0, firstTokenMs: f.t - t0, doneMs: d.t - t0 });
  }
  log({ kind: "send", ...r });
  return { id: idOut, ...r };
}

let imgIndex = 0;
const imgFiles = args.imgs ? readdirSync(args.imgs).filter(f => f.endsWith(".png")).sort() : [];
function nextImages() {
  const n = Number(args["imgs-per-send"] ?? 0);
  const out = [];
  for (let k = 0; k < n && imgIndex < imgFiles.length; k++) out.push({ type: "image", mimeType: "image/png", data: readFileSync(`${args.imgs}/${imgFiles[imgIndex++]}`).toString("base64") });
  return out;
}
const name = `latency-probe ${host ?? "box"} ${new Date().toISOString().slice(11, 19)}`;
let id = args.id;
let created = false;
const results = [];
// A thread the probe made is archived on every exit, pass or fail, so no scratch session stays resident.
async function finish(code) {
  if (created && !args.keep) await post(`api/threads/${encodeURIComponent(id)}/archive`, {}).catch(() => {});
  ws.close();
  process.exit(code);
}
process.on("unhandledRejection", (error) => { console.error(error); void finish(1); });
if (!id) {
  const t0 = now();
  const made = await post("api/threads", { requestId: randomUUID().replaceAll("-", ""), ...(host ? { host } : {}), cwd, message: prompt(marker()), kind: "thread", provider, modelId, thinkingLevel, name });
  id = made.id;
  created = true;
  log({ kind: "created", id, ms: now() - t0 });
  results.push({ step: "create", ms: now() - t0 });
}
// Open: subscribe and time the snapshot.
{
  const t0 = now();
  const s = subscribe(id);
  const snap = await waitFor((f) => isOn(s)(f) && f.data?.type === "snapshot" ? true : null, 120000);
  results.push({ step: "open", ms: snap.t - t0, bytes: snap.size });
  log({ kind: "open", ms: snap.t - t0, bytes: snap.size });
  if (args["open-only"]) { console.log(JSON.stringify({ id, results })); await finish(0); }
  // Let the first turn settle.
  const st = snap.frame.data.snapshot;
  if (st?.runStartedAt || st?.streaming) await waitFor((f) => isOn(s)(f) && evType(f) === "agent_end", 300000).catch(() => {});
  await new Promise(r => setTimeout(r, 1500));
  for (let i = 0; i < sends; i++) {
    const r = await timedSend(s, id).catch((error) => ({ error: String(error) }));
    results.push({ step: "send", ...r });
    if (r.error) break;
    await new Promise(r => setTimeout(r, 1500));
  }
}
console.log(JSON.stringify({ id, out, results }));
await finish(0);
