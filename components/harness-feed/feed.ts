#!/usr/bin/env node
// harness-feed: the coding harness's health as OTLP metrics to this box's Alloy (127.0.0.1:14318), every 30 s.
//   node components/harness-feed/feed.ts [--once] [--dry-run] [--only <group,...>]
// Each reader in readers/ reads one signal group from files this box already writes (the chat's browser-chat folder, pi-pool,
// the Prime daemon, /proc and cgroups) and returns samples. Alloy maps service.name "harness" to job="harness" and adds box.
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { payload, type Context, type Sample } from "./otlp.ts";
import { READERS } from "./readers/index.ts";

const ENDPOINT = process.env.HARNESS_FEED_ENDPOINT ?? "http://127.0.0.1:14318/v1/metrics";
// 30 s, the interval the owner's brief set; the dashboard reads last_over_time(...[2m]).
const INTERVAL_MS = 30_000;

export function chatHostLive(home: string): boolean {
  try {
    const { pid } = JSON.parse(readFileSync(join(home, ".prime/agent/browser-chat/instance.json"), "utf8")) as { pid?: unknown };
    if (typeof pid !== "number") return false;
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** One round: every reader at once, plus one ok gauge and one duration gauge per reader, so a broken reader shows on the dashboard. */
export async function round(ctx: Context, readers = READERS, only: string[] | null = null): Promise<{ samples: Sample[]; errors: Record<string, string> }> {
  const samples: Sample[] = [];
  const errors: Record<string, string> = {};
  const entries = Object.entries(readers).filter(([group]) => !only || only.includes(group));
  await Promise.all(entries.map(async ([group, read]) => {
    const started = performance.now();
    let ok = 1;
    try {
      samples.push(...await read(ctx));
    } catch (error) {
      ok = 0;
      errors[group] = error instanceof Error ? error.stack ?? error.message : String(error);
    }
    samples.push({ name: "harness.feed.reader_ok", kind: "gauge", help: "1 when the reader's last round read without an error.", value: ok, labels: { group } },
      { name: "harness.feed.reader_duration", kind: "gauge", unit: "s", help: "How long the reader's last round took.", value: (performance.now() - started) / 1000, labels: { group } });
  }));
  tagRunsOn(samples);
  return { samples, errors };
}

/** The `box` label Alloy gives a host whose hosts.json name differs from it: the Mac's Alloy labels its series box="mbp". */
const ALLOY_BOX: Record<string, string> = { mac: "mbp" };

/**
 * Gives every sample with a `chat` label a `runs_on` label, the box whose Prime daemon runs that chat, in the dashboard's `box` naming, and a
 * sample with a `host` label and no chat the box that host names. The chat service on one box reads the chats and boxes of every box, so the
 * board's box selector filters those series on `runs_on` instead of the sender's `box`. The chat map comes from the tokens reader's chat cost
 * samples, which read it from the session copy each chat's row is in.
 */
export function tagRunsOn(samples: Sample[]): void {
  const boxOf = new Map<string, string>();
  for (const sample of samples) {
    const runsOn = sample.labels?.runs_on;
    if (sample.name !== "harness.tokens.chat_cost_usd" || !runsOn || !sample.labels?.chat) continue;
    boxOf.set(sample.labels.chat, ALLOY_BOX[runsOn] ?? runsOn);
  }
  for (const sample of samples) {
    const { chat, host } = sample.labels ?? {};
    const box = chat !== undefined ? boxOf.get(chat) : host !== undefined ? ALLOY_BOX[host] ?? host : undefined;
    if (box) sample.labels = { ...sample.labels, runs_on: box };
  }
}

async function send(body: object): Promise<string | null> {
  try {
    const response = await fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return response.ok ? null : `HTTP ${response.status} ${(await response.text()).slice(0, 200)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { once: { type: "boolean", default: false }, "dry-run": { type: "boolean", default: false }, only: { type: "string" } } });
  const home = homedir();
  const host = hostname().replace(/\.local$/, "");
  const startNs = BigInt(Date.now()) * 1_000_000n;
  const resource = { "service.name": "harness", "service.instance.id": `harness-feed-${host}`, "host.name": host };
  const state = new Map<string, unknown>();
  const only = values.only ? values.only.split(",") : null;
  const stamp = () => new Date().toISOString().slice(0, 19) + "Z";
  console.log(`${stamp()} harness-feed started on ${host}, readers ${Object.keys(READERS).join(", ")}`);
  for (;;) {
    const started = Date.now();
    const cpuBefore = process.cpuUsage();
    const ctx: Context = { home, host, platform: process.platform, now: started, chatHost: chatHostLive(home), state };
    const { samples, errors } = await round(ctx, READERS, only);
    for (const [group, error] of Object.entries(errors)) console.error(`${stamp()} ${group} failed: ${error}`);
    const cpu = process.cpuUsage(cpuBefore);
    samples.push({ name: "harness.feed.round_cpu", kind: "gauge", unit: "s", help: "CPU seconds the feed spent on its last round.", value: (cpu.user + cpu.system) / 1e6 },
      { name: "harness.feed.rss", kind: "gauge", unit: "By", help: "The feed's own resident memory.", value: process.memoryUsage.rss() },
      { name: "harness.feed.chat_host", kind: "gauge", help: "1 when this box runs the live chat service.", value: ctx.chatHost ? 1 : 0 });
    const body = payload(samples, resource, startNs, BigInt(Date.now()) * 1_000_000n);
    if (values["dry-run"]) console.log(JSON.stringify(body, null, 1));
    else {
      const error = await send(body);
      if (error) console.error(`${stamp()} export failed: ${error}`);
    }
    if (values.once) return;
    await new Promise(resolve => setTimeout(resolve, Math.max(1000, INTERVAL_MS - (Date.now() - started))));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) await main();
