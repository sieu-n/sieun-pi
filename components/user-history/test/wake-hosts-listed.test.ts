// Guards the 10-18 wake holds on us-metal02: every chat service restart refused each Mac session's wakes with "another box has not listed its
// sessions yet" until the Mac's list came, and at 06:57:22.8Z a chat list still read the Mac unlisted 1 s before the restart's disk copy of the
// Mac's 3,060 rows was read. The catalog now waits for the disk copies before it refuses.
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { Catalog } from "../src/chat-catalog.ts";
import { ChatLabels } from "../src/chat-labels.ts";
import { ChatReadState } from "../src/chat-read-state.ts";
import type { HostCatalogs } from "../src/host-catalogs.ts";
import { ThreadOrigins } from "../src/thread-origin.ts";

const MAC_SESSION = "01a0cc5e-0ca4-762a-90e6-566c310bd50a";

/** The other boxes as the catalog reads them: the Mac's copy is listed once `read` runs, as SessionPeer's disk copy load does. */
function macHosts(copySaved: boolean) {
  let listed = false;
  let read!: () => void;
  const loading = new Promise<void>(resolve => { read = () => { listed = copySaved; resolve(); }; });
  const mac = { request: async () => ({ success: true }) };
  const hosts = { selfName: "us-metal02", onChange: () => {}, start: () => {}, close: () => {}, allListed: () => listed, loaded: () => loading,
    hostOf: (id: string) => listed && id === MAC_SESSION ? { name: "mac" } : null, isActive: () => false, rows: () => [], hostRows: () => [],
    client: (name: string) => name === "mac" ? mac : null, ready: async (name: string) => name === "mac" ? mac : null };
  return { hosts: hosts as unknown as HostCatalogs, mac, read };
}

function catalogWith(t: TestContext, hosts: HostCatalogs): Catalog {
  const reads = new ChatReadState("unused");
  const labels = new ChatLabels("unused");
  t.mock.method(reads, "snapshot", async () => ({ baseline: 0, sessions: {} }));
  t.mock.method(labels, "snapshot", async () => ({ tags: [], threads: {} }));
  const ids = { ids: async () => new Set<string>(), checkIns: async () => new Map(), links: async () => ({ children: [], board: null, roots: [], messages: [] }) };
  const catalog = new Catalog("unused", reads, labels, ids, new ThreadOrigins({ ids: async () => [] }), hosts);
  t.after(() => catalog.close());
  return catalog;
}

test("a send to a Mac session right after a restart waits for the Mac's disk copy and goes to the Mac's daemon instead of being refused", async (t: TestContext) => {
  const { hosts, mac, read } = macHosts(true);
  const catalog = catalogWith(t, hosts);
  let answered = false;
  const client = catalog.daemonFor(MAC_SESSION).then(found => { answered = true; return found; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(answered, false, "it waits while the copy is read");
  read();
  assert.equal(await client, mac);
});

test("with no disk copy of the Mac the send is still refused until the Mac lists, so the wake stays for the next tick", async (t: TestContext) => {
  const { hosts, read } = macHosts(false);
  const catalog = catalogWith(t, hosts);
  read();
  await assert.rejects(catalog.daemonFor(MAC_SESSION), /Session 01a0cc5e is not on this box, and another box has not listed its sessions yet\./);
});
