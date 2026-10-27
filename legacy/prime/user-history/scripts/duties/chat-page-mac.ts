import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { credentialWaitAt } from "../../src/shared/credential-wait.ts";
import { parseStartSkill, startMessage } from "../../src/shared/start-skill.ts";
import { asideRepl } from "./aside-repl.ts";
import { browseInAside } from "./chat-page-mac-probe.ts";
import { macAway } from "./mac-reach.ts";

/**
 * The Chat page from the Mac duty's precheck (`node --import tsx scripts/duties/chat-page-mac.ts`): whether the box's chat page on :5182 feels
 * fast from the owner's MacBook Pro and never breaks (owner 10-18, goal p16). It sends nothing outside and never touches the live service
 * process (c106). Four numbers:
 * - `cold_tab_switch_ms` and `cold_load_s` come from chat-page-mac-probe.ts, which drives background tabs of the owner's Aside on the Mac
 *   over one `ssh mac` running `aside mcp` (c177, c103) against the page's tailnet URL: each cold load is a new tab, timed until the chat's
 *   lines show; each tab switch opens a chat that page has not opened yet and reads the app's own `thread-paint:<id>` measure, as p50
 *   measured it (median 46 ms on 10-18). Each switch also says whether the sidebar's prefetch had brought the chat's first frame back before
 *   the click, and when that request ran, since an unprimed switch waits one round trip for the feed's snapshot: the 10-27 00:20Z run right
 *   after the Mac woke read 217 ms and could not say why. Until 10-27 a headless Chromium on the Mac timed them, with a new browser context
 *   per load; an Aside tab can take the app's assets from Aside's cache, so each load says how many it did.
 * - `mac_chat_reply_extra_rtt`: a scratch thread on the Mac's daemon, made and archived here, gets up to `SENDS` no-op prompts through the
 *   chat service, the path the page uses. The first rides on the create call and is timed from before that POST; it waits on the Mac's
 *   worker start too, so it is listed and left out of the value, which is the median of the follow-ups. Those go only when the first turn
 *   ended without pi-pool's retry, since a new thread can wait 15 min and more for its slot (10-19 15:17Z). Per send, the extra wait is the
 *   time from the send to the first reply frame on the box, less the Mac's own time from its user entry to its reply entry in the session
 *   file, in Mac-to-box round trips (ping from the Mac). The reply is "ok", so the Mac's reply entry lands a few ms after its first token.
 *   The target is 1.5: one round trip is the network floor (the prompt's half trip out and the reply's half trip back), and the layer tap
 *   of 10-20 01:49Z read a 193 ms round trip, about 55 ms on the Mac's daemon before its user entry, and 0 ms in the bridge and relay filters.
 * - `release_breaks_24h`: releases (systemd stops of sieun-pi-chat) in 24 h after which the service exits with an error within
 *   `RELEASE_WINDOW_MS`, which leaves the owner's page on its red banner.
 * A Mac that Tailscale lists offline leaves the three Mac numbers out with a `host_away` item (mac-reach.ts), and the runner reruns the duty
 * once Tailscale reads it online. A source that cannot be read leaves its metric out with a `source_error` item, so the run says not measured
 * instead of a miss.
 */

const MAC = process.env.MAC_SSH_HOST || "mac";
const DATA_DIR = process.env.CHAT_DATA_DIR || join(homedir(), ".prime/agent/browser-chat");
const MODEL = { provider: "anthropic", modelId: "claude-opus-5-5" };
/** 10 samples each, as the p16 brief asked of job mac feel check on 10-19. */
const LOADS = 10;
const SWITCHES = 10;
/** One create send and three follow-ups, so the value is a median of three. */
const SENDS = 4;
/** pi-pool can hold a new thread's first turn with no frame at all: over 2 min on the Mac at 15:41Z on 10-19, while at 15:17Z it answered an error in 3 s. */
const FIRST_REPLY_MS = 10 * 60_000;
/** On 10-19 the 01:14:15Z release crash-looped from 7 s after it to past 01:18:52Z (p72), so a break up to 10 min after a release is its break. */
export const RELEASE_WINDOW_MS = 10 * 60_000;

