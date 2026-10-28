import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FlaggedSlice, PrecheckOutput } from "../../src/shared/chat-duties.ts";
import { Projector } from "../../src/chat-projection.ts";
import { readBranchPage, historyMessages } from "../../src/session-tail.ts";
import { chatLines, lineId, OWNER_BURST_GAP_MS, OWNER_RETRY_MARK, serverNote } from "../../src/shared/chat-feed.ts";
import { isPromptCustom, messageText } from "../../src/shared/turns.ts";
import { noiseAging, noiseLastEvent, noiseMetrics, noiseSide, splitNoise } from "./noise-split.ts";
import { fixRepos, gitCommitTime } from "./repeat-split.ts";

/**
 * The Owner messages duty's precheck (owner-messages.duty.json): what the owner's real chats sent him in the last 24 h, the way the :5182 feed
 * shows it (chatLines). The owner asked on 10-19 (c117) that chats message him only when he needs it, with high precision and high recall, like
 * a VP's Slack DMs; the p684 reads went from about 52% needed on 10-18 to 92% on 10-20 03:19Z to 15:19Z (wiki
 * domains/devops/owner-message-precision). No model call: a reply on a turn he started counts as needed, and every other line needs a label
 * the duty job writes to LABELS ({"id","label":"needed"|"noise","case"} per line), which the after-job measure reads.
 * - needed_pct_24h: needed lines of the labelled ones, in percent; 100 when nothing went out.
 * - unlabeled_lines: lines on turns he did not start with no label that a d11 job already had the chance to label, those sent before the newest
 *   run in LAST_RUNS_FILE that started a job (every line when none did). A line sent after it is the next job's input, not a miss: on 10-22
 *   verify runs read 57, 67, 14 and 41 while each labelling job left 0 or 1. A run whose job was cut (its `cut`) before it wrote a label line
 *   by its name had no chance: 4 of 6 d11 jobs from 10-22 14:45Z to 10-23 03:11Z were cut by credential_unavailable with no label, and the
 *   lines before them read 13, 9 and 9 misses. Every unlabeled line is flagged with its chat, wake and text.
 * - unanswered_bursts: his message bursts with no reply in the window that are older than ANSWER_GRACE_MS.
 * - noise_before_fix_24h, noise_after_fix_24h, noise_no_fix_24h: the noise lines by when the check for their kind landed (noise-split.ts), and
 *   needed_pct_24h's lastEventAt, the newest send, label or fix landing among them, so a miss on noise no run has newly seen only waits for the
 *   lines to leave the 24 h. A missed needed_pct_24h also flags `aging`: when the oldest noise line leaves and when the share meets the target
 *   with no new noise (noiseAging).
 * Clean-room test chats are left out (clean-room-chats.json), since the goal is about his real chats.
 *
 *   OUTPUT_FILE=<file> node --import tsx scripts/duties/owner-messages.ts [--hours 24] [--end <ISO>]
 */
const DATA = process.env.CHAT_DATA_DIR ?? join(homedir(), ".prime/agent/browser-chat");
export const LABELS = join(DATA, "owner-messages", "labels.jsonl");
/** The 10-20 12 h read's 95th percentile reply wait was 25.3 min over 38 answered bursts, so a burst older than 30 min with no reply is a miss. */
const ANSWER_GRACE_MS = 30 * 60_000;
/**
 * The mark on an unlabeled line sent after the cutoff. Such a line counts from the next run, so a job whose run met every metric must still
 * label it: on 10-24 the 01:35Z run met, its job left the 00:54Z CI and RepoOps line unlabeled, and the 01:55Z run read unlabeled_lines 1.
 */
const UNCOUNTED = "not counted yet, label it in this run even when every metric is met, since the next run counts it; ";
const PLACES = [join(homedir(), ".prime/agent/sessions"), join(homedir(), ".cache/sieun-pi/hosts/mac/Users/sieunpark/.prime/agent/sessions")];

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const end = opt("--end") ? Date.parse(opt("--end")!) : Date.now();
const windowMs = Number(opt("--hours") ?? 24) * 3_600_000;
const start = end - windowMs;
const out = process.env.OUTPUT_FILE;
if (!out) { process.stderr.write("OUTPUT_FILE is not set\n"); process.exit(2); }

const readJson = <T>(file: string, fallback: T): T => { try { return JSON.parse(readFileSync(file, "utf8")) as T; } catch { return fallback; } };
const testChats = new Set(JSON.stringify(readJson(join(DATA, "clean-room-chats.json"), {})).match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []);
const chats = readJson<{ ids?: string[] }>(join(DATA, "chats.json"), {}).ids?.filter(id => !testChats.has(id)) ?? [];
const labels = new Map<string, { label: string; case?: string; by?: string; at?: string }>();
if (existsSync(LABELS)) for (const line of readFileSync(LABELS, "utf8").split("\n")) { try { const row = JSON.parse(line); if (row.id) labels.set(row.id, row); } catch { /* a torn line */ } }
type Run = { at?: number; job?: { name?: string }; cut?: { at?: number } };
const labelledBy = (run: Run): boolean => [...labels.values()].some(row => (row.by === run.job?.name || row.by?.startsWith(`${run.job?.name} (`))
  && Date.parse(row.at ?? "") >= run.at! && Date.parse(row.at ?? "") <= (run.cut?.at ?? Infinity));
const hadChance = (run: Run): boolean => Boolean(run.job) && typeof run.at === "number" && (!run.cut || labelledBy(run));
const cutoff = readJson<Run[]>(process.env.LAST_RUNS_FILE ?? "", []).find(hadChance)?.at ?? Infinity;

