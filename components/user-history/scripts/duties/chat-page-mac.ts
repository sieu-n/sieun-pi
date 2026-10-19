import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";

/**
 * The Chat page from the Mac duty's precheck (`node --import tsx scripts/duties/chat-page-mac.ts`): whether the box's chat page on :5182 feels
 * fast from the owner's MacBook Pro and never breaks (owner 10-18, goal p16). It sends nothing outside and never touches the live service
 * process (c106). Four numbers:
 * - `cold_tab_switch_ms` and `cold_load_s` come from chat-page-mac-probe.mjs, which this script pipes into `node` on the Mac over one
 *   `ssh mac` that `timeout` on the box bounds, since the Mac has no `timeout`. It drives a headless Chromium there (c103) against the
 *   page's tailnet URL: each cold load is a new browser context, timed until the chat's lines show; each tab switch opens a chat that page has
 *   not opened yet and reads the app's own `thread-paint:<id>` measure, as p50 measured it (median 46 ms on 10-18).
 * - `mac_chat_reply_extra_rtt`: a scratch thread on the Mac's daemon, made and archived here, gets `SENDS` no-op prompts through the chat
 *   service, the path the page uses. Per send, the extra wait is the time from the send to the first reply frame on the box, less the Mac's
 *   own time from its user entry to its reply entry in the session file, in Mac-to-box round trips (ping from the Mac). The reply is "ok",
 *   so the Mac's reply entry lands a few ms after its first token.
 * - `release_breaks_24h`: releases (systemd stops of sieun-pi-chat) in 24 h after which the service exits with an error, which shows the
 *   owner a dead page, or the outbox drops a message, within `RELEASE_WINDOW_MS` of the release.
 * A source that cannot be read leaves its metric out with a `source_error` item, so the run says not measured instead of a miss.
 */

const HERE = import.meta.dirname;
const MAC = process.env.MAC_SSH_HOST || "mac";
const CHECKOUT = process.env.MAC_SIEUN_PI || "Documents/Github/sieun-pi";
const DATA_DIR = process.env.CHAT_DATA_DIR || join(homedir(), ".prime/agent/browser-chat");
const MODEL = { provider: "anthropic", modelId: "claude-opus-5-5" };
/** 10 samples each, as the p16 brief asked of job mac feel check on 10-19. */
const LOADS = 10;
const SWITCHES = 10;
const SENDS = 3;
/** On 10-19 the 01:14:15Z release crash-looped from 7 s after it to past 01:18:52Z (p72), so a break up to 10 min after a release is its break. */
export const RELEASE_WINDOW_MS = 10 * 60_000;
/** A new scratch thread waits for its pool slot before its first reply: 3 min on the Mac at 15:10Z and 10 min on the box at 15:08Z on 10-19. */
const SLOT_WAIT_MS = 15 * 60_000;

export interface BrowserLoad { shown?: number | null; banner?: string | null; error?: string }
export interface BrowserSwitch { id: string; ms: number | null; lines?: number }
export interface BrowserOutput { loads: BrowserLoad[]; tabs: { switches: BrowserSwitch[]; banner?: string | null } | { error: string }; load?: number; ms?: number; error?: string }
export interface SendTiming { marker: string; sentAt: number; firstTokenAt: number }
export interface Reading { value?: number; flagged: FlaggedSlice[] }

