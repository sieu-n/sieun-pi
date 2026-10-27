// 10-20: Crawler VP and CI and RepoOps ran an extension build hours older than the live one, because their turns never left a gap for a
// reload, so each tell_owner fix reached them late (c117). The check now runs the live release's rules on each call.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";
import { tellOwner } from "../src/chat-guard.ts";
import { liveGuard, liveRulesFile } from "../src/chat-guard-live.ts";

const rules = (dir: string, mark: string): void => {
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "chat-guard.ts"), `export const tellTurn = () => ({ owner: false, ownerIds: new Set() });\nexport const tellOwner = () => ({ kind: "held", text: "${mark}" });\n`);
};

test("tell_owner runs the rules of the release the extension link points at, else the chat service's current release, else the loaded ones", async () => {
  const home = mkdtempSync(join(tmpdir(), "live-guard-"));
  const agentDir = join(home, ".prime", "agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const release = join(home, "runtime", "releases", "abc", "components", "user-history");
  rules(release, "mac release");
  symlinkSync(release, join(agentDir, "extensions", "user-history"));
  assert.equal(liveRulesFile(agentDir, home), join(release, "src", "chat-guard.ts"));
  assert.equal((await liveGuard(agentDir, home)).tellOwner({ text: "x" }, { owner: true, ownerIds: new Set() }).text, "mac release");

  const box = mkdtempSync(join(tmpdir(), "live-guard-box-"));
  const boxAgent = join(box, ".prime", "agent");
  mkdirSync(join(boxAgent, "extensions"), { recursive: true });
  const checkout = join(box, "src", "sieun-pi", "components", "user-history");
  rules(checkout, "working checkout");
  symlinkSync(checkout, join(boxAgent, "extensions", "user-history"));
  assert.equal((await liveGuard(boxAgent, box)).tellOwner, tellOwner, "no chat release on disk: the loaded rules");
  const current = join(box, ".local", "share", "sieun-pi-chat", "release-1", "legacy", "prime", "user-history");
  rules(current, "chat release");
  symlinkSync(join(box, ".local", "share", "sieun-pi-chat", "release-1"), join(box, ".local", "share", "sieun-pi-chat", "current"));
  assert.equal((await liveGuard(boxAgent, box)).tellOwner({ text: "x" }, { owner: true, ownerIds: new Set() }).text, "chat release");
});

test("two tell_owner calls in one step both get the live rules when jiti loads them, the way Prime loads the extension", async () => {
  // 10-22, chats 01a1636f at 11:50:48Z and 01a16379 at 11:59:16Z: the second of two parallel calls, the first after a release, failed with
  // "Cannot access 'TELL_CASES' before initialization", and the chat sent its text again.
  const home = mkdtempSync(join(tmpdir(), "live-guard-jiti-"));
  const agentDir = join(home, ".prime", "agent");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const release = join(home, "runtime", "releases", "abc", "components", "user-history");
  mkdirSync(join(release, "src"), { recursive: true });
  writeFileSync(join(release, "src", "chat-guard.ts"), 'import { sep } from "node:path";\nconst CASES = ["answer", sep];\n' +
    'export function tellTurn() { return { owner: true, ownerIds: new Set() }; }\nexport function tellOwner() { return { kind: "sent", text: CASES[0] }; }\n');
  symlinkSync(release, join(agentDir, "extensions", "user-history"));
  const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
  const live = await jiti.import<typeof import("../src/chat-guard-live.ts")>(fileURLToPath(new URL("../src/chat-guard-live.ts", import.meta.url)));
  const calls = await Promise.allSettled([1, 2].map(async () => (await live.liveGuard(agentDir, home)).tellOwner({ text: "x" }, { owner: true, ownerIds: new Set() }).text));
  assert.deepEqual(calls.map(call => call.status === "fulfilled" ? call.value : String(call.reason)), ["answer", "answer"]);
});
