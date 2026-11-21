/**
 * On SIGTERM the server stops taking calls and answers the calls in flight before the process ends (http.ts `drain`). A release restart
 * used to end the process mid-call, so a change in flight failed with "Load failed" in the owner's browser. An open live socket does not
 * hold the stop, and a call that never answers holds it only up to the cap.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/drain.test.ts
 */
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { drain, serve } from "../../server/http.ts";
import { start, type Running } from "./helpers.ts";

let s: Running;
before(async () => {
  s = await start();
});
after(async () => {
  await s.close();
});

const listening = async () => {
  const server = serve(s.app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
};

test("a call in flight answers before the drain ends, while a live socket stays open", async () => {
  const { server, base } = await listening();
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/api/live`);
  await new Promise(resolve => socket.once("open", resolve));
  const header = s.app.header.bind(s.app);
  s.app.header = async id => {
    await sleep(400);
    return header(id);
  };
  try {
    const call = fetch(`${base}/api/c/${s.app.agents.list()[0]!.room}`);
    await sleep(100);
    const started = performance.now();
    await drain(server);
    const took = performance.now() - started;
    const answer = await call;
    assert.equal(answer.status, 200, "the call in flight answers");
    assert.ok(took >= 250 && took < 1500, `the drain waited for the call and not for the socket: ${took.toFixed(0)} ms`);
    await assert.rejects(fetch(`${base}/api/me`), "a new call is refused once the drain starts");
  } finally {
    s.app.header = header;
    socket.close();
  }
});

test("a call that never answers holds the drain only up to its cap", async () => {
  const { server, base } = await listening();
  const header = s.app.header.bind(s.app);
  s.app.header = () => new Promise(() => {});
  try {
    void fetch(`${base}/api/c/${s.app.agents.list()[0]!.room}`).catch(() => undefined);
    await sleep(100);
    const started = performance.now();
    await drain(server, 300);
    const took = performance.now() - started;
    assert.ok(took >= 280 && took < 1000, `the drain ended at its cap: ${took.toFixed(0)} ms`);
  } finally {
    s.app.header = header;
    server.closeAllConnections();
  }
});
