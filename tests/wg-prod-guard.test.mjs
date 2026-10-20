import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// deploy/linux/wg-prod-guard.nft, the nftables guard of us-metal02's wg-prod link. Inbound on wg-prod it admits
// replies, ssh and ping, and since 2026-10-20 the prod TikTok signers' ports from us-metal01 only, then drops the rest.
const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../deploy/linux");
const nft = readFileSync(join(dir, "wg-prod-guard.nft"), "utf8");
const chain = (name) => new RegExp(`chain ${name} \\{\\n([\\s\\S]*?)\\n  \\}`).exec(nft)[1].split("\n").map((l) => l.trim());

test("inbound on wg-prod admits the signers' ports 8101-8120 from 10.250.12.1 only, before the drop", () => {
  const input = chain("input");
  const signers = input.indexOf('iifname "wg-prod" ip saddr 10.250.12.1 tcp dport 8101-8120 accept');
  assert.ok(signers > 0, "no signer rule");
  assert.equal(input.at(-1), 'iifname "wg-prod" counter drop');
  assert.deepEqual(input.filter((l) => l.endsWith(" accept")), [
    'iifname "wg-prod" ct state established,related accept',
    'iifname "wg-prod" ip saddr 10.250.12.1 tcp dport 22 accept',
    'iifname "wg-prod" icmp type echo-request accept',
    'iifname "wg-prod" ip saddr 10.250.12.1 tcp dport 8101-8120 accept',
  ]);
});

test("forward and output keep their rules: only the prod docker subnet forwards into wg-prod", () => {
  assert.deepEqual(chain("forward").slice(1), [
    'oifname "wg-prod" ip saddr != 10.92.0.0/24 counter drop',
    'iifname "wg-prod" ct state established,related accept',
    'iifname "wg-prod" counter drop',
  ]);
  assert.equal(chain("output").at(-1), 'oifname "wg-prod" counter reject');
});

// The container's own network namespace takes the check; nft -c applies nothing. The guard names uid sieun, so the
// container gets that user.
test("nft parses the file (docker, in a throwaway container)", (t) => {
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) return t.skip("no docker");
  const out = execFileSync("docker", ["run", "--rm", "-i", "--cap-add", "NET_ADMIN", "alpine:3.20", "sh", "-c", "apk add -q nftables >/dev/null && adduser -D sieun && nft -c -f /dev/stdin && echo parsed"], { input: nft.replace(/^delete table inet wg_prod_guard\n/m, ""), encoding: "utf8", timeout: 180_000 });
  assert.match(out, /parsed/);
});
