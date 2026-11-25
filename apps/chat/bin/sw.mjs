#!/usr/bin/env node
/**
 * `sw`: the sw factory command line. `sw skills <command>` is a thin client of the skills routes on the chat server (apps/chat
 * server/http.ts, /api/skills/*), so agents, the Settings > Skills page, the review app and the scheduled scan all make the same calls.
 * The server is SW_URL, else http://127.0.0.1:5184. Add --json to any command to print the server's answer as it is.
 */
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";

const HELP = `sw skills <command>

  list                       every skill with its owner, source, installs, verdicts and 30-day use
  check                      where the disk differs from the DB
  apply [--dry-run]          make the disk match the DB; a second run changes nothing
  scan [--wait]              scan both boxes now, and with --wait print the view when it ends
  install <name> --box <box> --runtime <prime|pi-host|claude|codex|pi> [--agent <id>] [--mode link|copy] [--path <dir>] [--source <skill id>]
  remove <copy id | install id | skill id>
  adopt <copy id> [--skill <skill id>]
  move <install id> <new path>
  merge <skill id> --into <skill id>
  own <skill id> <owner | agent id>
  undo <move id>
  moves                      the last changes, newest first

sw db                        every kind of record moved into chat.sqlite, its records against its JSON files
sw <kind> check              one kind, such as rooms: each JSON file the DB has not seen or whose export is behind
sw <kind> apply [--dry-run]  write the JSON exports that are behind the DB; a second run changes nothing

sw backup check|run [--b2] runs apps/chat/scripts/chat-backup.mjs on this box (the chat data dir's nightly backup).

Options: --json prints the answer as JSON. SW_URL sets the server (default http://127.0.0.1:5184).`;

const base = (process.env.SW_URL ?? "http://127.0.0.1:5184").replace(/\/+$/, "");

async function call(method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!response.ok) {
    const reason = data && typeof data === "object" && "error" in data ? data.error : text;
    throw new Error(`${method} ${path} answered ${response.status}: ${reason}`);
  }
  return data;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function printChange(change) {
  console.log(`${change.move.id}  ${change.move.summary}`);
  for (const step of change.apply?.steps ?? []) console.log(`  ${step.result.padEnd(7)} ${step.step.padEnd(7)} ${step.box}:${step.path}${step.note ? `  (${step.note})` : ""}`);
  console.log(change.move.undoneAt ? `Undone at ${change.move.undoneAt}.` : `Undo with: sw skills undo ${change.move.id}`);
}

function printApply(result) {
  console.log(`${result.dryRun ? "Would change" : "Changed"} ${plural(result.changes, "thing")}${result.moveId ? ` (move ${result.moveId})` : ""}.`);
  for (const step of result.steps) console.log(`  ${step.result.padEnd(7)} ${step.step.padEnd(7)} ${step.box}:${step.path}${step.note ? `  (${step.note})` : ""}`);
}

function printView(view) {
  const c = view.counts;
  console.log(`${c.skills} skills, ${c.copies} copies, ${c.installs} installs. Useful ${c.useful}, duplicated ${c.duplicated}, outdated ${c.outdated}, bloated ${c.bloated}, never used ${c.neverUsed}, drift ${c.drift}.`);
  console.log(`${plural(c.oldClones, "more skill sits", "more skills sit")} only in old clones and count in none of these.`);
  if (view.usefulDefinition) console.log(view.usefulDefinition);
  const local = iso => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  for (const box of view.boxes) {
    const line = box.state === "ok" ? `scanned ${local(box.scannedAt)}` : box.lastOkAt ? `asleep or offline since ${local(box.since ?? box.scannedAt)}, showing its scan from ${local(box.lastOkAt)}` : "has not answered a scan yet";
    console.log(`${box.box}: ${line}`);
  }
}

function printList(view) {
  printView(view);
  for (const s of view.skills) {
    const rules = [...new Set(s.verdicts.filter(v => v.action !== "note" || ["duplicate", "near-duplicate", "outdated", "stale-clone", "bloated"].includes(v.rule)).map(v => v.rule))];
    const owner = s.owner.kind === "owner" ? "owner" : s.owner.id;
    console.log([s.name.padEnd(28), owner.padEnd(18), `${s.installs.length} inst`.padEnd(8), `${s.use.uses} uses`.padEnd(11), rules.join(",").padEnd(24), s.id].join(" "));
  }
}

function printCheck(check) {
  console.log(check.items.length ? `${plural(check.items.length, "drift item")}:` : "No drift: the disk matches the DB.");
  for (const item of check.items) {
    const where = "copyId" in item ? item.copyId : item.kind === "gone" ? `${item.skillId}  (its folder left its repo's main branch)` : `${item.installId} ${item.box}:${item.path}`;
    console.log(`  ${item.kind.padEnd(10)} ${where}  fix: ${item.fix.join(" or ")}`);
  }
  if (check.offline.length) console.log(`Offline, showing their last good scan: ${check.offline.join(", ")}`);
}

