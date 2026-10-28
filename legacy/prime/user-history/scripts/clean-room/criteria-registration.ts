import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type { Verdict } from "./session-read.ts";

/**
 * The criteria's registration, which setup writes from the clock and the file before it makes the chat. On 10-27 w81-waiting-session run2's
 * criteria said "Written 2026-10-27 23:58Z" by hand while the file was written at 23:53:59Z, and chat-2572's controlled run3 had the same slip.
 * So nobody types a time or a hash into a criteria file: setup copies it to `<run>/criteria.md` and records when and with what sha256 in
 * `<run>/criteria.registration.json`, and the judge fails a run whose criteria text changed after that.
 */
export interface CriteriaRegistration {
  /** When setup registered the criteria, from the clock (ISO). */
  registeredAt: string;
  /** The sha256 of the criteria text setup copied into `<run>/criteria.md`. */
  sha256: string;
  bytes: number;
  /** The file setup copied, as `~/...` when it sits under the home folder, so a rejudge with HOME at the unpacked archive never reads the live one. */
  source: string;
}

export const REGISTRATION_FILE = "criteria.registration.json";

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

function homeForm(path: string): string {
  const inside = relative(homedir(), resolve(path));
  return inside && !inside.startsWith("..") && !inside.startsWith(sep) ? `~/${inside.split(sep).join("/")}` : resolve(path);
}

const homePath = (path: string): string => path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;

/**
 * Registers `source` as the run's criteria: copies it to `<run>/criteria.md` and writes the time and sha256. A setup run again with the same
 * run folder keeps the first registration when the text is the same, and refuses when the text changed, since the run is judged on the first.
 */
export function registerCriteria(run: string, source: string, now: number = Date.now()): CriteriaRegistration {
  const bytes = readFileSync(source);
  const file = join(run, REGISTRATION_FILE);
  if (existsSync(file)) {
    const earlier = JSON.parse(readFileSync(file, "utf8")) as CriteriaRegistration;
    if (earlier.sha256 !== sha256(bytes)) {
      throw new Error(`${run}: ${source} reads sha256 ${sha256(bytes)}, not the ${earlier.sha256} setup registered at ${earlier.registeredAt}, so start a new run folder`);
    }
    return earlier;
  }
  const registration: CriteriaRegistration = { registeredAt: new Date(now).toISOString(), sha256: sha256(bytes), bytes: bytes.length, source: homeForm(source) };
  writeFileSync(join(run, "criteria.md"), bytes);
  writeFileSync(file, `${JSON.stringify(registration, null, 2)}\n`);
  return registration;
}

/** The registration setup wrote, or undefined for a run set up before setup recorded one. */
export function readRegistration(run: string): CriteriaRegistration | undefined {
  const file = join(run, REGISTRATION_FILE);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as CriteriaRegistration : undefined;
}

/**
 * The changes to the criteria since setup registered them: the run's copy, and the source file while it still exists under this HOME. Empty
 * when nothing changed or the run has no registration.
 */
export function criteriaChanges(run: string): string[] {
  const registration = readRegistration(run);
  if (!registration) return [];
  const changes: string[] = [];
  const copy = join(run, "criteria.md");
  const found = existsSync(copy) ? sha256(readFileSync(copy)) : "missing";
  if (found !== registration.sha256) changes.push(`${copy} reads sha256 ${found}`);
  const source = homePath(registration.source);
  if (existsSync(source) && resolve(source) !== resolve(copy)) {
    const now = sha256(readFileSync(source));
    if (now !== registration.sha256) changes.push(`${registration.source} reads sha256 ${now}`);
  }
  return changes;
}

/**
 * The scenario's verdict with the criteria check on top: a run whose criteria changed after registration fails whatever the scenario found, and
 * a registered run's verdict names when and on which sha256 setup registered its criteria.
 */
export function withCriteriaCheck(run: string, judged: { verdict: Verdict; text: string }): { verdict: Verdict; text: string } {
  const registration = readRegistration(run);
  if (!registration) return judged;
  const changes = criteriaChanges(run);
  const line = `Setup registered the criteria at ${registration.registeredAt} with sha256 ${registration.sha256.slice(0, 12)} (${REGISTRATION_FILE}).`;
  const [head, ...rest] = judged.text.split("\n");
  if (!changes.length) return { verdict: judged.verdict, text: [head, "", line, ...rest].join("\n") };
  const failed = /^# .*: (pass|fail|void|open)\s*$/.test(head ?? "") ? head!.replace(/(pass|fail|void|open)\s*$/, "fail") : head;
  const why = `${line} The criteria text changed after that, so the run fails whatever the scenario's judge found (it found ${judged.verdict}): ${changes.join("; ")}.`;
  return { verdict: "fail", text: [failed, "", why, ...rest].join("\n") };
}