export const median = (values: readonly number[]): number | undefined => {
  if (!values.length) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** The average round trip from `ping -q` on macOS or Linux, in ms. */
export function parsePing(text: string): number | undefined {
  const match = /= [\d.]+\/([\d.]+)\/[\d.]+/.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** Cold load and cold tab switch from the Mac probe's JSON line. A switch with no paint measure counts as `timeoutMs`. */
export function browserReadings(output: BrowserOutput, at: number, timeoutMs: number): { load: Reading; tabs: Reading } {
  const load: Reading = { flagged: [] };
  const tabs: Reading = { flagged: [] };
  const shown = output.loads.map(sample => sample.shown).filter((ms): ms is number => typeof ms === "number" && ms > 0);
  const failed = output.loads.filter(sample => !(typeof sample.shown === "number" && sample.shown > 0));
  const loadMedian = median(shown);
  if (loadMedian !== undefined) load.value = Math.round(loadMedian / 10) / 100;
  load.flagged.push({ at, kind: "cold_load", excerpt: `${shown.length} of ${output.loads.length} cold loads showed the chat, median ${loadMedian === undefined ? "none" : Math.round(loadMedian)} ms, ` +
    `worst ${shown.length ? Math.round(Math.max(...shown)) : "none"} ms; Mac 1-min load ${output.load?.toFixed(1) ?? "unknown"}` });
  for (const sample of failed) load.flagged.push({ at, kind: "cold_load_failed", excerpt: (sample.error ?? "the chat's lines never showed").slice(0, 600) });
  const banners = [...output.loads.map(sample => sample.banner), "switches" in output.tabs ? output.tabs.banner : null].filter((text): text is string => Boolean(text));
  for (const text of new Set(banners)) load.flagged.push({ at, kind: "banner_now", excerpt: `the page showed a red banner: ${text}`.slice(0, 600) });
  if (!("switches" in output.tabs)) {
    tabs.flagged.push({ at, kind: "source_error", excerpt: `the tab switches did not run: ${output.tabs.error}`.slice(0, 600) });
    return { load, tabs };
  }
  const times = output.tabs.switches.map(sample => sample.ms ?? timeoutMs);
  const switchMedian = median(times);
  if (switchMedian !== undefined) tabs.value = Math.round(switchMedian);
  tabs.flagged.push({ at, kind: "tab_switch", excerpt: `${times.length} cold tab switches, median ${switchMedian === undefined ? "none" : Math.round(switchMedian)} ms, worst ${times.length ? Math.round(Math.max(...times)) : "none"} ms` });
  for (const sample of output.tabs.switches.filter(sample => sample.ms === null)) tabs.flagged.push({ at, kind: "tab_switch_stuck", item: sample.id, excerpt: `chat ${sample.id} did not paint within ${timeoutMs} ms` });
  return { load, tabs };
}

interface SessionEntry { type?: string; timestamp?: string; message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string } }

/**
 * Extra round trips per send: the box's wait from the send to the first reply frame, less the Mac's own wait from its user entry to its reply
 * entry, over the round trip. A send whose Mac turn errored, or whose entries are missing, is listed and left out.
 */
export function replyExtra(sends: readonly SendTiming[], macSession: string, rttMs: number, at: number): Reading {
  const reading: Reading = { flagged: [] };
  const entries = macSession.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as SessionEntry).filter(entry => entry.type === "message");
  const counts: number[] = [];
  for (const send of sends) {
    const user = entries.findIndex(entry => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes(send.marker));
    const reply = user < 0 ? undefined : entries.slice(user + 1).find(entry => entry.message?.role === "assistant");
    if (!reply) { reading.flagged.push({ at, kind: "reply_unmatched", excerpt: `${send.marker}: the Mac's session file has no ${user < 0 ? "user entry" : "reply"} for it` }); continue; }
    if (reply.message?.stopReason === "error") {
      reading.flagged.push({ at, kind: "reply_error", excerpt: `${send.marker}: the Mac's turn failed: ${reply.message.errorMessage ?? "no message"}`.slice(0, 600) });
      continue;
    }
    const own = Date.parse(reply.timestamp ?? "") - Date.parse(entries[user]!.timestamp ?? "");
    const seen = send.firstTokenAt - send.sentAt;
    const extra = seen - own;
    counts.push(extra / rttMs);
    reading.flagged.push({ at, kind: "reply", excerpt: `${send.marker}: first reply frame on the box ${seen} ms after the send, the Mac's own turn ${own} ms, extra ${extra} ms = ` +
      `${(extra / rttMs).toFixed(2)} round trips of ${Math.round(rttMs)} ms` });
  }
  const value = median(counts);
  if (value !== undefined) reading.value = Math.round(value * 10) / 10;
  return reading;
}