/**
 * `via` says how `shown` was read: "watch" saw the lines arrive, "first paint" found them painted when the watcher went in. `cachedAssets`
 * and `fetchedAssets` count the app's scripts and styles that came from the browser's cache and over the network, read once `complete`
 * (the load event passed). All four are absent in output from the headless probe before 10-27.
 */
export interface BrowserLoad { shown?: number | null; via?: string | null; complete?: boolean; banner?: string | null; cachedAssets?: number; fetchedAssets?: number; error?: string }
/** The clicked thread's first-frame prefetch, in ms from the click (negative is before it): started, sent past the page's queue, first byte, done. */
export interface SwitchFrame { startMs: number; sentMs: number; firstByteMs: number; endMs: number }
/**
 * `primed` says whether the thread's first frame had come back before the click, so it painted from the prefetch; `frame` is null when no
 * prefetch of it finished by the paint. Both are absent in output from a probe before 10-27.
 */
export interface BrowserSwitch { id: string; ms: number | null; lines?: number; primed?: boolean | null; frame?: SwitchFrame | null }
/** `settle`: the prefetches back when the probe's settle ended and its clicks began, and their median time. */
export interface BrowserTabs { switches: BrowserSwitch[]; banner?: string | null; settle?: { frames: number; medianMs: number | null } }
export interface BrowserOutput { loads: BrowserLoad[]; tabs: BrowserTabs | { error: string }; load?: number; ms?: number; error?: string }
/** `create` is the send that rides on the create call, which also waits on the Mac's worker start. */
export interface SendTiming { marker: string; sentAt: number; firstTokenAt: number; create?: boolean }
export interface Reading { value?: number; flagged: FlaggedSlice[]; lastEventAt?: number }

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
  const counted = output.loads.filter(sample => typeof sample.cachedAssets === "number");
  const cached = counted.length ? `; ${counted.filter(sample => sample.cachedAssets! > 0 && !sample.fetchedAssets).length} of ${counted.length} took every app asset from the ` +
    `browser's cache, ${counted.filter(sample => sample.fetchedAssets! > 0).length} fetched some` : "";
  const firstPaint = output.loads.filter(sample => sample.via === "first paint").length;
  const read = firstPaint ? `; ${firstPaint} read at the first paint, since the lines had shown before the watcher went in` : "";
  load.flagged.push({ at, kind: "cold_load", excerpt: `${shown.length} of ${output.loads.length} cold loads showed the chat, median ${loadMedian === undefined ? "none" : Math.round(loadMedian)} ms, ` +
    `worst ${shown.length ? Math.round(Math.max(...shown)) : "none"} ms; Mac 1-min load ${output.load?.toFixed(1) ?? "unknown"}${cached}${read}` });
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
  const known = output.tabs.switches.filter(sample => typeof sample.primed === "boolean");
  const primed = known.length ? `; ${known.filter(sample => sample.primed).length} of ${known.length} chats primed before the click` : "";
  const settle = output.tabs.settle;
  const settled = settle ? `; ${settle.frames} first frames back when the clicks began, median ${settle.medianMs ?? "none"} ms each` : "";
  tabs.flagged.push({ at, kind: "tab_switch", excerpt: `${times.length} cold tab switches, median ${switchMedian === undefined ? "none" : Math.round(switchMedian)} ms, ` +
    `worst ${times.length ? Math.round(Math.max(...times)) : "none"} ms${primed}${settled}` });
  for (const sample of output.tabs.switches.filter(sample => sample.ms === null)) tabs.flagged.push({ at, kind: "tab_switch_stuck", item: sample.id, excerpt: `chat ${sample.id} did not paint within ${timeoutMs} ms` });
  for (const sample of output.tabs.switches.filter(sample => sample.primed === false)) {
    tabs.flagged.push({ at, kind: "tab_switch_unprimed", item: sample.id, excerpt: `chat ${sample.id} painted in ${sample.ms === null ? "no" : Math.round(sample.ms)} ms from its feed's snapshot: ${unprimedCause(sample.frame ?? null)}` });
  }
  return { load, tabs };
}

/** Why a clicked chat had no prefetched first frame: never fetched by its paint, or fetched too late, with where the request's time went. */
export function unprimedCause(frame: SwitchFrame | null): string {
  if (!frame) return "no first-frame prefetch of it came back by the paint";
  const when = (ms: number) => ms < 0 ? `${-ms} ms before the click` : `${ms} ms after the click`;
  return `its prefetch started ${when(frame.startMs)} and came back ${when(frame.endMs)}: ${frame.sentMs - frame.startMs} ms before the page sent it, ` +
    `${frame.firstByteMs - frame.sentMs} ms to the first byte, ${frame.endMs - frame.firstByteMs} ms to the last`;
}

