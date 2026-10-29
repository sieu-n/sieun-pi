/**
 * The durable kernel venv carries Prime's package set.
 * 1. pi-rlm installs what Prime's kernel bootstrap installs before any skill: the runtime package, `dill` and Prime's default packages,
 *    read from prime-agent's own module.
 * 2. On a box that has both venvs, the packages that Prime's spec pulls in (its runtime, `dill`, its default packages and the Python
 *    skills its `.bootstrap-version` lists, with all their dependencies) are the same in pi-host's durable venv as in Prime's. Packages an
 *    agent added by hand with `uv pip install` are outside that set, so they do not count. On 10-29 attach_image failed in a pi-host
 *    thread with "attach_image needs Pillow", because pi-host left the skills that need prime-agent-runtime and Prime's default packages out.
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { kernelPackages, RUNTIME_DIR } from "../../../pi-rlm/src/core/python.ts";

const PRIME_VENV = process.env.PRIME_KERNEL_VENV ?? join(homedir(), ".prime/agent/kernel-venv");
const DURABLE_VENV = process.env.PI_HOST_KERNEL_VENV ?? join(homedir(), ".prime/agent/pi-host/durable/rlm/kernel-venv");

const norm = (name: string) => name.replace(/[-_.]+/g, "-").toLowerCase();

/** Each installed distribution of a venv and the names it requires. */
function installed(venv: string): Map<string, string[]> {
  const code = [
    "import json, re, importlib.metadata as m",
    "out = {}",
    "for d in m.distributions():",
    "    reqs = [re.match(r'[A-Za-z0-9_.-]+', r).group(0) for r in (d.requires or []) if 'extra ==' not in r]",
    "    out[d.metadata['Name']] = reqs",
    "print(json.dumps(out))",
  ].join("\n");
  const out = JSON.parse(execFileSync(join(venv, "bin", "python"), ["-c", code], { encoding: "utf8" })) as Record<string, string[]>;
  return new Map(Object.entries(out).map(([name, reqs]) => [norm(name), reqs.map(norm)]));
}

/** The installed packages reachable from `roots` through their requirements. */
function closure(packages: Map<string, string[]>, roots: string[]): string[] {
  const seen = new Set<string>();
  const queue = roots.map(norm);
  for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
    if (seen.has(name) || !packages.has(name)) continue;
    seen.add(name);
    queue.push(...packages.get(name)!);
  }
  return [...seen].sort();
}

const projectName = (pyproject: string) => /^\s*name\s*=\s*["']([^"']+)["']/m.exec(readFileSync(pyproject, "utf8"))?.[1];

test("pi-rlm installs what Prime's kernel bootstrap installs before any skill", async () => {
  const index = import.meta.resolve("prime-agent");
  const prime = (await import(new URL("./core/kernel/bootstrap.js", index).href)) as { DEFAULT_RLM_EXTRA_UV_ARGS: string[] };
  assert.deepEqual(await kernelPackages(), [RUNTIME_DIR, "dill", ...prime.DEFAULT_RLM_EXTRA_UV_ARGS]);
  assert.equal(projectName(join(RUNTIME_DIR, "pyproject.toml")), "prime-agent-runtime");
});

const both = existsSync(join(PRIME_VENV, ".bootstrap-version")) && existsSync(join(DURABLE_VENV, "bin", "python"));
test("pi-host's durable kernel venv has the packages Prime's spec puts in Prime's kernel venv", { skip: both ? false : "this box has no Prime and pi-host kernel venvs" }, () => {
  const spec = JSON.parse(readFileSync(join(PRIME_VENV, ".bootstrap-version"), "utf8")) as {
    snapshot?: string; extraUvArgs?: string[]; pythonSkills?: { importName: string; pyprojectPath: string }[];
  };
  const roots = [
    "prime-agent-runtime", spec.snapshot ?? "dill", ...(spec.extraUvArgs ?? []),
    ...(spec.pythonSkills ?? []).map(skill => (existsSync(skill.pyprojectPath) && projectName(skill.pyprojectPath)) || skill.importName),
  ];
  const prime = closure(installed(PRIME_VENV), roots);
  const durable = closure(installed(DURABLE_VENV), roots);
  assert.deepEqual({ missing: prime.filter(name => !durable.includes(name)), extra: durable.filter(name => !prime.includes(name)) }, { missing: [], extra: [] });
});