const timeOf = (line: string): number => Date.parse(line.slice(0, line.indexOf(" ")));

/**
 * Releases in the 24 h before `now` from `journalctl --user -u sieun-pi-chat -o short-iso-precise`, and the ones with a break: a "Main process
 * exited" after the release's restart, or a service log line that drops a message, before the next release or `RELEASE_WINDOW_MS`.
 */
export function releaseBreaks(journal: string, serviceLog: string, now: number): Reading {
  const reading: Reading = { flagged: [] };
  const since = now - 24 * 3_600_000;
  const lines = journal.split("\n").filter(line => /^\d{4}-\d\d-\d\dT/.test(line));
  const stops = lines.filter(line => line.includes("Stopping sieun-pi-chat.service")).map(timeOf).filter(at => at >= since);
  const starts = lines.filter(line => line.includes("Started sieun-pi-chat.service")).map(timeOf);
  const exits = lines.filter(line => line.includes("Main process exited")).map(line => ({ at: timeOf(line), text: line.slice(line.indexOf("Main process")) }));
  const drops = serviceLog.split("\n").filter(line => /^\d{4}-\d\d-\d\dT\S+ messages: .* message \S+ dropped$/.test(line)).map(line => ({ at: timeOf(line), text: line.slice(line.indexOf(" ") + 1) }));
  let broken = 0;
  stops.forEach((stop, index) => {
    const end = Math.min(stops[index + 1] ?? Infinity, stop + RELEASE_WINDOW_MS);
    const restart = starts.find(at => at >= stop) ?? stop;
    const found = [...exits.filter(exit => exit.at > restart && exit.at < end), ...drops.filter(drop => drop.at >= stop && drop.at < end)];
    if (!found.length) return;
    broken++;
    reading.flagged.push({ at: stop, kind: "release_break", item: new Date(stop).toISOString(),
      excerpt: `the release at ${new Date(stop).toISOString()}: ${found.length} break${found.length > 1 ? "s" : ""}, first ${found[0]!.text}`.slice(0, 600) });
  });
  reading.value = broken;
  reading.flagged.push({ at: now, kind: "releases", excerpt: `${stops.length} chat releases in 24 h, ${broken} with a break` });
  return reading;
}

type Exec = (file: string, args: readonly string[], options?: { input?: string; timeoutMs?: number; cwd?: string }) => Promise<string>;
const exec: Exec = (file, args, options = {}) => new Promise((resolve, reject) => {
  const child = execFile(file, [...args], { encoding: "utf8", timeout: options.timeoutMs ?? 30_000, maxBuffer: 256 * 1024 * 1024, cwd: options.cwd },
    (error, stdout, stderr) => error ? reject(new Error(`${file} ${args.slice(0, 3).join(" ")}: ${(stderr || error.message).trim().slice(0, 300)}`)) : resolve(stdout));
  if (options.input !== undefined) child.stdin!.end(options.input);
});
/** One ssh to the Mac, bounded on the box, since the Mac has no `timeout` command. */
const onMac = (command: string, seconds: number, input?: string): Promise<string> =>
  exec("timeout", [String(seconds), "ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", MAC, command], { timeoutMs: (seconds + 5) * 1000, ...(input === undefined ? {} : { input }) });

interface ChatConfig { port: number; capability: string; csrfToken: string; publicOrigin?: string }

const SWITCH_TIMEOUT_MS = 10_000;