interface SessionEntry { type?: string; timestamp?: string; message?: { role?: string; content?: unknown; stopReason?: string; errorMessage?: string; diagnostics?: unknown } }

/**
 * Extra round trips per send: the box's wait from the send to the first reply frame, less the Mac's own wait from its user entry to its reply
 * entry, over the round trip. A reply that is an error, such as pi-pool's slot wait, still crossed the same path, so it is timed and listed;
 * a send whose entries are missing is listed and left out. The create send is listed and left out of the median, since its wait holds the
 * Mac's worker start, which a message to a chat that runs never has.
 */
export function replyExtra(sends: readonly SendTiming[], macSession: string, rttMs: number, at: number): Reading {
  const reading: Reading = { flagged: [] };
  const entries = macSession.split("\n").filter(line => line.startsWith("{")).map(line => JSON.parse(line) as SessionEntry).filter(entry => entry.type === "message");
  const counts: number[] = [];
  for (const send of sends) {
    const user = entries.findIndex(entry => entry.message?.role === "user" && JSON.stringify(entry.message.content).includes(send.marker));
    const reply = user < 0 ? undefined : entries.slice(user + 1).find(entry => entry.message?.role === "assistant");
    if (!reply) { reading.flagged.push({ at, kind: "reply_unmatched", excerpt: `${send.marker}: the Mac's session file has no ${user < 0 ? "user entry" : "reply"} for it` }); continue; }
    // A dhx.3 Prime ends a turn the pool holds on its credential wait marker, a wait for the slot and no failed reply.
    const waitAt = reply.message?.stopReason === "error" ? credentialWaitAt(reply.message) : null;
    if (waitAt !== null) reading.flagged.push({ at, kind: "reply_pool_wait", excerpt: `${send.marker}: the Mac's turn waits for its pi-pool slot until ${new Date(waitAt).toISOString()}, timed as its reply` });
    else if (reply.message?.stopReason === "error") reading.flagged.push({ at, kind: "reply_error", excerpt: `${send.marker}: the Mac's turn ended in an error, timed as its reply: ${reply.message.errorMessage ?? "no message"}`.slice(0, 600) });
    const own = Date.parse(reply.timestamp ?? "") - Date.parse(entries[user]!.timestamp ?? "");
    const seen = send.firstTokenAt - send.sentAt;
    const extra = seen - own;
    if (!send.create) counts.push(extra / rttMs);
    reading.flagged.push({ at, kind: send.create ? "reply_new_thread" : "reply", excerpt: `${send.marker}: first reply frame on the box ${seen} ms after the send, the Mac's own turn ${own} ms, extra ${extra} ms = ` +
      `${(extra / rttMs).toFixed(2)} round trips of ${Math.round(rttMs)} ms` });
  }
  const value = median(counts);
  if (value !== undefined) reading.value = Math.round(value * 10) / 10;
  return reading;
}

const timeOf = (line: string): number => Date.parse(line.slice(0, line.indexOf(" ")));

/**
 * Releases in the 24 h before `now` from `journalctl --user -u sieun-pi-chat -o short-iso-precise`, and the ones with a break: a "Main process
 * exited" after the release's restart and before the next release or `RELEASE_WINDOW_MS`, which leaves the page on its red banner. The owner
 * outbox keeps a send on disk and retries it across restarts, so a release loses no page message by itself; the agent outbox's "message ...
 * dropped" lines are sends to sessions that are gone, 9 in the 24 h to 10-19 15:30Z and 4 of them away from any release, so they do not count.
 * `lastEventAt` is the newest broken release's stop, the time the 24 h window keys on, or with no break the newest release's stop, and none
 * with no release in 24 h. AI harness d9 read the count as a lagging window on 10-23 because it had none.
 */
