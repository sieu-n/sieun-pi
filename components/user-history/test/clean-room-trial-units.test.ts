// readme-preview run4 on 10-19: a job of the test chat made unit readme-4f1c45a, a second job remade it as an enabled unit file with
// RefuseManualStop, and teardown left it serving 7 h. Teardown ends only units the trial proved it made; a same-named unit of another job survives.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { type UnitIo, endUnits, readProofs, recordUnits } from "../scripts/clean-room/trial-units.ts";

const SETUP = Date.parse("2026-10-19T21:03:00Z");

/** A session file with one ipython call at `at` and its result 2 s later. */
function transcript(dir: string, session: string, calls: { at: string; code: string; result: string }[]): string {
  const file = join(dir, `${session}.jsonl`);
  writeFileSync(file, calls.flatMap((call, index) => [
    { type: "message", timestamp: call.at, message: { role: "assistant", content: [{ type: "toolCall", id: `c${index}`, name: "ipython", arguments: { code: call.code } }] } },
    { type: "message", timestamp: new Date(Date.parse(call.at) + 2000).toISOString(), message: { role: "toolResult", toolCallId: `c${index}`, content: [{ type: "text", text: call.result }] } },
  ]).map(line => JSON.stringify(line)).join("\n") + "\n");
  return file;
}

/** A user manager with these units; `refuse` units ignore stop, as RefuseManualStop does. */
function manager(units: Record<string, { InvocationID?: string; Transient?: string; ActiveState: string; FragmentPath?: string; refuse?: boolean }>) {
  const calls: string[] = [];
  const io: UnitIo = {
    show: async unit => { const { refuse: _, ...state } = units[unit] ?? { ActiveState: "inactive" }; return state as Record<string, string>; },
    run: async args => {
      calls.push(args.join(" "));
      const unit = args.at(-1)!;
      if (args[0] === "stop") { if (units[unit]?.refuse) return false; units[unit]!.ActiveState = "inactive"; }
      if (args[0] === "kill") units[unit]!.ActiveState = "inactive";
      return true;
    },
  };
  return { io, calls, units };
}

function rig() {
  const root = mkdtempSync(join(tmpdir(), "trial-units-"));
  const run = join(root, "run");
  const unitDir = join(root, "systemd/user");
  mkdirSync(run, { recursive: true });
  mkdirSync(unitDir, { recursive: true });
  return { root, run, unitDir, done: () => rmSync(root, { recursive: true, force: true }) };
}

test("a transient unit the trial started is stopped, and the same name started again by another job survives", async () => {
  const { root, run, done } = rig();
  const file = transcript(root, "01a155fe-22c3-7719-8508-9f2e225c8803", [{ at: "2026-10-19T21:09:03.216Z",
    code: "cmd=f\"systemd-run --user --unit=readme-4f1c45a --collect --same-dir -E PATH sh -c 'python3 -m http.server 7791'\"\nr=await bash(cmd)",
    result: "Running as unit: readme-4f1c45a.service; invocation ID: d9319682cde14c7497fe22b3d0db830c\n" }]);
  const other = transcript(root, "other-job", [{ at: "2026-10-19T21:20:00Z", code: "r=await bash('cat old.log')",
    result: "Running as unit: sampler.service; invocation ID: 11111111111111111111111111111111\n" }]);
  assert.deepEqual(recordUnits(run, [file, other], SETUP).map(proof => proof.kind === "transient" && proof.invocationId), ["d9319682cde14c7497fe22b3d0db830c"]);
  assert.equal(recordUnits(run, [file], SETUP).length, 0, "a second look records nothing new");

  const lines: string[] = [];
  const reused = manager({ "readme-4f1c45a.service": { InvocationID: "0123456789abcdef0123456789abcdef", Transient: "yes", ActiveState: "active" } });
  await endUnits(run, reused.io, line => lines.push(line));
  assert.deepEqual(reused.calls, [], "another job's readme-4f1c45a is never stopped");
  assert.match(lines.join("\n"), /kept unit readme-4f1c45a.service: its invocation 0123456789abcdef0123456789abcdef is not one/);

  const own = manager({ "readme-4f1c45a.service": { InvocationID: "d9319682cde14c7497fe22b3d0db830c", Transient: "yes", ActiveState: "active" } });
  await endUnits(run, own.io, () => {});
  assert.deepEqual(own.calls, ["stop -- readme-4f1c45a.service"]);
  done();
});

test("a unit file the trial wrote is disabled, deleted and killed through RefuseManualStop; one another job rewrote or wrote survives", async () => {
  const { root, run, unitDir, done } = rig();
  const unit = join(unitDir, "readme-4f1c45a.service");
  const foreign = join(unitDir, "sup-world.service");
  writeFileSync(unit, "[Unit]\nRefuseManualStop=yes\n[Service]\nExecStart=/usr/bin/python3 -m http.server 7791\nRestart=always\n");
  utimesSync(unit, new Date("2026-10-19T22:43:03Z"), new Date("2026-10-19T22:43:03Z"));
  writeFileSync(foreign, "[Service]\nExecStart=/bin/sleep infinity\n");
  utimesSync(foreign, new Date("2026-10-19T22:43:03Z"), new Date("2026-10-19T22:43:03Z"));
  const file = transcript(root, "01a15648-a280-75da-a675-e46a9754b81a", [{ at: "2026-10-19T22:43:02.034Z",
    code: "open(os.path.expanduser('~/.config/systemd/user/readme-4f1c45a.service'),'w').write(unit)\nr=await bash('systemctl --user daemon-reload && systemctl --user enable --now readme-4f1c45a')",
    result: "active\nenabled\n200\n" }]);
  const proofs = recordUnits(run, [file], SETUP, unitDir);
  assert.deepEqual(proofs.map(proof => proof.unit), ["readme-4f1c45a.service"], "a file written in the call's window but never named by it is not the trial's");

  writeFileSync(unit, "[Service]\nExecStart=/usr/bin/python3 -m http.server 9999\n");
  const changed = manager({ "readme-4f1c45a.service": { ActiveState: "active", FragmentPath: unit } });
  const lines: string[] = [];
  await endUnits(run, changed.io, line => lines.push(line));
  assert.deepEqual(changed.calls, [], "a unit file another job rewrote after the trial is kept");
  assert.ok(existsSync(unit));
  assert.match(lines.join("\n"), /content changed after the test chat wrote it/);

  writeFileSync(unit, "[Unit]\nRefuseManualStop=yes\n[Service]\nExecStart=/usr/bin/python3 -m http.server 7791\nRestart=always\n");
  const own = manager({ "readme-4f1c45a.service": { ActiveState: "active", FragmentPath: unit, refuse: true } });
  await endUnits(run, own.io, () => {});
  assert.deepEqual(own.calls, ["disable -- readme-4f1c45a.service", "daemon-reload", "stop -- readme-4f1c45a.service", "kill -- readme-4f1c45a.service", "reset-failed -- readme-4f1c45a.service"]);
  assert.equal(existsSync(unit), false);
  assert.ok(existsSync(foreign), "sup-world.service, which no session of the test chat wrote, stays");
  assert.equal(readProofs(run).length, 1);
  done();
});