async function browse(config: ChatConfig, chatId: string): Promise<BrowserOutput> {
  if (!config.publicOrigin) throw new Error("configuration.json has no publicOrigin, so the Mac has no URL for the page");
  const probe = { url: `${config.publicOrigin}/${config.capability}/#${chatId}`, checkout: CHECKOUT, loads: LOADS, switches: SWITCHES, budgetMs: 170_000,
    loadTimeoutMs: 20_000, switchTimeoutMs: SWITCH_TIMEOUT_MS, settleMs: 3000, gapMs: 300 };
  const script = (await readFile(join(HERE, "chat-page-mac-probe.mjs"), "utf8")).replace("const config = CONFIG;", `const config = ${JSON.stringify(probe)};`);
  const text = await onMac("PATH=$HOME/.local/bin:/opt/homebrew/bin:$PATH node --input-type=module -", 190, script);
  const output = JSON.parse(text.trim().split("\n").at(-1) ?? "") as BrowserOutput;
  if (output.error) throw new Error(output.error);
  return output;
}

async function sendProbe(config: ChatConfig): Promise<{ id: string; sends: SendTiming[] }> {
  const origin = `http://127.0.0.1:${config.port}`;
  const base = `${origin}/${config.capability}/`;
  const post = async (route: string, body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(base + route, { method: "POST", headers: { "Content-Type": "application/json", "X-Chat-Token": config.csrfToken, Origin: origin },
      body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`${route} ${res.status} ${text.slice(0, 200)}`);
    return JSON.parse(text) as Record<string, unknown>;
  };
  type Frame = { event?: string; sub?: number; data?: { type?: string; event?: { type?: string; message?: { role?: string; content?: unknown; stopReason?: string } }; snapshot?: { messages?: { role?: string; stopReason?: string }[]; streaming?: boolean } } };
  const ws = new WebSocket(`${base.replace("http", "ws")}api/ws?token=${config.csrfToken}`, { headers: { Origin: origin } });
  const frames: { at: number; frame: Frame }[] = [];
  ws.on("message", data => { try { frames.push({ at: Date.now(), frame: JSON.parse(data.toString()) as Frame }); } catch { /* a frame that is not JSON is no thread event */ } });
  await new Promise((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
  const until = async (from: number, test: (frame: Frame) => boolean, timeoutMs: number, what: string): Promise<{ at: number; index: number }> => {
    const deadline = Date.now() + timeoutMs;
    for (let index = from; ; ) {
      for (; index < frames.length; index++) if (test(frames[index]!.frame)) return { at: frames[index]!.at, index };
      if (Date.now() > deadline) throw new Error(`no ${what} within ${timeoutMs / 1000} s`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  const marker = () => `chat page probe ${randomUUID().slice(0, 8)}.`;
  const created = await post("api/threads", { requestId: randomUUID().replaceAll("-", ""), host: "mac", cwd: "/Users/sieunpark", kind: "thread", ...MODEL, thinkingLevel: "off",
    name: `chat page probe ${new Date().toISOString().slice(11, 16)}`, message: `${marker()} Reply with exactly: ok` });
  const id = String(created.id);
  const sends: SendTiming[] = [];
  try {
    ws.send(JSON.stringify({ type: "subscribe", sub: 1, feed: "thread", id }));
    const mine = (frame: Frame) => frame.event === "thread" && frame.sub === 1;
    const kind = (frame: Frame) => frame.data?.type === "event" ? frame.data.event?.type : undefined;
    const goodReply = (frame: Frame) => mine(frame) && ((kind(frame) === "message_end" && frame.data!.event!.message?.role === "assistant" && frame.data!.event!.message.stopReason !== "error") ||
      (frame.data?.type === "snapshot" && !frame.data.snapshot?.streaming && (frame.data.snapshot?.messages ?? []).some(message => message.role === "assistant" && message.stopReason !== "error")));
    await until(0, goodReply, SLOT_WAIT_MS, "first reply from the Mac");
    for (let count = 0; count < SENDS; count++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const text = marker();
      const from = frames.length;
      const sentAt = Date.now();
      await post(`api/threads/${encodeURIComponent(id)}/prompt`, { requestId: randomUUID().replaceAll("-", ""), message: `${text} Reply with exactly: ok`, mode: "followUp", images: [] });
      const user = await until(from, frame => mine(frame) && kind(frame) === "message_start" && frame.data!.event!.message?.role === "user" && JSON.stringify(frame.data!.event!.message.content).includes(text), 120_000, "user message");
      const token = await until(user.index + 1, frame => mine(frame) && ["message_update", "message_end"].includes(kind(frame) ?? "") && frame.data!.event!.message?.role === "assistant", 300_000, "reply frame");
      sends.push({ marker: text, sentAt, firstTokenAt: token.at });
      await until(token.index, frame => mine(frame) && kind(frame) === "agent_end", 300_000, "turn end");
    }
  } finally {
    await post(`api/threads/${encodeURIComponent(id)}/archive`, {}).catch(() => undefined);
    ws.close();
  }
  return { id, sends };
}

const settle = <T>(promise: Promise<T>): Promise<T | Error> => promise.catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));

export async function measure(chatId: string): Promise<PrecheckOutput> {
  const at = Date.now();
  const config = JSON.parse(await readFile(join(DATA_DIR, "configuration.json"), "utf8")) as ChatConfig;
  const host = config.publicOrigin ? new URL(config.publicOrigin).hostname : "";
  const [browser, ping, journal, serviceLog] = await Promise.all([
    settle(browse(config, chatId)),
    settle(onMac(`ping -c 5 -q ${host}`, 40)),
    settle(exec("journalctl", ["--user", "-u", "sieun-pi-chat", "--since", `@${Math.floor((at - 25 * 3_600_000) / 1000)}`, "-o", "short-iso-precise", "--no-pager"], { timeoutMs: 60_000 })),
    settle(readFile(join(DATA_DIR, "service.log"), "utf8")),
  ]);
  const replies = await settle(sendProbe(config));
  const macSession = replies instanceof Error ? replies : await settle(onMac(`cat .prime/agent/sessions/${replies.id.replace(/[^0-9a-f-]/g, "")}.jsonl`, 40));
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = [];
  const sourceError = (excerpt: string) => flagged.push({ at, kind: "source_error", excerpt: excerpt.slice(0, 600) });
  const take = (key: string, reading: Reading) => { if (reading.value !== undefined) metrics[key] = reading.value; flagged.push(...reading.flagged); };

  if (browser instanceof Error) sourceError(`the headless page on the Mac did not run, so tab switch and cold load are not measured: ${browser.message}`);
  else {
    const { load, tabs } = browserReadings(browser, at, SWITCH_TIMEOUT_MS);
    take("cold_tab_switch_ms", tabs);
    take("cold_load_s", load);
  }

  const rtt = ping instanceof Error ? undefined : parsePing(ping);
  if (rtt === undefined) sourceError(`ping from the Mac to ${host} gave no round trip: ${ping instanceof Error ? ping.message : ping.slice(-200)}`);
  else if (replies instanceof Error) sourceError(`the Mac chat sends did not finish: ${replies.message}`);
  else if (macSession instanceof Error) sourceError(`the Mac's session file for ${replies.id} could not be read: ${macSession.message}`);
  else take("mac_chat_reply_extra_rtt", replyExtra(replies.sends, macSession, rtt, at));

  if (journal instanceof Error) sourceError(`journalctl for sieun-pi-chat: ${journal.message}`);
  else if (serviceLog instanceof Error) sourceError(`the chat service log: ${serviceLog.message}`);
  else take("release_breaks_24h", releaseBreaks(journal, serviceLog, at));
  return { metrics, flagged };
}

async function main(): Promise<void> {
  const chatId = process.env.CHAT_PAGE_THREAD || "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb";
  const text = JSON.stringify(await measure(chatId), null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
