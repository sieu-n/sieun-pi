/**
 * The systemd user units a clean-room trial made, proven at creation, and their end at teardown. On 10-19 readme-preview run4's job made a
 * transient unit readme-4f1c45a, and a second job of the chat remade it as an enabled unit file with Restart=always and RefuseManualStop.
 * Teardown stopped only processes whose command line named the run folder, so the server ran 7 h past teardown until the verifier removed it.
 *
 * A unit is the trial's only by a proof recorded while the trial runs, never by its name or working directory:
 * - a transient unit by the invocation ID that systemd-run printed into a tool result of a session of the test chat, for a call that ran systemd-run;
 * - a unit file under ~/.config/systemd/user by the sha256 of the content a session of the test chat wrote, when the file's last write falls inside
 *   one of its tool calls that names that file.
 * Teardown stops a transient unit only while its invocation is a proven one, and removes a unit file only while it holds the proven content, so a
 * same-named unit another job started or rewrote survives.
 */
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { rawEntries } from "./detached-report.ts";

export type UnitProof =
  | { kind: "transient"; unit: string; invocationId: string; session: string; at: number }
  | { kind: "file"; unit: string; file: string; sha256: string; session: string; at: number };

/** `systemctl --user`: `show` answers the named properties, `run` whether a command exited 0. */
export interface UnitIo {
  show(unit: string, props: readonly string[]): Promise<Record<string, string>>;
  run(args: readonly string[]): Promise<boolean>;
}

export const USER_UNIT_DIR = join(homedir(), ".config/systemd/user");
const PROOFS = "units.json";
const STARTED = /Running as unit: (\S+?);? invocation ID: ([0-9a-f]{32})/g;
const UNIT_FILE = /\.(service|timer|socket|path)$/;

export function readProofs(run: string): UnitProof[] {
  const file = join(run, PROOFS);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as UnitProof[] : [];
}

const sha256 = (file: string): string => createHash("sha256").update(readFileSync(file)).digest("hex");

/**
 * Adds to `<run>/units.json` the units the sessions in `transcripts` (files of sessions of the test chat) proved they made, and returns the new
 * proofs. Unit files are read from `unitDir`; one written before `since` (the run's setup) is never the trial's.
 */
export function recordUnits(run: string, transcripts: readonly string[], since: number, unitDir = USER_UNIT_DIR): UnitProof[] {
  const proofs = readProofs(run);
  const added: UnitProof[] = [];
  const calls: { session: string; at: number; resultAt: number; input: string }[] = [];
  for (const file of transcripts) {
    const session = basename(file, ".jsonl");
    const entries = rawEntries(file);
    const started = new Map<string, { at: number; input: string }>();
    for (const entry of entries) for (const call of entry.calls) started.set(call.id, { at: entry.at, input: call.input });
    for (const entry of entries) {
      if (!entry.result) continue;
      const call = started.get(entry.result.id);
      if (!call) continue;
      calls.push({ session, at: call.at, resultAt: entry.at, input: call.input });
      if (!call.input.includes("systemd-run")) continue;
      for (const [, unit, invocationId] of entry.result.text.matchAll(STARTED)) {
        if (proofs.some(proof => proof.kind === "transient" && proof.invocationId === invocationId)) continue;
        const proof: UnitProof = { kind: "transient", unit: unit!, invocationId: invocationId!, session, at: entry.at };
        proofs.push(proof);
        added.push(proof);
      }
    }
  }
  for (const name of existsSync(unitDir) ? readdirSync(unitDir) : []) {
    const file = join(unitDir, name);
    if (!UNIT_FILE.test(name) || !lstatSync(file).isFile()) continue;
    const mtime = statSync(file).mtimeMs;
    if (mtime < since) continue;
    const sha = sha256(file);
    if (proofs.some(proof => proof.kind === "file" && proof.file === file && proof.sha256 === sha)) continue;
    const call = calls.find(one => one.at <= mtime && mtime <= one.resultAt && one.input.includes(`systemd/user/${name}`));
    if (!call) continue;
    const proof: UnitProof = { kind: "file", unit: name, file, sha256: sha, session: call.session, at: Math.round(mtime) };
    proofs.push(proof);
    added.push(proof);
  }
  if (added.length) writeFileSync(join(run, PROOFS), JSON.stringify(proofs, null, 1));
  return added;
}

const ACTIVE = new Set(["active", "activating", "reloading", "deactivating"]);

/**
 * Ends the units `<run>/units.json` proves the trial made: stops a transient unit whose running invocation is a proven one, and for a unit file
 * whose content is still the last the trial wrote, disables it, deletes it, reloads, and stops what still runs from it (with `kill` when the file
 * set RefuseManualStop). Everything else is kept and logged with the reason.
 */
export async function endUnits(run: string, io: UnitIo, say: (line: string) => void): Promise<void> {
  const proofs = readProofs(run);
  const invocations = new Map<string, Set<string>>();
  for (const proof of proofs) if (proof.kind === "transient") invocations.set(proof.unit, (invocations.get(proof.unit) ?? new Set()).add(proof.invocationId));
  for (const [unit, ids] of invocations) {
    const state = await io.show(unit, ["InvocationID", "Transient", "ActiveState"]);
    if (!ACTIVE.has(state.ActiveState ?? "")) continue;
    if (!ids.has(state.InvocationID ?? "")) { say(`kept unit ${unit}: its invocation ${state.InvocationID || "(none)"} is not one a session of the test chat started`); continue; }
    say(await io.run(["stop", "--", unit]) ? `stopped unit ${unit} (invocation ${state.InvocationID})` : `stop unit ${unit} failed`);
  }
  const latest = new Map<string, UnitProof & { kind: "file" }>();
  for (const proof of proofs) if (proof.kind === "file" && (latest.get(proof.file)?.at ?? -1) <= proof.at) latest.set(proof.file, proof);
  for (const proof of latest.values()) {
    if (!existsSync(proof.file)) continue;
    if (sha256(proof.file) !== proof.sha256) { say(`kept unit file ${proof.file}: its content changed after the test chat wrote it`); continue; }
    await io.run(["disable", "--", proof.unit]);
    rmSync(proof.file, { force: true });
    await io.run(["daemon-reload"]);
    say(`disabled and deleted the unit file ${proof.file}`);
    let state = await io.show(proof.unit, ["ActiveState", "FragmentPath"]);
    if (!ACTIVE.has(state.ActiveState ?? "")) continue;
    if (state.FragmentPath && state.FragmentPath !== proof.file) { say(`kept unit ${proof.unit} running: it now runs from ${state.FragmentPath}`); continue; }
    if (!await io.run(["stop", "--", proof.unit])) await io.run(["kill", "--", proof.unit]);
    state = await io.show(proof.unit, ["ActiveState"]);
    await io.run(["reset-failed", "--", proof.unit]);
    say(ACTIVE.has(state.ActiveState ?? "") ? `unit ${proof.unit} still runs after stop and kill` : `stopped unit ${proof.unit}`);
  }
}

const systemctl = (args: readonly string[]): Promise<{ ok: boolean; output: string }> => new Promise(resolve =>
  execFile("systemctl", ["--user", ...args], { maxBuffer: 1024 * 1024 }, (error, stdout) => resolve({ ok: !error, output: String(stdout ?? "").trim() })));

/** The box's own user manager. */
export const userSystemd: UnitIo = {
  show: async (unit, props) => Object.fromEntries((await systemctl(["show", "-p", props.join(","), "--", unit])).output.split("\n").filter(Boolean)
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])),
  run: async args => (await systemctl(args)).ok,
};
