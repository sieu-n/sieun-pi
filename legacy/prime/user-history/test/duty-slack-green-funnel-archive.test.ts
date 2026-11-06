// 11-06 09:30 KST: d1 read source_errors 4, because slack-green #496 made setup_acquisition_dashboard.py read
// packages/frontend/src/lib/blog-cta-rules.json and the precheck extracted only the two script folders.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { readFunnel, type FunnelDeps } from "../scripts/duties/slack-green-funnel.ts";

const run = promisify(execFile);

test("the extracted scripts can read blog-cta-rules.json, as setup_acquisition_dashboard.py does since #496", async () => {
  const repo = await mkdtemp(join(tmpdir(), "sg-funnel-archive-"));
  try {
    await mkdir(join(repo, "scripts/seo-agent"), { recursive: true });
    await mkdir(join(repo, "scripts/posthog"), { recursive: true });
    await mkdir(join(repo, "packages/frontend/src/lib"), { recursive: true });
    await writeFile(join(repo, "scripts/seo-agent/conversion_targets.py"), "\n");
    await writeFile(join(repo, "scripts/posthog/setup_acquisition_dashboard.py"), [
      "import json", "from pathlib import Path",
      "RULES = json.loads((Path(__file__).resolve().parents[2] / 'packages/frontend/src/lib/blog-cta-rules.json').read_text())", "",
    ].join("\n"));
    await writeFile(join(repo, "packages/frontend/src/lib/blog-cta-rules.json"), JSON.stringify({ offTopicSlugWords: ["teams"] }));
    const wrapper = join(repo, "wrapper.py");
    await writeFile(wrapper, [
      "import json, sys", "sys.path.insert(0, sys.argv[1] + '/../posthog')", "import setup_acquisition_dashboard as d",
      "print(json.dumps({'words': d.RULES['offTopicSlugWords']}))", "",
    ].join("\n"));
    for (const args of [["init", "-q"], ["add", "scripts", "packages"], ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "x"]])
      await run("git", ["-C", repo, ...args]);
    const exec: FunnelDeps["exec"] = async (file, args, options) => (await run(file, [...args], { cwd: options?.cwd, env: { ...process.env, ...options?.env } })).stdout;
    const report = await readFunnel({ exec, now: Date.now, repo, python: "python3", wrapper, env: { POSTHOG_PERSONAL_API_KEY: "phx_test" } }, "HEAD");
    assert.deepEqual(report, { words: ["teams"] });
  } finally { await rm(repo, { recursive: true, force: true }); }
});