const textOf = (message: any): string => { try { return messageText(message).trim(); } catch { return ""; } };
const projector = new Projector({ put: () => "x", link: () => {} } as never);
async function branchSince(file: string, since: number): Promise<any[]> {
  let from = null; const pages: any[][] = [];
  for (;;) {
    const page = await readBranchPage(file, from, { messages: 2000, bytes: 16 * 1024 * 1024 });
    if (!page) return [];
    pages.unshift(page.entries);
    if (!page.before || (page.entries.length ? Date.parse(page.entries[0]!.timestamp) : 0) < since) break;
    from = page.before;
  }
  return pages.flat();
}

let needed = 0, unlabeled = 0, unanswered = 0;
const flagged: FlaggedSlice[] = [];
const noiseLines: { chat: string; at: number; labelled?: number; case: string; text: string }[] = [];
for (const chat of chats) {
  const file = PLACES.map(dir => join(dir, `${chat}.jsonl`)).find(existsSync);
  if (!file) continue;
  const messages = projector.messages(historyMessages(await branchSince(file, start - 6 * 3_600_000)));
  let owner = true, settled = true;
  const ownerTurn: boolean[] = [];
  const wakeOf: string[] = [];
  let wake = "";
  messages.forEach((message: any) => {
    const text = message.role === "user" ? textOf(message) : "";
    const begin = (who: boolean, head: string) => { owner = who; settled = false; wake = head.slice(0, 200); };
    if (message.role === "user" && text.includes(OWNER_RETRY_MARK) && serverNote(text)) begin(true, text);
    else if (message.role === "user" && serverNote(text)) { if (settled) begin(false, text); settled = false; }
    else if (message.role === "user") begin(true, text);
    else if (message.role === "assistant") settled = message.stopReason !== "toolUse";
    else if (message.role === "custom" && isPromptCustom(message)) { if (settled) begin(false, textOf(message)); settled = false; }
    ownerTurn.push(owner);
    wakeOf.push(wake);
  });
  const indexOf = new Map<string, number>();
  messages.forEach((_: unknown, index: number) => indexOf.set(lineId(messages, index), index));
  const lines = chatLines(messages).filter(line => (line.kind === "agent" || line.kind === "user") && !(line as { pending?: true }).pending);
  for (const line of lines) {
    if (line.kind !== "agent" || line.at < start || line.at >= end) continue;
    const index = indexOf.get(line.id.replace(/-t\d+$/, ""));
    if (index === undefined) continue;
    if (ownerTurn[index]) { needed++; continue; }
    const label = labels.get(line.id);
    if (label?.label === "needed") needed++;
    else if (label?.label === "noise") noiseLines.push({ chat, at: line.at, ...Number.isFinite(Date.parse(label.at ?? "")) ? { labelled: Date.parse(label.at!) } : {}, case: label.case ?? "noise", text: line.text });
    else { if (line.at < cutoff) unlabeled++; flagged.push({ kind: "unlabeled", chat, at: line.at, excerpt: `${line.at < cutoff ? "" : UNCOUNTED}id ${line.id}; wake: ${wakeOf[index]!.replace(/\s+/g, " ")}; sent: ${line.text.replace(/\s+/g, " ").slice(0, 600)}` }); }
  }
  const seq = lines.filter(line => line.at >= start - 6 * 3_600_000 && line.at < end);
  for (let k = 0; k < seq.length; k++) {
    const line = seq[k]!;
    if (line.kind !== "user" || line.at < start || line.at > end - ANSWER_GRACE_MS) continue;
    const next = seq[k + 1];
    if (next?.kind === "user" && next.at - line.at < OWNER_BURST_GAP_MS) continue;
    if (!seq.slice(k + 1).some(later => later.kind === "agent")) {
      unanswered++;
      flagged.push({ kind: "unanswered", chat, at: line.at, excerpt: `no reply to: ${line.text.replace(/\s+/g, " ").slice(0, 300)}` });
    }
  }
}
const noise = await splitNoise(noiseLines, gitCommitTime(fixRepos("")));
noise.forEach((line, index) => flagged.push({ kind: "noise", chat: noiseLines[index]!.chat, at: line.at, excerpt: `${line.case}, ${noiseSide(line)}: ${noiseLines[index]!.text.slice(0, 300)}` }));
const labelled = needed + noise.length;
const metrics = { needed_pct_24h: labelled ? Math.round(1000 * needed / labelled) / 10 : 100, unlabeled_lines: unlabeled, unanswered_bursts: unanswered, ...noiseMetrics(noise) };
const target = readJson<{ metrics: { key: string; target: number }[] }>(new URL("./owner-messages.duty.json", import.meta.url).pathname, { metrics: [] }).metrics.find(metric => metric.key === "needed_pct_24h")?.target ?? 90;
const aging = metrics.needed_pct_24h < target ? noiseAging(noise, needed, target, windowMs) : undefined;
const clock = (ms: number) => new Date(ms).toISOString().slice(5, 16).replace("T", " ") + "Z";
if (aging) flagged.push({ kind: "aging", at: aging.oldestLeaves, excerpt: `needed_pct_24h counts ${noise.length} noise lines in ${labelled}, so one line is ${aging.pointsPerLine} points. ` +
  `The oldest leaves the window at ${clock(aging.oldestLeaves)}. At ${target}% the ${needed} needed lines allow ${aging.allowed} noise ${aging.allowed === 1 ? "line" : "lines"}, so with no new noise ` +
  `and the same needed count the share meets the target at ${clock(aging.meetsAt)}.` });
writeFileSync(out, JSON.stringify({ metrics, flagged, lastEventAt: noiseLastEvent(noise) } satisfies PrecheckOutput, null, 1));
process.stdout.write(`${JSON.stringify(metrics)}\n`);
