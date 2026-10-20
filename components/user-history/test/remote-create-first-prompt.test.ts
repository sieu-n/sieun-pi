// Guards the 10-19 lost first message: three new Mac threads in a row answered 502 "Unknown active session", because the prompt right after the
// create went to this box's daemon while the Mac's roster did not list the new session yet.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import { OWNER_THREAD_FLAG } from "../src/chat-guard.ts";
import { ThreadHub } from "../src/chat-threads.ts";
import type { HostCatalogs } from "../src/host-catalogs.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const ID = "01a154b4-51ea-7166-ae5a-57c4936c2b80";

test("a session placed on the Mac is the Mac's until the Mac's list names it, and then the list decides", (t: TestContext) => {
  let listed: string | null = null;
  const hosts = { selfName: "us-metal02", hostOf: (id: string) => id === ID && listed ? { name: listed } : null, isActive: () => false, client: () => null,
    start: () => {}, close: async () => {} } as unknown as HostCatalogs;
  const catalog = new Catalog("unused", new ChatReadState("unused"), new ChatLabels("unused"), { ids: async () => new Set(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) },
    new ThreadOrigins({ ids: async () => [] }), hosts);
  t.after(() => catalog.close());
  assert.equal(catalog.hostOf(ID), null);
  catalog.place("mac", ID, "fe473a344ace");
  assert.equal(catalog.hostOf(ID), "mac");
  assert.equal(catalog.hostOf("fe473a344ace"), "mac");
  listed = "mini";
  assert.equal(catalog.hostOf(ID), "mini", "the list's answer wins once it names the session");
  listed = null;
  assert.equal(catalog.hostOf(ID), null, "a placement ends once the list named the session");
});

test("a thread created on another box is placed there before its attach, so its first prompt goes to that box", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "remote-create-"));
  const placed: string[][] = [];
  const mac = { request: async (command: { type: string }) => command.type === "create" ? { success: true, data: { sessionId: ID, activeSessionId: "fe473a344ace" } } : { success: true, data: undefined } };
  const catalog = { hostClient: async (name: string) => { assert.equal(name, "mac"); return mac; }, isOtherHost: (name: string) => name === "mac",
    place: (...args: string[]) => { placed.push(args); }, hostOf: () => null, socketPathFor: () => join(dir, "missing.sock"), refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "box.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());
  await assert.rejects(hub.create({ cwd: "/Users/sieunpark", host: "mac" }));
  assert.deepEqual(placed, [["mac", ID, "fe473a344ace"]]);
});

test("a new thread's first message goes to its box right after the create, before the attach, with the owner's turn and flag", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "remote-create-"));
  const sent: Record<string, unknown>[] = [];
  const mac = { request: async (command: Record<string, unknown>) => {
    sent.push(command);
    return command.type === "create" ? { success: true, data: { sessionId: ID, activeSessionId: "fe473a344ace" } } : { success: true, data: undefined };
  } };
  const catalog = { hostClient: async () => mac, isOtherHost: (name: string) => name === "mac", place: () => {}, hostOf: () => null,
    socketPathFor: () => join(dir, "missing.sock"), refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "box.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());
  await assert.rejects(hub.create({ cwd: "/Users/sieunpark", host: "mac", name: "probe", first: { message: "hi", mode: "followUp" } }), "the attach to the missing socket still fails");
  assert.deepEqual(sent.map(command => command.type), ["create", "prompt", "rename"], "the name follows the message, since a name on the create holds the session start");
  assert.equal(sent[0]!.name, undefined);
  assert.deepEqual(sent[2], { type: "rename", activeSessionId: "fe473a344ace", name: "probe" });
  assert.deepEqual((sent[0]!.config as { extensionFlagValues?: unknown }).extensionFlagValues, { [OWNER_THREAD_FLAG]: true });
  assert.deepEqual({ ...sent[1], id: undefined }, { type: "prompt", activeSessionId: "fe473a344ace", message: "hi", source: "interactive", streamingBehavior: "followUp",
    queueIfBusy: true, ownerTurn: ID, id: undefined });
});

test("a create with no first message sends no prompt and sets no owner flag, as a duty job's create", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "remote-create-"));
  const sent: Record<string, unknown>[] = [];
  const mac = { request: async (command: Record<string, unknown>) => { sent.push(command); return { success: true, data: { sessionId: ID, activeSessionId: "fe473a344ace" } }; } };
  const catalog = { hostClient: async () => mac, isOtherHost: () => true, place: () => {}, hostOf: () => null, socketPathFor: () => join(dir, "missing.sock"), refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "box.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());
  await assert.rejects(hub.create({ cwd: "/Users/sieunpark", host: "mac" }));
  assert.deepEqual(sent.map(command => command.type), ["create"]);
  assert.equal((sent[0]!.config as { extensionFlagValues?: unknown }).extensionFlagValues, undefined);
});

