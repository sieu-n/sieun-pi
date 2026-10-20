// Guards the chat's start on us-metal02: the 06:25Z start on 10-20 held the main thread 7.1 s, 1.8 s of it tsx compiling every .ts file
// again because each release folder is a new path. A release now runs the service from one esbuild bundle (src/chat-service-bundle.mjs).
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { anchorImportMeta, bundleChatService } from "../src/chat-service-bundle.mjs";

test("a module outside the bundle's folder keeps its own import.meta url, filename and dirname in the bundle", async t => {
  const dir = await mkdtemp(join(tmpdir(), "chat-bundle-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "src"));
  await mkdir(join(dir, "scripts", "duties"), { recursive: true });
  await writeFile(join(dir, "scripts", "duties", "probe.ts"),
    "export const where: { url: string; filename: string; dirname: string } = { url: import.meta.url, filename: import.meta.filename, dirname: import.meta.dirname };\n");
  await writeFile(join(dir, "src", "own.ts"), "export const own = import.meta.dirname;\n");
  await writeFile(join(dir, "src", "entry.ts"), "export { where } from \"../scripts/duties/probe.ts\";\nexport { own } from \"./own.ts\";\nexport const lazy = () => import(\"./own.ts\");\n");
  const outfile = await bundleChatService({ entry: join(dir, "src", "entry.ts"), outfile: join(dir, "src", "entry.bundle.mjs") });
  const loaded = await import(pathToFileURL(outfile).href) as { where: { url: string; filename: string; dirname: string }; own: string; lazy: () => Promise<{ own: string }> };
  const probe = join(dir, "scripts", "duties", "probe.ts");
  assert.deepEqual(loaded.where, { url: pathToFileURL(probe).href, filename: probe, dirname: join(dir, "scripts", "duties") });
  assert.equal(loaded.own, join(dir, "src"));
  assert.equal((await loaded.lazy()).own, join(dir, "src"));
});

test("a module in the bundle's own folder is left as it is", () => {
  assert.equal(anchorImportMeta("const a = import.meta.url;", "/r/src/a.ts", "/r/src"), "const a = import.meta.url;");
});

test("the chat service bundles with no warning and holds its lazy modules", async t => {
  const dir = await mkdtemp(join(tmpdir(), "chat-bundle-real-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { readFile } = await import("node:fs/promises");
  const text = await readFile(await bundleChatService({ outfile: join(dir, "chat-service.bundle.mjs") }), "utf8");
  for (const name of ["startChatServer", "createChatBackend", "SessionPeer", "startRunProfile", "hostExecFile"]) assert.ok(text.includes(name), name);
  assert.equal(/import\(["']\.{1,2}\/[^"']+\.ts["']\)/.test(text), false, "no .ts import is left for tsx");
});
