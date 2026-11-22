// Counts, per UTC day, the owner's calls that failed or waited over 1 s around an apps/chat restart, from the request log
// (~/.pi/agent/chat/requests/<day>.jsonl) and the service's start lines in the user journal.
// His calls are the page's own lines (src client) that came through tailscale serve (via tailnet); walks and duties on the box log as
// local. A client line is written when its batch reaches the server: at once for a failed call, whose batch the page posts again 10 s
// later while the server is down, and within the page's 10 s timer otherwise (web/src/lib/api/client.ts sendTimings). So a call made
// within 10 s of a start reaches the log within 20 s of it, and that is the window. A call failed when its status is 0 or 500 and up, or
// it names an error. A slow one waited over 1 s and was a wait of his: background reads (bg ahead or shown) are left out of slow.
// Usage: node restart-walk-count.mjs [--days 2026-11-22,2026-11-23] [--since-start <s>] [--window <s>] [--slow <ms>] [--json]
//   [--requests <dir>] [--unit sieun-pi-apps-chat.service] [--journal <file of journalctl -o short-unix lines>]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** Start times (ms) from `journalctl -o short-unix` lines: each "Started <unit>" line. */
export function parseStarts(text) {
  return text.split("\n").filter(line => / Started /.test(line)).map(line => Math.round(Number(line.split(" ")[0]) * 1000)).filter(Number.isFinite).sort((a, b) => a - b);
}

/** The request log lines that are the owner's page calls: src client, via tailnet, not the timings post itself. */
export function parseOwnerLines(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.includes('"tailnet"') || !line.includes('"client"')) continue;
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.src === "client" && row.via === "tailnet" && row.r !== "/api/timings" && Number.isFinite(row.at)) out.push(row);
  }
  return out;
}

export const failedLine = row => Boolean(row.err) || row.s === 0 || row.s >= 500;

/**
 * Per day of the restart: how many restarts there were, how many had one of his calls fail or wait, and the counts, with the routes. A
 * line belongs to the latest start at or before it, when it came within `windowMs` of that start.
 */
export function countRestartHits(starts, rows, { windowMs = 20_000, slowMs = 1000 } = {}) {
  const days = {};
  const day = at => new Date(at).toISOString().slice(0, 10);
  for (const start of starts) (days[day(start)] ??= { restarts: 0, restartsHit: 0, failed: 0, slow: 0, outsideFailed: 0, outsideSlow: 0, routes: {}, hit: new Set() }).restarts++;
  for (const row of rows) {
    const failed = failedLine(row);
    const slow = !failed && row.ms > slowMs && !row.bg;
    if (!failed && !slow) continue;
    let i = -1;
    for (let lo = 0, hi = starts.length - 1; lo <= hi;) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= row.at) { i = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const near = i >= 0 && row.at - starts[i] <= windowMs;
    const d = (days[day(near ? starts[i] : row.at)] ??= { restarts: 0, restartsHit: 0, failed: 0, slow: 0, outsideFailed: 0, outsideSlow: 0, routes: {}, hit: new Set() });
    if (!near) {
      d[failed ? "outsideFailed" : "outsideSlow"]++;
      continue;
    }
    d[failed ? "failed" : "slow"]++;
    d.hit.add(i);
    const key = `${row.m} ${row.r}`;
    d.routes[key] = (d.routes[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(days).sort().map(([name, d]) => {
    const { hit, ...rest } = d;
    return [name, { ...rest, restartsHit: hit.size, routes: Object.entries(d.routes).sort((a, b) => b[1] - a[1]) }];
  }));
}

function main(argv) {
  const opt = { days: null, windowMs: 20_000, slowMs: 1000, json: false, requests: join(homedir(), ".pi/agent/chat/requests"), unit: "sieun-pi-apps-chat.service", journal: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--days") opt.days = argv[++i].split(",");
    else if (flag === "--window") opt.windowMs = Number(argv[++i]) * 1000;
    else if (flag === "--slow") opt.slowMs = Number(argv[++i]);
    else if (flag === "--json") opt.json = true;
    else if (flag === "--requests") opt.requests = argv[++i];
    else if (flag === "--unit") opt.unit = argv[++i];
    else if (flag === "--journal") opt.journal = argv[++i];
    else throw new Error(`unknown option ${flag}`);
  }
  opt.days ??= readdirSync(opt.requests).filter(name => /^\d{4}-\d\d-\d\d\.jsonl$/.test(name)).map(name => name.slice(0, 10)).sort().slice(-3);
  const first = opt.days[0], last = opt.days.at(-1);
  const next = new Date(Date.parse(`${last}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  const journal = opt.journal ? readFileSync(opt.journal, "utf8")
    : spawnSync("journalctl", ["--user", "-u", opt.unit, "-o", "short-unix", "--no-pager", "--since", `${first} 00:00:00 UTC`, "--until", `${next} 00:00:20 UTC`], { encoding: "utf8", maxBuffer: 1 << 28 }).stdout;
  const starts = parseStarts(journal);
  // A line of a day's first 20 s can belong to a start of the day before, so read that file too.
  const prev = new Date(Date.parse(`${first}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const rows = [prev, ...opt.days, next].flatMap(d => (existsSync(join(opt.requests, `${d}.jsonl`)) ? parseOwnerLines(readFileSync(join(opt.requests, `${d}.jsonl`), "utf8")) : []));
  const counts = Object.fromEntries(Object.entries(countRestartHits(starts, rows, opt)).filter(([d]) => opt.days.includes(d)));
  if (opt.json) return console.log(JSON.stringify(counts, null, 1));
  for (const [d, c] of Object.entries(counts)) {
    console.log(`${d}: ${c.restarts} restarts, ${c.restartsHit} with a hit; ${c.failed} of his calls failed and ${c.slow} waited over ${opt.slowMs} ms within ${opt.windowMs / 1000} s of a start; away from restarts ${c.outsideFailed} failed and ${c.outsideSlow} waited`);
    for (const [route, n] of c.routes.slice(0, 8)) console.log(`  ${n} ${route}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
