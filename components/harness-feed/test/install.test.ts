import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { activate, launchdPlist, loadCheck, SERVICE } from "../install.mjs";

const share = mkdtempSync(join(tmpdir(), "harness-feed-install-"));
after(() => rmSync(share, { recursive: true, force: true }));

/** A release folder with feed.ts's shape: a static import, an entry-guarded loop, and the duties reader's lazy loadApp. */
function release(name: string, missing?: string): string {
  const dir = join(share, name);
  const files: Record<string, string> = {
    "package.json": `{ "type": "module" }\n`,
    "components/harness-feed/feed.ts": `import { payload } from "./otlp.ts";\nexport const ok: number = payload();\nif (process.argv[1]) throw new Error("the loop started");\n`,
    "components/harness-feed/otlp.ts": "export const payload = (): number => 1;\n",
    "components/harness-feed/readers/duties.ts": `export async function loadApp(): Promise<unknown> { return import("../../../legacy/prime/user-history/src/owner-chats.ts"); }\n`,
    "legacy/prime/user-history/src/owner-chats.ts": "export const owners: string[] = [];\n",
  };
  for (const [file, text] of Object.entries(files)) {
    if (file === missing) continue;
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  return dir;
}

const running = join(share, "release-running");
mkdirSync(running);
symlinkSync(running, join(share, "current"));

test("a release that loads becomes current and the service restarts on it", () => {
  const good = release("release-good");
  const restarts: string[] = [];
  activate(good, share, link => restarts.push(readlinkSync(link)));
  assert.deepEqual(restarts, [good]);
  assert.equal(readlinkSync(join(share, "current")), good);
});

for (const [file, why] of [
  ["components/harness-feed/otlp.ts", "a file feed.ts imports"],
  ["legacy/prime/user-history/src/owner-chats.ts", "a file the duties reader imports lazily"],
]) {
  test(`a release missing ${why} is refused before the swap, naming the module (11-25 release 39923ec)`, () => {
    const before = readlinkSync(join(share, "current"));
    const broken = release(`release-no-${file.split("/").pop()}`, file);
    const restarts: string[] = [];
    assert.throws(() => activate(broken, share, link => restarts.push(link)), (error: Error) => {
      assert.match(error.message, /ERR_MODULE_NOT_FOUND/);
      assert.ok(error.message.includes(join(broken, file)), error.message);
      return true;
    });
    assert.deepEqual(restarts, []);
    assert.equal(readlinkSync(join(share, "current")), before);
  });
}

test("the Mac plist runs feed.ts with the node, loader and directory the load check imports it with (11-25 plain-node plist)", () => {
  const script = join(share, "current/components/harness-feed/feed.ts");
  const plist = launchdPlist(script);
  const args = [...plist.match(/<key>ProgramArguments<\/key><array>(.*?)<\/array>/)![1].matchAll(/<string>(.*?)<\/string>/g)].map(m => m[1]);
  assert.deepEqual(args, [SERVICE.node, ...SERVICE.loader, script]);
  assert.equal(plist.match(/<key>WorkingDirectory<\/key><string>(.*?)<\/string>/)![1], SERVICE.cwd);
  const props = release("release-parameter-properties");
  writeFileSync(join(props, "components/harness-feed/otlp.ts"), "class Feed { constructor(private n: number) {} get = (): number => this.n; }\nexport const payload = (): number => new Feed(1).get();\n");
  assert.equal(loadCheck(props), null);
  assert.match(loadCheck(props, { ...SERVICE, loader: [] }) ?? "", /ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/);
});
