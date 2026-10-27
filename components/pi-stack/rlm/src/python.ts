import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The vendored Prime runtime. Its `src` goes first on the kernel's PYTHONPATH, so an installed `rlm` package never shadows it. */
export const RUNTIME_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "python");
export const RUNTIME_SRC = join(RUNTIME_DIR, "src");
/** The Prime bundled skills pi-rlm ships: goal, compact and edit. */
export const BUNDLED_SKILLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "skills");

const BASE_PACKAGES = ["dill", "tyro", "mcp>=2,<3"];

/** A loaded Pi skill that carries a Python package, so the kernel imports it by name at start. */
export interface PythonSkill {
  name: string;
  importName: string;
  dir: string;
  src: string;
}

/** Finds the Python package of a skill dir: `pyproject.toml` next to `SKILL.md` and `src/<name with - as _>/`, or the only package in `src/`. */
export function pythonSkillOf(name: string, dir: string): PythonSkill | undefined {
  if (!existsSync(join(dir, "pyproject.toml"))) return undefined;
  const src = join(dir, "src");
  if (!existsSync(src)) return undefined;
  const wanted = name.replace(/-/g, "_");
  if (existsSync(join(src, wanted, "__init__.py"))) return { name, importName: wanted, dir, src };
  const packages = readdirSync(src).filter(entry => existsSync(join(src, entry, "__init__.py")));
  if (packages.length === 1) return { name, importName: packages[0]!, dir, src };
  return undefined;
}

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", d => (output += d));
    child.stderr.on("data", d => (output += d));
    child.on("error", reject);
    child.on("exit", code => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} ${args.join(" ")} exited ${code}:\n${output.slice(-3000)}`))));
  });
}

const building = new Map<string, Promise<string>>();

function fingerprint(skills: PythonSkill[]): string {
  const h = createHash("sha256");
  h.update(JSON.stringify(BASE_PACKAGES));
  for (const skill of [...skills].sort((a, b) => a.dir.localeCompare(b.dir))) {
    const pyproject = join(skill.dir, "pyproject.toml");
    h.update(`${skill.dir}\0${readFileSync(pyproject, "utf8")}\0`);
  }
  return h.digest("hex");
}

async function withLock<T>(lockDir: string, fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try {
      mkdirSync(lockDir);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockDir).mtimeMs > 15 * 60_000) rmSync(lockDir, { recursive: true, force: true });
      } catch {}
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockDir}`);
      await new Promise(r => setTimeout(r, 500));
    }
  }
  try {
    return await fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}

/**
 * The kernel's Python. `PI_RLM_PYTHON` wins. Otherwise pi-rlm keeps a uv venv at `<agentDir>/rlm/kernel-venv` with dill, tyro, mcp and every
 * Python skill installed, and rebuilds it when the skill set's `pyproject.toml` files change.
 */
export async function kernelPython(agentDir: string, skills: PythonSkill[], onProgress: (text: string) => void = () => {}): Promise<{ python: string; binDir?: string }> {
  const override = process.env.PI_RLM_PYTHON?.trim();
  if (override) return { python: override };
  const venv = join(agentDir, "rlm", "kernel-venv");
  const python = join(venv, "bin", "python");
  const marker = join(venv, ".pi-rlm-fingerprint");
  const want = fingerprint(skills);
  const current = () => existsSync(python) && existsSync(marker) && readFileSync(marker, "utf8") === want;
  if (current()) return { python, binDir: join(venv, "bin") };
  let job = building.get(venv);
  if (!job) {
    mkdirSync(dirname(venv), { recursive: true });
    job = withLock(`${venv}.lock`, async () => {
      if (current()) return python;
      const env = { ...process.env, UV_PYTHON_PREFERENCE: "managed" };
      onProgress("Creating the Python kernel environment...");
      if (!existsSync(python)) await run("uv", ["venv", "--quiet", "--python", "3.11", venv], env);
      onProgress("Installing Python kernel packages...");
      await run("uv", ["pip", "install", "--quiet", "--python", python, ...BASE_PACKAGES, ...skills.map(s => s.dir)], env);
      writeFileSync(marker, want);
      return python;
    }).finally(() => building.delete(venv));
    building.set(venv, job);
  }
  await job;
  return { python, binDir: join(venv, "bin") };
}
