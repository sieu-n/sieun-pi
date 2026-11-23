import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { overlayHooks } from "../../scripts/spec-clean/overlay.mjs";

const dir = mkdtempSync(join(tmpdir(), "spec-clean-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const release = join(dir, "release/apps/chat");
mkdirSync(join(release, "server"), { recursive: true });
mkdirSync(join(release, "test"), { recursive: true });
writeFileSync(join(release, "package.json"), '{ "type": "module" }\n');
writeFileSync(join(release, "server/swapped.ts"), 'export const name: string = "release";\n');
writeFileSync(join(release, "server/kept.ts"), 'export const name: string = "release kept";\n');
writeFileSync(join(release, "test/helpers.ts"), "export const helper = 1;\n");
writeFileSync(join(release, "test/x.spec.ts"), 'import "./helpers.ts";\n');
const source = join(dir, "source.ts");
writeFileSync(source, 'export const name: string = "overlay";\n');
const spec = join(dir, "x.spec.ts");
writeFileSync(spec, 'import "./helpers.ts";\n');
const url = (path: string) => pathToFileURL(join(release, path)).href;
const files = new Map([["server/swapped.ts", source], ["test/x.spec.ts", spec]]);

/** Node's default load, reduced to reading the file at the URL. */
const read = (href: string) => ({ format: "module-typescript" as const, source: `// read ${fileURLToPath(href)}` });
const loading = { conditions: [], format: undefined, importAttributes: {} };
const from = (parentURL?: string) => ({ conditions: [], importAttributes: {}, parentURL });

test("source mode serves a swapped file's source for its release URL and leaves an unnamed file alone", () => {
  const { load } = overlayHooks({ release, files }, "source");
  const swapped = load(url("server/swapped.ts"), loading, read);
  assert.equal(swapped.source, 'export const name: string = "overlay";\n');
  assert.equal(swapped.format, "module-typescript", "the swap keeps the format the release file loads with");
  assert.equal(load(url("server/kept.ts"), loading, read).source, `// read ${join(release, "server/kept.ts")}`);
});

test("redirect mode resolves a swapped test file to its source, and the source's imports to the release's files", () => {
  const { resolve } = overlayHooks({ release, files }, "redirect");
  const next = (specifier: string, context?: { parentURL?: string | undefined }) => ({ url: new URL(specifier, context?.parentURL).href, format: "module-typescript" as const });
  assert.equal(resolve(url("test/x.spec.ts"), from(), next).url, pathToFileURL(spec).href);
  assert.equal(resolve("./helpers.ts", from(pathToFileURL(spec).href), next).url, url("test/helpers.ts"), "a relative import resolves beside the release path");
  assert.equal(resolve(url("server/kept.ts"), from(), next).url, url("server/kept.ts"));
});

test("register.mjs swaps a release file under tsx, keeps an unnamed one, and loads a file only the overlay has", () => {
  const added = join(dir, "added.ts");
  writeFileSync(added, 'enum E { One = 1 }\nexport const name = `added ${E.One}`;\n');
  const main = join(dir, "main.mjs");
  writeFileSync(main, ["swapped.ts", "kept.ts", "added.ts"].map((file, n) => `const m${n} = await import(${JSON.stringify(url(`server/${file}`))});`).join("\n") +
    "\nconsole.log(JSON.stringify([m0.name, m1.name, m2.name]));\n");
  const register = fileURLToPath(new URL("../../scripts/spec-clean/register.mjs", import.meta.url));
  const run = spawnSync(process.execPath, ["--import", register, "--import", import.meta.resolve("tsx"), main], {
    cwd: release,
    encoding: "utf8",
    env: { ...process.env, NODE_OPTIONS: "", SPEC_CLEAN_RELEASE: release, SPEC_CLEAN_OVERLAY: JSON.stringify({ "server/swapped.ts": source, "server/added.ts": added }) },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout), ["overlay", "release kept", "added 1"]);
});
