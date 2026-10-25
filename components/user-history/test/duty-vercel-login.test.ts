// Guards board step p1062 (10-26): on 10-25 at 18:00Z Slack green deploys (d4) read a Vercel CLI login whose 8 h access token had expired,
// because no Vercel CLI run had refreshed it, and Vercel answered 403 invalidToken. The precheck's token helper must refresh an expired login.
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { vercelAuthPath, vercelToken, type VercelLoginDeps } from "../scripts/duties/vercel-login.ts";

const NOW = Date.parse("2026-10-25T18:00:00Z");
const login = (token: string, expiresAt: number) => JSON.stringify({ token, refreshToken: "r", expiresAt });

async function rig(content: string, refreshed?: string): Promise<{ deps: VercelLoginDeps; refreshes: () => number; done: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "vercel-login-"));
  const authPath = join(dir, "auth.json");
  await writeFile(authPath, content);
  let count = 0;
  const deps: VercelLoginDeps = {
    env: {}, authPath, now: () => NOW, read: path => readFile(path, "utf8"),
    refresh: async () => { count += 1; if (refreshed) await writeFile(authPath, refreshed); },
  };
  return { deps, refreshes: () => count, done: () => rm(dir, { recursive: true, force: true }) };
}

test("an expired CLI login is refreshed through the CLI and the new token is read", async () => {
  const { deps, refreshes, done } = await rig(login("old", NOW / 1000 - 3600), login("new", NOW / 1000 + 8 * 3600));
  try {
    assert.equal(await vercelToken(deps), "new");
    assert.equal(refreshes(), 1);
  } finally { await done(); }
});

test("a live CLI login is used as it is", async () => {
  const { deps, refreshes, done } = await rig(login("live", NOW / 1000 + 60));
  try {
    assert.equal(await vercelToken(deps), "live");
    assert.equal(refreshes(), 0);
  } finally { await done(); }
});

test("VERCEL_TOKEN wins over the CLI login", async () => {
  const { deps, refreshes, done } = await rig(login("old", NOW / 1000 - 3600));
  try {
    assert.equal(await vercelToken({ ...deps, env: { VERCEL_TOKEN: "env" } }), "env");
    assert.equal(refreshes(), 0);
  } finally { await done(); }
});

test("a login the CLI cannot refresh fails with the path and the fix", async () => {
  const { deps, done } = await rig(login("old", NOW / 1000 - 3600));
  try {
    await assert.rejects(vercelToken(deps), /no live Vercel token.*vercel login/);
  } finally { await done(); }
});

test("the login path follows the CLI's data dir on each platform", () => {
  assert.equal(vercelAuthPath("darwin", {}, "/Users/s"), "/Users/s/Library/Application Support/com.vercel.cli/auth.json");
  assert.equal(vercelAuthPath("linux", {}, "/home/s"), "/home/s/.local/share/com.vercel.cli/auth.json");
  assert.equal(vercelAuthPath("linux", { XDG_DATA_HOME: "/x" }, "/home/s"), "/x/com.vercel.cli/auth.json");
});