function printMoveCheck(check) {
  const behind = check.items.length ? `, ${plural(check.items.length, "file")} to settle` : ", every file matches";
  const week = check.exportUntil ? `exports until ${check.exportUntil}` : "not imported yet";
  console.log(`${check.kind}: ${check.db} records in chat.sqlite, ${check.json} in ${plural(check.files, "JSON file")}${behind}; ${week}.`);
  for (const item of check.items) console.log(`  ${item.state.padEnd(8)} ${item.file}  json ${item.json ?? "-"}, db ${item.db}  fix: ${item.fix}`);
}

/** `sw db` and `sw <kind> check|apply` for a kind of record moved from the JSON files into chat.sqlite (server/json-move.ts). */
async function records(area, command, values) {
  const out = (data, print) => (values.json ? console.log(JSON.stringify(data, null, 2)) : print(data));
  if (area === "db") return out(await call("GET", "/api/db"), data => (data.kinds.length ? data.kinds.forEach(printMoveCheck) : console.log("No kind of record has moved into chat.sqlite yet.")));
  const kind = encodeURIComponent(area);
  if (command === "check") return out(await call("GET", `/api/db/${kind}/check`), printMoveCheck);
  if (command === "apply") {
    return out(await call("POST", `/api/db/${kind}/apply`, { dryRun: values["dry-run"] === true }), r => {
      console.log(`${r.dryRun ? "Would write" : "Wrote"} ${plural(r.exported.length, "JSON export")} and ${r.dryRun ? "would move" : "moved"} ${plural(r.archived.length, "file")} to json-archive.`);
      for (const item of r.left) console.log(`  left ${item.state.padEnd(8)} ${item.file}  fix: ${item.fix}`);
    });
  }
  console.log(HELP);
  return 2;
}

/** `sw backup check|run [...]`: runs scripts/chat-backup.mjs on this box, beside this file in the same release or checkout. */
function backup(args) {
  const script = new URL("../scripts/chat-backup.mjs", import.meta.url).pathname;
  return spawnSync(process.execPath, [script, ...args], { stdio: "inherit" }).status ?? 1;
}

async function main(argv) {
  if (argv[0] === "backup") return backup(argv.slice(1));
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" }, "dry-run": { type: "boolean" }, wait: { type: "boolean" }, help: { type: "boolean", short: "h" },
      box: { type: "string" }, runtime: { type: "string" }, agent: { type: "string" }, mode: { type: "string" }, path: { type: "string" },
      source: { type: "string" }, skill: { type: "string" }, into: { type: "string" },
    },
  });
  const [area, command, ...args] = positionals;
  if (area && area !== "skills" && !values.help) return records(area, command, values);
  if (values.help || area !== "skills" || !command) {
    console.log(HELP);
    return area === "skills" || values.help ? 0 : 2;
  }
  const out = (data, print) => (values.json ? console.log(JSON.stringify(data, null, 2)) : print(data));
  const need = (value, what) => {
    if (!value) throw new Error(`sw skills ${command} needs ${what}.`);
    return value;
  };
  switch (command) {
    case "list":
      return out(await call("GET", "/api/skills"), printList);
    case "check":
      return out(await call("GET", "/api/skills/check"), printCheck);
    case "apply":
      return out(await call("POST", "/api/skills/apply", { dryRun: values["dry-run"] === true }), printApply);
    case "scan": {
      const { scan } = await call("POST", "/api/skills/scan");
      if (!values.wait) return out({ scan }, data => console.log(data.scan.running ? "Scan started." : `Scan state: ${JSON.stringify(data.scan)}`));
      for (;;) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const view = await call("GET", "/api/skills");
        if (!view.scan.running) return out(view, data => (data.scan.error ? console.log(`The scan failed: ${data.scan.error}`) : printView(data)));
      }
    }
    case "install":
      return out(await call("POST", "/api/skills/install", {
        name: need(args[0], "a skill name"), box: need(values.box, "--box"), runtime: need(values.runtime, "--runtime"), agent: values.agent ?? null,
        mode: values.mode === "copy" ? "copy" : "link", path: values.path ?? null, source: values.source ?? null,
      }), printChange);
    case "remove":
      return out(await call("POST", "/api/skills/remove", { target: need(args[0], "a copy, install or skill id") }), printChange);
    case "adopt":
      return out(await call("POST", "/api/skills/adopt", { copyId: need(args[0], "a copy id"), skillId: values.skill ?? null }), printChange);
    case "move":
      return out(await call("POST", "/api/skills/move", { installId: need(args[0], "an install id"), path: need(args[1] ?? values.path, "a new path") }), printChange);
    case "merge":
      return out(await call("POST", "/api/skills/merge", { skillId: need(args[0], "a skill id"), into: need(values.into, "--into") }), printChange);
    case "own":
      return out(await call("POST", "/api/skills/own", { skillId: need(args[0], "a skill id"), owner: need(args[1], "an owner") }), printChange);
    case "undo":
      return out(await call("POST", "/api/skills/undo", { moveId: need(args[0], "a move id") }), printChange);
    case "moves":
      return out(await call("GET", "/api/skills/moves"), data => data.moves.forEach(m => console.log(`${m.id}  ${m.at}  ${m.kind.padEnd(7)} ${m.summary}${m.undoneAt ? "  (undone)" : ""}`)));
    default:
      console.log(HELP);
      return 2;
  }
}

main(process.argv.slice(2)).then(code => {
  process.exitCode = code ?? 0;
}, error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
