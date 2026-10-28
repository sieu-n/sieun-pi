// Guards d7's side of the Mac's kernel_task minutes from 19:10Z to 19:23Z on 10-29. From 19:05Z to 19:17Z the owner's Aside grew from 5.17 to
// 10.22 GB while 15 of its 17 tabs were live 5180 jobs', his Chrome grew 1.75 GB and Helium none, and d7 put 7 of the 8 minutes on the owner's
// side, since the pressure feed sums every Aside process into one browser:aside owner in Browsers beside his Chrome and Helium.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentAsideGb, type HostView, minuteSide } from "../scripts/duties/whole-system.ts";
import { type AsideTabs, type Footprints, hostWatchLine, type UsableReading } from "../src/mac-usable-watch.ts";

const HELPER = new URL("../src/worker-footprint.py", import.meta.url).pathname;

/** The Mac's watch readings at 19:16:30Z and 19:17:30Z on 10-29, owners and groups as the pressure feed gave them. */
const at1916: UsableReading = { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 102.6,
  owners: [{ owner: "browser:chrome", label: "Google Chrome", gb: 11.74 }, { owner: "browser:helium", label: "Helium", gb: 9.68 },
    { owner: "browser:aside", label: "Aside", gb: 9.11 }, { owner: "other:rest", label: "rest", gb: 3.9 },
    { owner: "chat:01a11ba8-9d2c-727c-8ded-38f819ca9f29", label: "frontend bro", gb: 3.2 }, { owner: "other:ChatGPT", label: "ChatGPT", gb: 3.04 }],
  groups: { browsers: 30.99, other: 11.76, agents: 5.56, coding: 1.4, dev: 2.4, system: 5.7 } };
const at1917: UsableReading = { pressureLevel: 2, swapoutsPerS: 0, kernelTaskPct: 100.6,
  owners: [{ owner: "browser:chrome", label: "Google Chrome", gb: 11.75 }, { owner: "browser:aside", label: "Aside", gb: 10.22 },
    { owner: "browser:helium", label: "Helium", gb: 9.66 }, { owner: "other:rest", label: "rest", gb: 3.86 },
    { owner: "chat:01a11ba8-9d2c-727c-8ded-38f819ca9f29", label: "frontend bro", gb: 3.37 }, { owner: "other:ChatGPT", label: "ChatGPT", gb: 3.04 }],
  groups: { browsers: 32.1, other: 11.62, agents: 5.65, coding: 1.4, dev: 2.35, system: 5.81 } };
const view = (usable: UsableReading, workerGb: number, asideTabs?: AsideTabs): HostView =>
  ({ name: "mac", usable, workers: 2, workerGb, top: [], ...asideTabs ? { asideTabs } : {} });

test("a kernel_task minute whose growth was the agents' Aside tabs goes to the harness", () => {
  const tabs = { agent: 15, all: 17 };
  assert.equal(agentAsideGb(view(at1917, 4.61, tabs)), 9.02);
  assert.equal(minuteSide(view(at1917, 4.61, tabs), { view: view(at1916, 5.23, tabs), gapMs: 60_000 }), "harness");
});

test("with no tab count, or no agent tab, Aside stays with the owner's browsers", () => {
  assert.equal(minuteSide(view(at1917, 4.61), { view: view(at1916, 5.23), gapMs: 60_000 }), "other");
  const none = { agent: 0, all: 17 };
  assert.equal(agentAsideGb(view(at1917, 4.61, none)), 0);
  assert.equal(minuteSide(view(at1917, 4.61, none), { view: view(at1916, 5.23, none), gapMs: 60_000 }), "other");
});

test("the Mac's watch line keeps the helper's Aside tab count and drops a malformed one", async () => {
  const footprints = (aside: unknown): Footprints => ({ workers: {}, kernels: [], swap_used_bytes: 0, pressure_level: 2, cpu_s: 0, aside_tabs: aside as AsideTabs });
  const read = async (aside: unknown) => await hostWatchLine({ name: "mac", rows: [], read: async () => ({ usable: null, footprints: footprints(aside) }) },
    { now: Date.parse("2026-10-28T19:17:30Z"), chats: new Set(), title: () => null });
  assert.deepEqual((await read({ agent: 15, all: 17 })).asideTabs, { agent: 15, all: 17 });
  for (const bad of [null, { agent: 18, all: 17 }, { agent: 1, all: 0 }, { agent: "3", all: 4 }]) assert.equal((await read(bad)).asideTabs, undefined);
});

test("the footprint helper counts the open tabs agent records name, and reads none off macOS or when Aside does not answer", () => {
  const owners = mkdtempSync(join(tmpdir(), "aside-owners-"));
  writeFileSync(join(owners, "a.json"), JSON.stringify({ owner: "/s/sub-1", tabs: { T1: "http://[::1]:5180/app", T9: "http://localhost:5180/closed" } }));
  writeFileSync(join(owners, "b.json"), JSON.stringify({ owner: "/s/sub-2", tabs: { T2: "http://localhost:5180/app/campaigns" } }));
  writeFileSync(join(owners, ".aside-tabs-x"), "{");
  const script = `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location("wf", sys.argv[1]); wf = importlib.util.module_from_spec(spec); spec.loader.exec_module(wf)
live = lambda: {"T1", "T2", "OWNER_GMAIL"}
print(json.dumps([wf.aside_tabs(sys.argv[2], live, "darwin"), wf.aside_tabs(sys.argv[2], live, "linux"), wf.aside_tabs(sys.argv[2], lambda: None, "darwin")]))`;
  const [mac, linux, silent] = JSON.parse(execFileSync("python3", ["-c", script, HELPER, owners], { encoding: "utf8" })) as unknown[];
  assert.deepEqual(mac, { agent: 2, all: 3 });
  assert.equal(linux, null);
  assert.equal(silent, null);
});
