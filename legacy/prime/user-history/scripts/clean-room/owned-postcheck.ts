#!/usr/bin/env node
/**
 * The cleanup half of the readme-preview clean-room run: after `clean-room.ts evaluate` judged the run and tore it down, this reads what the
 * chat's jobs recorded (`<run>.owned.json`, which the judge wrote) and checks that the chat service's job-end cleanup released it and kept the
 * shared evidence, with the chat still archived. It writes `<run>.cleanup.<verdict>.md` next to the run folder and changes nothing.
 *
 *   node --import tsx scripts/clean-room/owned-postcheck.ts --run <dir>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chatLog, DATA, jobDirs, released, sha256, unitState } from "./owned-evidence.ts";
import { CHECKOUT, LOG, LOG_SHA256, type OwnedSnapshot } from "./readme-preview.ts";

const flag = process.argv.indexOf("--run");
const run = flag > 0 ? process.argv[flag + 1] : undefined;
if (!run) throw new Error("--run <dir> is required");
const snapshot = JSON.parse(readFileSync(`${run}.owned.json`, "utf8")) as OwnedSnapshot;
const checks: { id: string; ok: boolean | null; detail: string }[] = [];
const add = (id: string, ok: boolean | null, detail: string) => checks.push({ id, ok, detail });
const yes = (ok: boolean | null): string => ok === null ? "not reached yet" : ok ? "met" : "not met";
const ids = (file: string): string[] => existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as { ids?: string[] }).ids ?? [] : [];

const jobs = jobDirs(snapshot.chat);
const ended = jobs.filter(job => job.status === "deleted");
add("p", jobs.length > 0 && ended.length === jobs.length ? true : null, `${ended.length} of ${jobs.length} jobs of the chat are marked deleted: ${jobs.map(job => `${job.name} ${job.status}`).join("; ")}`);

const freed = released(chatLog(snapshot.chat));
const watched = snapshot.paths.filter(path => snapshot.present.includes(path) || snapshot.released.includes(path));
const left = watched.filter(path => existsSync(path));
const unlogged = watched.filter(path => !existsSync(path) && !freed.paths.includes(path));
const units = snapshot.units.map(unit => [unit, unitState(unit)] as const);
const running = units.filter(([, state]) => ["active", "activating", "reloading"].includes(state));
add("d", !watched.length ? null : left.length || running.length ? (checks[0]!.ok ? false : null) : unlogged.length ? false : true,
  `recorded paths the job left after its report: ${watched.join(", ") || "none"}; still there: ${left.join(", ") || "none"}; gone with no service line: ${unlogged.join(", ") || "none"}; ` +
  `units ${units.map(([unit, state]) => `${unit} ${state}`).join(", ") || "none"}`);

const scratch = join(homedir(), "scratch") + "/";
const stray = freed.paths.filter(path => !(path.startsWith(scratch) || path.startsWith("/tmp/")) || !snapshot.paths.includes(path));
add("e", stray.length ? false : freed.paths.length ? true : null, stray.length ? `the service deleted paths outside the record or the roots: ${stray.join(", ")}`
  : `the service deleted ${freed.paths.join(", ") || "nothing"} and stopped ${freed.units.join(", ") || "no unit"} for the chat, each in a job's record`);

const shared = [
  [`the release log keeps its bytes (${sha256(LOG).slice(0, 8)})`, sha256(LOG) === LOG_SHA256],
  ["the sieun-pi checkout and its release helper stay", existsSync(join(CHECKOUT, ".git")) && existsSync(join(CHECKOUT, "scripts/release-chat.mjs"))],
  ["the live release stays", existsSync(join(homedir(), ".local/share/sieun-pi-chat/current/release.json"))],
  ...snapshot.work.map(dir => [`the job's ~/work folder ${dir} stays`, existsSync(dir)] as [string, boolean]),
] as [string, boolean][];
add("f", shared.every(([, ok]) => ok), shared.map(([what, ok]) => `${what}: ${ok ? "yes" : "NO"}`).join("; "));

const archived = ids(join(DATA, "archived-chats.json")).includes(snapshot.chat) && !ids(join(DATA, "chats.json")).includes(snapshot.chat);
add("h", archived, archived ? "the chat stays archived and out of the live chat list" : "the chat is live again or not archived");

const verdict = checks.some(check => check.ok === false) ? "fail" : checks.some(check => check.ok === null) ? "open" : "pass";
const out = `${run}.cleanup.${verdict}.md`;
writeFileSync(out, [`# Cleanup check of ${run.split("/").at(-1)}: ${verdict}`, "",
  `Checked at ${new Date().toISOString()} by owned-postcheck.ts from ${run}.owned.json (written by the in-run judge at ${snapshot.at}) and the chat's service.log lines.`, "",
  ...checks.map(check => `- ${check.id} ${yes(check.ok)}: ${check.detail}`), "",
  "## The chat's service.log lines that deleted or stopped something", "", ...freed.lines.map(line => `- ${line.slice(0, 600)}`), ""].join("\n"));
process.stdout.write(`${out}\n`);
