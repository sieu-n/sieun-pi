import { readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Pins the source folder of every Python skill in ~/.prime/agent/skills in one `.pth` file of the kernel venv, so `import websearch`,
 * `import board` and `import aside_browser` keep working while Prime reinstalls those skills.
 *
 * Why (p254, duty d5, 10-18): Prime's kernel setup keeps a list of installed skills in kernel-venv/.bootstrap-version and rewrites it with the
 * skill set of whichever session boots a kernel. Sessions boot with different sets (the 05:18 list has no refine), so every boot after a
 * different set runs `uv pip install --editable <skill>` again. uv then deletes the old `_editable_impl_<name>.pth` and dist-info before it
 * writes the new ones: refine was reinstalled at 04:58:02, 05:17 and 05:22:18. In 20 reinstalls of an unchanged toy skill with uv 0.11.1,
 * a 1 ms poller saw its `.pth` missing 5 times, for 2 to 10 ms each. A reinstall cut between the delete and the write leaves the module gone until
 * the next kernel with that skill set boots. On 10-18 websearch, board and aside_browser failed to import at 04:35 and came back at 04:49,
 * the first kernel boots after the 04:48:44 daemon restart.
 *
 * The file name starts with "00_" because Python's site module reads .pth files in sorted order and puts their folders on sys.path in that
 * order. Under the old name, sieun_pi_skills.pth, the folders came after every `_editable_impl_*.pth`. So when Prime's kernel setup put its
 * bundled Serper websearch back (prime-agent-skill-websearch, at 15:12:31Z on 10-19 on us-metal02), `import websearch` loaded that copy, and
 * Box tools parity read websearch_kernel off. The pin goes first now, so our skills win over a bundled copy of the same module name. A pin
 * left under the old name is removed.
 *
 * When a pinned folder holds sieun_pi_agent_env.py (skills/board/src), the pin ends with `import sieun_pi_agent_env`, which loads
 * ~/.config/sieun-pi/agent.env into os.environ at every kernel start. On 10-21 the daemon, started at 11:19Z, still handed every kernel
 * the RAILWAY_API_TOKEN that Railway refused since 10-18, after agent.env got a working one. The import line comes last because Python's
 * site module skips the rest of a .pth file after a line that fails.
 *
 * uv deletes only the files listed in a package's RECORD, so it never deletes this file. Prime deletes it only when it rebuilds the whole
 * venv for a new runtime; the Skills and tools duty check websearch_kernel writes it again on its next run.
 */

export const PIN_FILE = "00_sieun_pi_skills.pth";
/** The pin's name before 10-19, which sorted after the editable installs; pinSkillPaths removes it. */
export const OLD_PIN_FILE = "sieun_pi_skills.pth";

/** The module in skills/board/src that loads ~/.config/sieun-pi/agent.env; the pin imports it when a pinned folder has it. */
export const ENV_MODULE = "sieun_pi_agent_env";

export interface PinResult { file: string; written: boolean; paths: string[] }

export function kernelVenv(home: string = homedir()): string {
  return process.env.PRIME_AGENT_KERNEL_VENV || join(home, ".prime/agent/kernel-venv");
}

const isDir = (path: string) => stat(path).then(info => info.isDirectory(), () => false);
const isFile = (path: string) => stat(path).then(info => info.isFile(), () => false);

/** The real `src` folder of each skill under `skillsDir` that has a pyproject.toml, sorted; symlinks are followed. */
export async function skillSourcePaths(skillsDir: string): Promise<string[]> {
  const names = await readdir(skillsDir).catch(() => [] as string[]);
  const paths = await Promise.all(names.map(async name => {
    const skill = join(skillsDir, name);
    if (!await isFile(join(skill, "pyproject.toml")) || !await isDir(join(skill, "src"))) return undefined;
    return realpath(join(skill, "src")).catch(() => undefined);
  }));
  return [...new Set(paths.filter((path): path is string => Boolean(path)))].sort();
}

/** Each site-packages folder of the venv, one per lib/python3.N folder. */
export async function sitePackages(venv: string): Promise<string[]> {
  const libs = (await readdir(join(venv, "lib")).catch(() => [] as string[])).filter(name => /^python3\.\d+$/.test(name)).sort();
  const folders = libs.map(name => join(venv, "lib", name, "site-packages"));
  return (await Promise.all(folders.map(async folder => await isDir(folder) ? folder : undefined))).filter((folder): folder is string => Boolean(folder));
}

/**
 * Writes PIN_FILE into each site-packages folder of the venv when its text differs, through a temporary file and a rename, so a kernel that
 * starts meanwhile reads the old text or the new text and never half a file. An empty skill list, such as an unreadable skills folder, keeps
 * the file as it is.
 */
export async function pinSkillPaths(options: { home?: string; venv?: string; skillsDir?: string } = {}): Promise<PinResult[]> {
  const home = options.home ?? homedir();
  const venv = options.venv ?? kernelVenv(home);
  const paths = await skillSourcePaths(options.skillsDir ?? join(home, ".prime/agent/skills"));
  const loader = (await Promise.all(paths.map(path => isFile(join(path, `${ENV_MODULE}.py`))))).some(Boolean);
  const text = `${[...paths, ...loader ? [`import ${ENV_MODULE}`] : []].join("\n")}\n`;
  return Promise.all((await sitePackages(venv)).map(async folder => {
    const file = join(folder, PIN_FILE);
    if (paths.length) await rm(join(folder, OLD_PIN_FILE), { force: true });
    const before = await readFile(file, "utf8").catch(() => undefined);
    if (!paths.length || before === text) return { file, written: false, paths };
    const temporary = join(folder, `.${PIN_FILE}.${process.pid}.tmp`);
    await writeFile(temporary, text, { mode: 0o644 });
    await rename(temporary, file);
    return { file, written: true, paths };
  }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const results = await pinSkillPaths();
  if (!results.length) { process.stderr.write(`kernel-skill-paths: no lib/python3.*/site-packages under ${kernelVenv()}\n`); process.exit(1); }
  for (const result of results) process.stdout.write(`${result.written ? "wrote" : "unchanged"} ${result.file}: ${result.paths.length} skill source folders\n`);
}