export function releaseBreaks(journal: string, now: number): Reading {
  const reading: Reading = { flagged: [] };
  const since = now - 24 * 3_600_000;
  const lines = journal.split("\n").filter(line => /^\d{4}-\d\d-\d\dT/.test(line));
  const stops = lines.filter(line => line.includes("Stopping sieun-pi-chat.service")).map(timeOf).filter(at => at >= since);
  const starts = lines.filter(line => line.includes("Started sieun-pi-chat.service")).map(timeOf);
  const exits = lines.filter(line => line.includes("Main process exited")).map(line => ({ at: timeOf(line), text: line.slice(line.indexOf("Main process")) }));
  let broken = 0;
  stops.forEach((stop, index) => {
    const end = Math.min(stops[index + 1] ?? Infinity, stop + RELEASE_WINDOW_MS);
    const restart = starts.find(at => at >= stop) ?? stop;
    const found = exits.filter(exit => exit.at > restart && exit.at < end);
    if (!found.length) return;
    broken++;
    reading.lastEventAt = stop;
    reading.flagged.push({ at: stop, kind: "release_break", item: new Date(stop).toISOString(),
      excerpt: `the release at ${new Date(stop).toISOString()}: ${found.length} break${found.length > 1 ? "s" : ""}, first ${found[0]!.text}`.slice(0, 600) });
  });
  reading.value = broken;
  if (!broken && stops.length) reading.lastEventAt = Math.max(...stops);
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

export interface ChatConfig { port: number; capability: string; csrfToken: string; publicOrigin?: string }

const SWITCH_TIMEOUT_MS = 10_000;
/** The old headless probe's bound (`timeout 190` on its ssh); the browser part runs before the sends, whose new-thread bound is 10 of the precheck's 15 min. */
const BROWSE_BUDGET_MS = 190_000;

/** The Mac's 1-minute load from `sysctl -n vm.loadavg`, such as "{ 5.98 9.31 11.52 }". */
export function parseLoadavg(text: string): number | undefined {
  const match = /^\{\s*([\d.]+)/.exec(text.trim());
  return match ? Number(match[1]) : undefined;
}

/**
 * Cold loads and tab switches in the owner's Aside on the Mac (chat-page-mac-probe.ts), over one `aside mcp` that runs there through ssh.
 * The page's URL carries `?t=<chat>`, which its boot script would otherwise add with a reload before the timed document.
 */
async function browse(config: ChatConfig, chatId: string): Promise<BrowserOutput> {
  if (!config.publicOrigin) throw new Error("configuration.json has no publicOrigin, so the Mac has no URL for the page");
  const repl = asideRepl("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=20", MAC, "exec $HOME/.local/bin/aside mcp"]);
  let over = false;
  const stop = setTimeout(() => { over = true; repl.stop(); }, BROWSE_BUDGET_MS);
  try {
    const url = `${config.publicOrigin}/${config.capability}/?t=${encodeURIComponent(chatId)}#${chatId}`;
    const output = await browseInAside(repl, { url, loads: LOADS, switches: SWITCHES, loadTimeoutMs: 20_000, switchTimeoutMs: SWITCH_TIMEOUT_MS, clickTimeoutMs: 5000,
      settleMs: 3000, gapMs: 300 });
    const late = `the Aside probe ran past ${BROWSE_BUDGET_MS / 1000} s`;
    const loads = over ? output.loads.map(sample => sample.error ? { error: late } : sample) : output.loads;
    const tabs = over && "error" in output.tabs ? { error: late } : output.tabs;
    const load = await onMac("sysctl -n vm.loadavg", 40).then(parseLoadavg, () => undefined);
    return { ...output, loads, tabs, ...(load === undefined ? {} : { load }) };
  } finally {
    clearTimeout(stop);
    repl.stop();
  }
}

/**
 * `firstReplyMs` bounds the new thread's turn, its slot-wait retries included; tests make it short. `startSkill` is the New chat box's start
 * skill (new-chat.json), which the page puts before the owner's first message (startMessage), so the new-thread send takes his path.
 */
export async function sendProbe(config: ChatConfig, firstReplyMs = FIRST_REPLY_MS, startSkill: string | null = null): Promise<{ id: string; sends: SendTiming[] }> {
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
  const firstText = marker();
  // The New chat box asks the Mac for a spare session while the owner writes (ThreadHub.prewarm), and his writing takes longer than the spare's
  // start, so the send is timed once the spare is ready, as his is.
  await post("api/new-chat/prewarm", { host: "mac", cwd: "/Users/sieunpark", ...MODEL, thinkingLevel: "off" });
  const createdAt = Date.now();
  const created = await post("api/threads", { requestId: randomUUID().replaceAll("-", ""), host: "mac", cwd: "/Users/sieunpark", kind: "thread", ...MODEL, thinkingLevel: "off",
    name: `chat page probe ${new Date().toISOString().slice(11, 16)}`, message: startMessage(`${firstText} Reply with exactly: ok`, startSkill) });
  const id = String(created.id);
  const sends: SendTiming[] = [];
  try {
    ws.send(JSON.stringify({ type: "subscribe", sub: 1, feed: "thread", id }));
    const mine = (frame: Frame) => frame.event === "thread" && frame.sub === 1;
    const kind = (frame: Frame) => frame.data?.type === "event" ? frame.data.event?.type : undefined;
    const reply = (frame: Frame) => mine(frame) && ["message_update", "message_end"].includes(kind(frame) ?? "") && frame.data!.event!.message?.role === "assistant";
    const first = await until(0, frame => reply(frame) || (mine(frame) && frame.data?.type === "snapshot" && (frame.data.snapshot?.messages ?? []).some(message => message.role === "assistant")),
      firstReplyMs, "first reply frame");
    sends.push({ marker: firstText, sentAt: createdAt, firstTokenAt: first.at, create: true });
    // The page's subscribe can answer after the first turn already ended, since the first message leaves with the create: its snapshot then
    // holds the reply and streams nothing, and no agent_end follows. On 10-20 at 06:46Z that read as "no first turn end within 300 s" and
    // left p93's metric unread, while the turn had ended in the slot-wait error 2 s after the send.
    // A snapshot ended the turn only when it says so: nothing streams, no retry waits, and its last reply is no error. A slot wait that outlasts
    // the bound leaves the follow-ups unsent and the new-thread send still read.
    const snap = frames[first.index]!.frame.data?.type === "snapshot" ? frames[first.index]!.frame.data!.snapshot as { streaming?: unknown; retry?: unknown; messages?: { role?: string; stopReason?: string }[] } : null;
    const ended = snap !== null && "retry" in snap && snap.retry === null && !snap.streaming &&
      (snap.messages ?? []).filter(message => message.role === "assistant").at(-1)?.stopReason !== "error";
    const end = ended ? first : await until(first.index, frame => mine(frame) && (kind(frame) === "agent_end" || kind(frame) === "auto_retry_start"),
      Math.max(1, createdAt + firstReplyMs - Date.now()), "first turn end").catch(() => null);
    if (!end) return { id, sends };
    // A first turn that ended in an error, such as pi-pool's slot wait, goes into a retry after its agent_end, and a follow-up sent then waits
    // behind it: on 10-20 at 05:49Z the follow-up got no user message in 120 s. So the follow-ups wait for a turn that ends with no error,
    // within the new thread's bound; at 05:52Z the slot came after about 1 min, and a probe that sent none left p93's metric unread.
    // The newest assistant outcome in the frames decides, a snapshot's last assistant message included: at 06:05Z on 10-20 the subscribe
    // answered with a snapshot that already held the slot-wait error, and follow-ups sent behind its retry read up to 89 round trips.
    const failed = (from: number, to: number) => {
      let error = false;
      for (const { frame } of frames.slice(from, to + 1)) {
        if (!mine(frame)) continue;
        if (frame.data?.type === "snapshot") {
          const last = (frame.data.snapshot?.messages ?? []).filter(message => message.role === "assistant").at(-1);
          if (last) error = last.stopReason === "error";
        } else if (kind(frame) === "message_end" && frame.data?.event?.message?.role === "assistant") error = frame.data.event.message.stopReason === "error";
        // A retry that starts holds the turn, whatever its last message said; the turn after it decides.
        else if (kind(frame) === "auto_retry_start") error = true;
      }
      return error;
    };
    for (let from = first.index, turn = end.index; failed(from, turn); ) {
      const left = createdAt + firstReplyMs - Date.now();
      const next = left > 0 ? await until(turn + 1, frame => mine(frame) && kind(frame) === "agent_end", left, "turn after the slot wait").catch(() => null) : null;
      if (!next) return { id, sends };
      from = turn + 1;
      turn = next.index;
    }
    for (let count = 1; count < SENDS; count++) {
      await new Promise(resolve => setTimeout(resolve, 1500));
      const text = marker();
      const from = frames.length;
      const sentAt = Date.now();
      await post(`api/threads/${encodeURIComponent(id)}/prompt`, { requestId: randomUUID().replaceAll("-", ""), message: `${text} Reply with exactly: ok`, mode: "followUp", images: [] });
      const user = await until(from, frame => mine(frame) && kind(frame) === "message_start" && frame.data!.event!.message?.role === "user" && JSON.stringify(frame.data!.event!.message.content).includes(text), Math.min(120_000, firstReplyMs), "user message");
      const token = await until(user.index + 1, reply, 300_000, "reply frame");
      sends.push({ marker: text, sentAt, firstTokenAt: token.at });
      const done = await until(token.index, frame => mine(frame) && (kind(frame) === "agent_end" || kind(frame) === "auto_retry_start"), 300_000, "turn end");
      if (kind(frames[done.index]!.frame) === "auto_retry_start") break;
    }
  } finally {
    await post(`api/threads/${encodeURIComponent(id)}/archive`, { by: "service_cleanup" }).catch(() => undefined);
    ws.close();
  }
  return { id, sends };
}

const settle = <T>(promise: Promise<T>): Promise<T | Error> => promise.catch((error: unknown) => error instanceof Error ? error : new Error(String(error)));

export async function measure(chatId: string): Promise<PrecheckOutput> {
  const at = Date.now();
  const config = JSON.parse(await readFile(join(DATA_DIR, "configuration.json"), "utf8")) as ChatConfig;
  const host = config.publicOrigin ? new URL(config.publicOrigin).hostname : "";
  const away = await macAway(MAC, "tab switch, cold load and the Mac chat reply wait are", at);
  const offline = away?.excerpt;
  const skipped = Promise.resolve(new Error(offline));
  const [browser, ping, journal] = await Promise.all([
    offline ? skipped : settle(browse(config, chatId)),
    offline ? skipped : settle(onMac(`ping -c 5 -q ${host}`, 40)),
    settle(exec("journalctl", ["--user", "-u", "sieun-pi-chat", "--since", `@${Math.floor((at - 25 * 3_600_000) / 1000)}`, "-o", "short-iso-precise", "--no-pager"], { timeoutMs: 60_000 })),
  ]);
  const startSkill = await readFile(join(DATA_DIR, "new-chat.json"), "utf8").then(text => parseStartSkill((JSON.parse(text) as { startSkill?: unknown }).startSkill ?? null), () => null);
  const replies = offline ? new Error(offline) : await settle(sendProbe(config, FIRST_REPLY_MS, startSkill));
  const macSession = replies instanceof Error ? replies : await settle(onMac(`cat .prime/agent/sessions/${replies.id.replace(/[^0-9a-f-]/g, "")}.jsonl`, 40));
  const metrics: Record<string, number> = {};
  const flagged: FlaggedSlice[] = [];
  const sourceError = (excerpt: string) => flagged.push({ at, kind: "source_error", excerpt: excerpt.slice(0, 600) });
  const lastEventAt: Record<string, number> = {};
  const take = (key: string, reading: Reading) => {
    if (reading.value !== undefined) metrics[key] = reading.value;
    if (reading.lastEventAt !== undefined) lastEventAt[key] = reading.lastEventAt;
    flagged.push(...reading.flagged);
  };

  if (away) flagged.push(away);
  else {
    if (browser instanceof Error) sourceError(`the Aside page on the Mac did not run, so tab switch and cold load are not measured: ${browser.message}`);
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
  }

  if (journal instanceof Error) sourceError(`journalctl for sieun-pi-chat: ${journal.message}`);
  else take("release_breaks_24h", releaseBreaks(journal, at));
  return { metrics, flagged, ...Object.keys(lastEventAt).length ? { lastEventAt } : {} };
}

async function main(): Promise<void> {
  const chatId = process.env.CHAT_PAGE_THREAD || "01a14d31-6ec0-7005-bbe8-c38b7ae73cfb";
  const text = JSON.stringify(await measure(chatId), null, 2) + "\n";
  if (process.env.OUTPUT_FILE) await writeFile(process.env.OUTPUT_FILE, text);
  else process.stdout.write(text);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
