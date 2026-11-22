// Counts, per UTC day, the owner's calls that failed or waited over 1 s within 20 s of an apps/chat restart or hand-over, from the request
// log (~/.pi/agent/chat/requests/<day>.jsonl) and the service's Started and Reloading lines in the user journal. The rules are in
// restart-walk-hits.ts, which duty d2 (scripts/duties/api-speed.ts) reads too; node runs that .ts file with its own type stripping.
// Usage: node restart-walk-count.mjs [--days 2026-11-22,2026-11-23] [--from <ISO time, counts only restarts and lines after it>] [--window <s>] [--slow <ms>] [--json]
//   [--requests <dir>] [--unit sieun-pi-apps-chat.service] [--journal <file of journalctl -o short-unix lines>]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { countRestartHits, parseOwnerLines, parseStarts } from "./restart-walk-hits.ts";

export { countRestartHits, failedLine, parseOwnerLines, parseStarts } from "./restart-walk-hits.ts";

function main(argv) {
  const opt = { from: 0, days: null, windowMs: 20_000, slowMs: 1000, json: false, requests: join(homedir(), ".pi/agent/chat/requests"), unit: "sieun-pi-apps-chat.service", journal: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--days") opt.days = argv[++i].split(",");
    else if (flag === "--from") opt.from = Date.parse(argv[++i]);
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
  const starts = parseStarts(journal).filter(at => at >= opt.from);
  // A line of a day's first 20 s can belong to a start of the day before, so read that file too.
  const prev = new Date(Date.parse(`${first}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
  const rows = [prev, ...opt.days, next].flatMap(d => (existsSync(join(opt.requests, `${d}.jsonl`)) ? parseOwnerLines(readFileSync(join(opt.requests, `${d}.jsonl`), "utf8")) : [])).filter(row => row.at >= opt.from);
  const counts = Object.fromEntries(Object.entries(countRestartHits(starts, rows, opt)).filter(([d]) => opt.days.includes(d)));
  if (opt.json) return console.log(JSON.stringify(counts, null, 1));
  for (const [d, c] of Object.entries(counts)) {
    console.log(`${d}: ${c.restarts} restarts, ${c.restartsHit} with a hit; ${c.failed} of his calls failed and ${c.slow} waited over ${opt.slowMs} ms within ${opt.windowMs / 1000} s of a start; away from restarts ${c.outsideFailed} failed and ${c.outsideSlow} waited`);
    for (const [route, n] of c.routes.slice(0, 8)) console.log(`  ${n} ${route}`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main(process.argv.slice(2));
