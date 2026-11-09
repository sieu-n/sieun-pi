// Drives leave.mjs with a fake Playwright page whose evaluate runs the page function against a fake window.
// Run with: node --test --test-force-exit --test-isolation=none skills/aside-browser/box/leave.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { holdLeaves } from "./leave.mjs";

class FakeSocket extends EventEmitter {
  constructor(url) { super(); this.u = url; }
  url() { return this.u; }
}

function fakePage(win) {
  const page = new EventEmitter();
  page.went = [];
  page.evaluate = async (fn, arg) => {
    globalThis.window = win;
    try { return await fn(arg); } finally { delete globalThis.window; }
  };
  page.goto = async (url) => { page.went.push(url); };
  page.reload = async () => { page.went.push("reload"); };
  holdLeaves(page);
  const socket = (url = "wss://convex-staging.virev.ai/api/1.31.0/sync") => {
    const ws = new FakeSocket(url);
    page.emit("websocket", ws);
    return ws;
  };
  return { page, socket };
}

const turns = () => new Promise((r) => setImmediate(r));
const never = () => new Promise(() => {});
/** Whether `promise` settled once the fakes ran every pending turn; a leave that waits forever stays false. */
async function left(promise) {
  let done = false;
  promise.then(() => (done = true));
  await turns();
  return done;
}

test("a goto waits for the page's unanswered writes while its socket is open", async () => {
  let land;
  const { page, socket } = fakePage({ __convexWritesLanded: () => new Promise((r) => (land = r)) });
  socket();
  const going = page.goto("https://staging.virev.ai/en/pricing");
  await turns();
  assert.deepEqual(page.went, []);
  land();
  assert.equal(await left(going), true);
  assert.deepEqual(page.went, ["https://staging.virev.ai/en/pricing"]);
});

test("a goto leaves once the page's Convex socket closes with a write still unanswered", async () => {
  // 11-09: a write that waits for a socket that stays down never lands, and the old wait held the runner forever.
  const { page, socket } = fakePage({ __convexWritesLanded: never });
  const ws = socket();
  socket("wss://example.com/live");
  const going = page.goto("https://staging.virev.ai/en");
  await turns();
  assert.deepEqual(page.went, []);
  ws.emit("close");
  assert.equal(await left(going), true);
  assert.deepEqual(page.went, ["https://staging.virev.ai/en"]);
});

test("a reload on a page whose Convex socket is already down leaves at once", async () => {
  const { page, socket } = fakePage({ __convexWritesLanded: never });
  socket().emit("close");
  assert.equal(await left(page.reload()), true);
  assert.deepEqual(page.went, ["reload"]);
});

test("a goto leaves once the write guard dropped a mutation and the rest have answers", async () => {
  // staging-proof 42684994435 (auto-sns-agent 7e66e5964): a mutation the guard dropped never answers.
  const { page, socket } = fakePage({ __convexWritesLanded: never, __socketGuardIdle: async () => {} });
  socket();
  assert.equal(await left(page.goto("https://staging.virev.ai/app/campaigns")), true);
  assert.deepEqual(page.went, ["https://staging.virev.ai/app/campaigns"]);
});
