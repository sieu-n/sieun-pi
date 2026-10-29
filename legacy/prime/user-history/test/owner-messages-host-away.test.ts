// On 10-29 the owner wrote to designer bro on the Mac at 18:34:38Z, the Mac went offline on Tailscale (LastSeen 18:53Z) before the 30 min
// reply grace ended, and d11 read the burst as unanswered at 21:03Z from this box's copy, which stopped at 18:35Z. A burst on another box's chat
// counts only when the copy was complete past the grace; otherwise it is a host_away item, so the duty reruns once that box is back.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CURRENT_SESSION_VERSION } from "@earendil-works/pi-coding-agent";

const chat = "01a00000-0000-7000-8000-000000000002";
const asked = "2026-10-29T18:34:38.934Z";
const macAddress = "100.66.173.18";

function session(): string {
  const entry = (n: number, message: Record<string, unknown>) =>
    JSON.stringify({ type: "message", id: `e${n}`, parentId: n > 1 ? `e${n - 1}` : null, timestamp: asked, message: { ...message, timestamp: Date.parse(asked) } });
  return [JSON.stringify({ type: "session", id: chat, version: CURRENT_SESSION_VERSION, timestamp: "2026-10-29T00:00:00Z", cwd: "/" }),
    entry(1, { role: "user", content: [{ type: "text", text: "styling is old fashion. more compact, interactive, polished." }] })].join("\n") + "\n";
}

type Output = { metrics: Record<string, number>; flagged: { kind: string; host?: string; excerpt: string }[] };
/** d11's precheck at 21:03Z on a Mac chat whose copy was last written at `written`, with the Mac's Tailscale entry and catalog row as given. */
function precheck(mac: { online: boolean; lastSeen?: string }, written: string, modified = "2026-10-29T18:34:47.143Z"): Output {
  const home = mkdtempSync(join(tmpdir(), "d11-host-away-"));
  try {
    const data = join(home, "data");
    const sessions = join(home, ".cache/sieun-pi/hosts/mac/Users/sieunpark/.prime/agent/sessions");
    mkdirSync(sessions, { recursive: true });
    mkdirSync(join(data, "owner-messages"), { recursive: true });
    writeFileSync(join(data, "owner-messages", "labels.jsonl"), "");
    writeFileSync(join(data, "chats.json"), JSON.stringify({ ids: [chat] }));
    const copy = join(sessions, `${chat}.jsonl`);
    writeFileSync(copy, session());
    utimesSync(copy, new Date(written), new Date(written));
    writeFileSync(join(home, ".cache/sieun-pi/hosts/mac.sessions.json"),
      `{"version":1,"fullAt":0,"rows":[\n${JSON.stringify({ id: "x", sessionId: chat, modified })}\n]}\n`);
    const hosts = join(home, "hosts.json");
    writeFileSync(hosts, JSON.stringify({ version: 1, hosts: [{ name: "mac", hostname: "mac", address: macAddress, relayPort: 7790, token: "file:t",
      daemonSocket: "/tmp/d.sock", ssh: null, roles: {} }] }));
    const tailscale = join(home, "tailscale");
    writeFileSync(tailscale, `#!/bin/sh\ncat <<'EOF'\n${JSON.stringify({ Peer: { k: { TailscaleIPs: [macAddress], Online: mac.online, LastSeen: mac.lastSeen } } })}\nEOF\n`);
    chmodSync(tailscale, 0o755);
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, CHAT_DATA_DIR: data, OUTPUT_FILE: join(home, "out.json"), SIEUN_PI_HOSTS: hosts,
      SIEUN_PI_TAILSCALE: tailscale };
    delete env.LAST_RUNS_FILE;
    execFileSync(process.execPath, ["--import", "tsx", "scripts/duties/owner-messages.ts", "--end", "2026-10-29T21:03:00Z"], { env, cwd: join(import.meta.dirname, "..") });
    return JSON.parse(readFileSync(env.OUTPUT_FILE!, "utf8"));
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test("a burst on a Mac that went offline before the grace ended is a host_away item, not a miss", () => {
  const output = precheck({ online: false, lastSeen: "2026-10-29T18:53:03.1Z" }, "2026-10-29T18:35:10Z");
  assert.equal(output.metrics.unanswered_bursts, 0);
  assert.deepEqual(output.flagged.filter(item => item.kind === "host_away").map(item => item.host), ["mac"]);
  assert.equal(output.flagged.some(item => item.kind === "unanswered"), false);
});

test("a burst counts once the Mac is back and its copy holds the chat's last change", () => {
  const output = precheck({ online: true }, "2026-10-29T21:00:00Z", "2026-10-29T20:59:00Z");
  assert.equal(output.metrics.unanswered_bursts, 1);
  assert.equal(output.flagged.some(item => item.kind === "host_away" || item.kind === "copy_behind"), false);
});

test("a burst counts when the Mac went offline only after the grace ended", () => {
  assert.equal(precheck({ online: false, lastSeen: "2026-10-29T20:00:00Z" }, "2026-10-29T19:59:00Z").metrics.unanswered_bursts, 1);
});

test("a burst on a Mac that is up while its copy is older than the chat's last change waits for the copy", () => {
  const output = precheck({ online: true }, "2026-10-29T18:35:10Z", "2026-10-29T19:10:00Z");
  assert.equal(output.metrics.unanswered_bursts, 0);
  assert.deepEqual(output.flagged.filter(item => item.kind === "copy_behind").length, 1);
});