test("a named job with no first message is created without its name and named by a rename, since a name on the create held it 18 s", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "remote-create-"));
  const sent: Record<string, unknown>[] = [];
  const mac = { request: async (command: Record<string, unknown>) => { sent.push(command); return { success: true, data: { sessionId: ID, activeSessionId: "fe473a344ace" } }; } };
  const catalog = { hostClient: async () => mac, isOtherHost: () => true, place: () => {}, hostOf: () => null, socketPathFor: () => join(dir, "missing.sock"), refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "box.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());
  await assert.rejects(hub.create({ cwd: "/home/sieun", host: "mac", name: "check-in vent 11:47" }), "the attach to the missing socket still fails");
  assert.deepEqual(sent.map(command => command.type), ["create", "rename"]);
  assert.equal(sent[0]!.name, undefined);
  assert.deepEqual(sent[1], { type: "rename", activeSessionId: "fe473a344ace", name: "check-in vent 11:47" });
});

test("a rename the daemon refuses for a taken name kills the new session and throws the refusal, as a refused named create did", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "remote-create-"));
  const sent: Record<string, unknown>[] = [];
  const taken = 'Agent name "check-in vent 11:47" is unavailable: an agent of that name already exists at depth 0 under this parent';
  const mac = { request: async (command: Record<string, unknown>) => {
    sent.push(command);
    return command.type === "rename" ? { success: false, error: taken } : { success: true, data: { sessionId: ID, activeSessionId: "fe473a344ace" } };
  } };
  const catalog = { hostClient: async () => mac, isOtherHost: () => true, place: () => {}, hostOf: () => null, socketPathFor: () => join(dir, "missing.sock"), refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "box.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());
  await assert.rejects(hub.create({ cwd: "/home/sieun", host: "mac", name: "check-in vent 11:47" }), (error: Error) => error.message === taken);
  assert.deepEqual(sent.map(command => command.type), ["create", "rename", "kill"]);
  assert.deepEqual(sent[2], { type: "kill", activeSessionId: "fe473a344ace" });
});

test("a new thread on another box asks that box's relay to send its first message, and sends none itself when the relay did", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "remote-create-"));
  const sent: Record<string, unknown>[] = [];
  const mac = { request: async (command: Record<string, unknown>) => {
    sent.push(command);
    return command.type === "create" ? { success: true, data: { sessionId: ID, activeSessionId: "fe473a344ace" }, relayFirstPrompt: { success: true } } : { success: true, data: undefined };
  } };
  const catalog = { hostClient: async () => mac, isOtherHost: () => true, place: () => {}, hostOf: () => null, socketPathFor: () => join(dir, "missing.sock"), refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "box.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());
  await assert.rejects(hub.create({ cwd: "/Users/sieunpark", host: "mac", first: { message: "hi", mode: "followUp" } }));
  assert.deepEqual(sent.map(command => command.type), ["create"]);
  assert.deepEqual(sent[0]!.relayFirstPrompt, { message: "hi", source: "interactive", streamingBehavior: "followUp", queueIfBusy: true, ownerTurn: true });
});

test("a first message the relay could not deliver fails the create with the relay's reason", async (t: TestContext) => {
  const dir = await mkdtemp(join(tmpdir(), "remote-create-"));
  const mac = { request: async (command: Record<string, unknown>) => command.type === "create"
    ? { success: true, data: { sessionId: ID, activeSessionId: "fe473a344ace" }, relayFirstPrompt: { success: false, error: "Session is busy" } } : { success: true, data: undefined } };
  const catalog = { hostClient: async () => mac, isOtherHost: () => true, place: () => {}, hostOf: () => null, socketPathFor: () => join(dir, "missing.sock"), refresh: async () => {} } as unknown as Catalog;
  const hub = new ThreadHub(join(dir, "box.sock"), catalog, () => ({ provider: null, modelId: null, thinkingLevel: null }));
  t.after(() => hub.close());
  await assert.rejects(hub.create({ cwd: "/Users/sieunpark", host: "mac", first: { message: "hi", mode: "followUp" } }), /Session is busy/);
});
