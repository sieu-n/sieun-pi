// Guards owner rule c119: each machine has one checkout and one dev branch, dev/sieun on us-metal02 and dev/sieun-mac on the Mac. The owner
// repeated it on 2026-10-27 ("NO one machine should have one worktree. dev/sieun for metal-02, dev/sieun-mac for mac") after a Mac brief of
// 10-22 gave each job its own dev/sieun-mac-<job> branch and 34 such branches reached origin, while the ledger line, the board skill and the
// duties still named dev/sieun-mac-a, sieun/dev or "any dev/<name>". Every check below fails on the tip before this fix.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { briefCheck, briefCheckNote } from "../src/shared/brief-check.ts";
import { upsertDuty } from "../src/shared/chat-duties.ts";
import { dutyStrayBranches, harnessStrayBranches, MACHINE_BRANCHES, strayBranches } from "../src/shared/machine-branches.ts";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../../../..");
const brief = (line: string): string => `Split: none, one output.\n\n${line}`;

test("the machine branches pass and every other dev/sieun-* name, dev/<name> and new-job-checkout.sh are stray", () => {
  assert.deepEqual(MACHINE_BRANCHES, { "us-metal02": "dev/sieun", mac: "dev/sieun-mac" });
  assert.deepEqual(strayBranches("Commit on dev/sieun-mac and push origin dev/sieun-mac. The box works on dev/sieun."), []);
  assert.deepEqual(strayBranches("Add a folder under apps/virev-demo/overlay/src/routes/dev/<area>/ for the page."), []);
  assert.deepEqual(strayBranches("Demo work goes on dev/sieun-mac-a. Each job pushes dev/sieun-mac-ui-kit-email, or any dev/<name>."),
    ["dev/sieun-mac-a", "dev/sieun-mac-ui-kit-email", "dev/<name>"]);
  assert.deepEqual(strayBranches("Run ~/work/virev-dev/new-job-checkout.sh crm once."), ["new-job-checkout.sh"]);
  assert.deepEqual(strayBranches("The old per-job branch dev/sieun-mac-staging-proof had no push. Retire dev/sieun-mac-a."), []);
  assert.deepEqual(strayBranches("Read the local sieun/dev tip."), []);
  assert.deepEqual(strayBranches("Read the local sieun/dev tip.", { retiredShared: true }), ["sieun/dev"]);
});

test("the 10-22 Mac briefs that made per-job branches fail the brief check, and the note names c119", () => {
  const ukit = "Where you work (owner t24, replaces the us-metal02 rules)\n1. Read Mac ~/work/virev-dev/HOWTO.md now. Run `~/work/virev-dev/new-job-checkout.sh " +
    "ui-kit-<your part>` once (for example ui-kit-email). It makes your own clone at ~/work/virev-dev-ui-kit-<your part> on branch dev/sieun-mac-ui-kit-<your part>.";
  const workspace = "Base it on origin/sieun/dev's tip, so it has every job's work, and give it its own dev branch, for example dev/sieun-mac-mm.";
  for (const text of [ukit, workspace]) {
    const findings = briefCheck(brief(text));
    assert.equal(findings.at(-1)?.kind, "stray-branch", text);
    assert.match(briefCheckNote("page-campaigns", findings), /names a branch the owner retired \(c119\)[\s\S]*dev\/sieun-mac on the Mac/);
  }
  assert.deepEqual(briefCheck(brief("Commit the demo change on dev/sieun-mac in ~/Documents/Github/auto-sns-agent and push it.")), []);
});

test("a duty that names a retired branch is refused, and the owner's quoted words stay free", () => {
  const duty = {
    name: "Demo branch on GitHub", ownerWords: "> dev/sieun-mac-a에 커밋하고 CI 없이 origin에 백업으로 푸시\n\nyes.", goal: "Demo work reaches GitHub within a day.",
    metrics: [{ key: "oldest_unpushed_h", label: "Hours the oldest commit on the Mac's branch has waited", op: "<=", target: 24, headline: true }],
    precheck: { command: ["sh", "-c", "b=$(git config agent.branch); git log origin/${b}..${b}"], cwd: "/tmp" },
    onMiss: "Push the Mac's branch dev/sieun-mac as a fast-forward.", schedule: { kind: "daily", at: "06:04" },
  };
  assert.match(upsertDuty([], duty, 0), /^added d1$/);
  assert.throws(() => upsertDuty([], { ...duty, onMiss: "Push dev/sieun-mac-a as a fast-forward." }, 0), /names "dev\/sieun-mac-a"\. Each machine has one checkout/);
  assert.throws(() => upsertDuty([], { ...duty, goal: "Every blog change on the local sieun/dev tip reaches GitHub." }, 0), /names "sieun\/dev"/);
});

test("no checked-in duty, skill or rule file names a retired branch", () => {
  const duties = join(root, "legacy/prime/user-history/scripts/duties");
  const faults: string[] = [];
  for (const file of readdirSync(duties).filter(name => name.endsWith(".duty.json"))) {
    const stray = dutyStrayBranches(JSON.parse(readFileSync(join(duties, file), "utf8")));
    if (stray.length) faults.push(`${file}: ${stray.join(", ")}`);
  }
  const texts = [join(root, "config/AGENTS.md"), join(root, "AGENTS.md")];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".md")) texts.push(join(dir, entry.name));
    }
  };
  walk(join(root, "skills"));
  for (const file of texts) {
    const stray = strayBranches(readFileSync(file, "utf8"), { retiredShared: true });
    if (stray.length) faults.push(`${file.slice(root.length + 1)}: ${stray.join(", ")}`);
  }
  assert.deepEqual(faults, []);
  assert.match(readFileSync(join(root, "skills/board/references/git.md"), "utf8"), /every chat and job on the Mac commits on dev\/sieun-mac, with no per-job or per-session branch/);
});

test("a harness entry that names a retired branch is a fault, and the published store holds none", t => {
  const note = (title: string, content: string) => ({ id: "x", title, content });
  const state = { entries: {
    prompt: {
      c119_v1: note("Each developer works on their own dev/<name> branch", "1. Demo frontend work lives on the owner's Mac. Commit it on dev/sieun-mac-a in logical commits and push to origin as a backup."),
      c119_v2: note("One checkout and one dev branch per machine", "us-metal02 uses dev/sieun, and the Mac uses dev/sieun-mac. Never create a per-job branch, clone or worktree."),
    },
    memory: { frontend_bro: note("Frontend bro owns p1", "The frontend bro chat owns only p1: the 5180 design sandbox apps in apps/virev-demo on dev/sieun-mac-a.") },
    skill: "not a map",
  } };
  assert.deepEqual(harnessStrayBranches(state), ["prompt:c119_v1: dev/<name>, dev/sieun-mac-a", "memory:frontend_bro: dev/sieun-mac-a"]);
  assert.deepEqual(harnessStrayBranches(null), []);

  // Every Prime kernel's digest loads the published global store; RLM_GLOBAL_HARNESS_STATE_DIR points a clean-room trial at its own copy.
  const store = join(process.env.RLM_GLOBAL_HARNESS_STATE_DIR ?? join(homedir(), ".prime/agent/harness"), "harness_state.json");
  if (!existsSync(store)) return t.skip(`no harness store at ${store}`);
  assert.deepEqual(harnessStrayBranches(JSON.parse(readFileSync(store, "utf8"))), [],
    "update each listed global entry with rlm.harness.update_prompt_note or update_memory (global_=True) to name dev/sieun or dev/sieun-mac");
});
