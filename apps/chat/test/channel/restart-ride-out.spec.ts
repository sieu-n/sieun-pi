import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";
import { composerInput, conversation, open, tag } from "./helpers";

/**
 * A release restarts the chat server, and its port is closed until the new one listens: 2.45 s at p50 over the 195 restarts from 11-15 to
 * 11-22. The page rides that out (client.ts `RIDE_OUT_MS`): a read or a send that fails with no answer goes again, the live socket comes
 * back within a quarter second of the new server listening, and no Offline note, Not delivered mark or failed call shows. This spec runs
 * its own fixture server, kills it with SIGKILL in the middle of one of the page's reads, starts it again on the same port and data, and
 * sends a message while it is down. The page's HTTP calls reach that server through `page.route`, and its live socket goes to it straight.
 */
const appDir = join(dirname(fileURLToPath(import.meta.url)), "../..");

const freePort = (): Promise<number> => new Promise((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as { port: number };
    server.close(() => resolve(port));
  });
});

/** One fixture server on `port` with its data in `dir`, in its own process group, so a kill also ends its Meilisearch. */
class Server {
  child: ChildProcess | undefined;
  listenedAt = 0;
  constructor(readonly port: number, readonly dir: string) {}

  start(): Promise<void> {
    const child = spawn("node", ["--import", "tsx", "server/main.ts", "--fixture", "--port", String(this.port), "--data-dir", join(this.dir, "data")], {
      cwd: appDir, detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, TMPDIR: this.dir },
    });
    this.child = child;
    return new Promise((resolve, reject) => {
      let out = "";
      const timer = setTimeout(() => reject(new Error(`the fixture server did not listen in 60 s: ${out}`)), 60_000);
      child.stdout!.on("data", (chunk: Buffer) => {
        out = (out + String(chunk)).slice(-4000);
        if (!this.listenedAt && out.includes("apps/chat on http")) {
          this.listenedAt = Date.now();
          clearTimeout(timer);
          resolve();
        }
      });
      child.stderr!.on("data", (chunk: Buffer) => (out = (out + String(chunk)).slice(-4000)));
      child.once("exit", code => reject(new Error(`the fixture server exited ${code}: ${out}`)));
    });
  }

  kill(): Promise<void> {
    const child = this.child!;
    this.listenedAt = 0;
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
    process.kill(-child.pid!, "SIGKILL");
    return exited;
  }
}

/** Routes the page's HTTP calls to `server`; a call while it is down fails as a refused connection does. */
async function bridge(page: Page, server: Server, onCall: (path: string) => Promise<void>): Promise<{ errors: string[] }> {
  const errors: string[] = [];
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/timings") {
      const body = route.request().postDataJSON() as { samples?: { m: string; p: string; err?: string }[] } | null;
      for (const sample of body?.samples ?? []) if (sample.err) errors.push(`${sample.m} ${sample.p}: ${sample.err}`);
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await onCall(url.pathname);
    try {
      const response = await route.fetch({ url: `http://127.0.0.1:${server.port}${url.pathname}${url.search}`, maxRetries: 0 });
      await route.fulfill({ response });
    } catch {
      await route.abort("connectionrefused").catch(() => undefined);
    }
  });
  return { errors };
}

/** The ms from the server's listen line until the page's live socket got hello number `n`. */
async function backAfterListen(page: Page, server: Server, n: number): Promise<number> {
  await expect.poll(() => page.evaluate(() => (window as unknown as { hellos: number[] }).hellos.length), { timeout: 20_000 }).toBe(n);
  const hellos = await page.evaluate(() => (window as unknown as { hellos: number[] }).hellos);
  return hellos[n - 1]! - server.listenedAt;
}

test("a server killed mid-call and started again shows no failed call, no Offline note and no Not delivered send", async ({ page, request }, info) => {
  test.setTimeout(120_000);
  const dir = info.outputPath("server");
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "data"), { recursive: true });
  const server = new Server(await freePort(), dir);
  await server.start();
  try {
    const base = `http://127.0.0.1:${server.port}`;
    const t = tag();
    const room = (await (await request.post(`${base}/api/rooms`, { data: { kind: "channel", name: `ride-out-${t}`, members: [], test: true } })).json()) as { id: string };
    const other = (await (await request.post(`${base}/api/rooms`, { data: { kind: "channel", name: `ride-out-b-${t}`, members: [], test: true } })).json()) as { id: string };
    await request.post(`${base}/api/c/${other.id}/send`, { data: { text: `before the restart ${t}`, requestId: `seed-${t}` } });

    await page.addInitScript(port => {
      const shown: string[] = [];
      const hellos: number[] = [];
      Object.assign(window, { shown, hellos });
      new MutationObserver(() => {
        const text = document.body?.innerText ?? "";
        for (const word of ["Offline ·", "Not delivered", "Load failed", "Failed to fetch"]) if (text.includes(word) && !shown.includes(word)) shown.push(word);
      }).observe(document, { subtree: true, childList: true, characterData: true });
      const Native = window.WebSocket;
      window.WebSocket = class extends Native {
        constructor(url: string | URL, protocols?: string | string[]) {
          const target = new URL(url, location.href);
          const liveSocket = target.pathname === "/api/live";
          if (liveSocket) target.href = `ws://127.0.0.1:${port}/api/live`;
          super(target, protocols);
          if (liveSocket) this.addEventListener("message", event => {
            if (String(event.data).startsWith('{"type":"hello"')) hellos.push(Date.now());
          });
        }
      };
    }, server.port);

    let armed = false;
    let restarted: Promise<void> | undefined;
    const calls = await bridge(page, server, async path => {
      if (!armed || path !== `/api/c/${other.id}/items`) return;
      armed = false;
      restarted = server.kill().then(() => server.start());
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    await open(page, `#/c/${room.id}`);
    await page.waitForLoadState("networkidle");
    await expect.poll(() => page.evaluate(() => (window as unknown as { hellos: number[] }).hellos.length)).toBe(1);

    // The open of the other room reads its items, and the server dies under that read.
    armed = true;
    await page.evaluate(id => (location.hash = `#/c/${id}`), other.id);
    await expect.poll(() => restarted !== undefined).toBe(true);
    await restarted;
    await expect(conversation(page).getByText(`before the restart ${t}`)).toBeVisible({ timeout: 20_000 });
    const backs = [await backAfterListen(page, server, 2)];

    // A send while the server is down shows Sending and lands once when it is back.
    const input = composerInput(conversation(page));
    await input.click();
    await server.kill();
    await page.keyboard.type(`sent while it restarts ${t}`);
    await page.keyboard.press("Enter");
    const sent = conversation(page).locator(".row.own").filter({ hasText: `sent while it restarts ${t}` });
    await expect(sent).toBeVisible();
    await page.waitForTimeout(1_000);
    await server.start();
    await expect.poll(async () => {
      const page_ = (await (await request.get(`${base}/api/c/${other.id}/items`)).json()) as { items: { kind: string; text?: string }[] };
      return page_.items.filter(item => item.text === `sent while it restarts ${t}`).length;
    }, { timeout: 20_000 }).toBe(1);
    backs.push(await backAfterListen(page, server, 3));
    info.annotations.push({ type: "live socket back after listen", description: backs.map(ms => `${ms} ms`).join(", ") });
    for (const ms of backs) expect(ms).toBeLessThan(2_000);

    // The page posts each failed call with its error at once (client.ts `recordTiming`), so none came.
    await page.waitForTimeout(500);
    expect(calls.errors).toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { shown: string[] }).shown)).toEqual([]);
  } finally {
    await server.kill();
  }
});

/**
 * A hand-over's old server closes an idle kept connection just as `tailscale serve` sends a call on it, and Go's ReverseProxy answers
 * a bare 502 for a call it does not retry itself, such as a POST. The page sends a write that may run twice again (client.ts `twice`),
 * so a reaction, a PATCH and a DELETE in that moment land; a create goes once and fails, since a second run would create a second one.
 */
test("a bare 502 under a reaction, a post edit and a delete is tried again, and a room create is not", async ({ page, request }) => {
  const t = tag();
  const room = (await (await request.post("/api/rooms", { data: { kind: "channel", name: `bare-502-${t}`, members: [], test: true } })).json()) as { id: string };
  const sent = (await (await request.post(`/api/c/${room.id}/send`, { data: { text: `post ${t}`, requestId: `bare-${t}` } })).json()) as { item: { id: string } };
  const post = sent.item.id;
  const errors: string[] = [];
  await page.route(url => url.pathname === "/api/timings", async route => {
    const body = route.request().postDataJSON() as { samples?: { m: string; p: string; err?: string }[] } | null;
    for (const sample of body?.samples ?? []) if (sample.err) errors.push(`${sample.m} ${sample.p}: ${sample.err}`);
    await route.fulfill({ json: { ok: true } });
  });
  const seen = new Map<string, number>();
  await page.route(url => url.pathname.startsWith("/api/"), async route => {
    const key = `${route.request().method()} ${new URL(route.request().url()).pathname}`;
    if (route.request().method() === "GET" || key.endsWith(" /api/timings")) return route.fallback();
    seen.set(key, (seen.get(key) ?? 0) + 1);
    if (seen.get(key) === 1) return route.fulfill({ status: 502, body: "" });
    return route.fallback();
  });
  await open(page, `#/c/${room.id}`);
  const outcome = await page.evaluate(async ({ room, post, t }) => {
    const { api } = await import(/* @vite-ignore */ "/src/lib/api/client.ts");
    const settle = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => String(e instanceof Error ? e.message : e));
    return {
      react: await settle(api.react(room, post, "👍")),
      edit: await settle(api.editPost(room, post, `edited ${t}`)),
      delete: await settle(api.deletePost(room, post)),
      create: await settle(api.createRoom({ kind: "channel", name: `bare-502-b-${t}`, members: [], test: true })),
    };
  }, { room: room.id, post, t });
  expect(outcome).toEqual({ react: "ok", edit: "ok", delete: "ok", create: expect.stringContaining("502") });
  expect(seen.get(`POST /api/c/${room.id}/posts/${post}/reactions`)).toBe(2);
  expect(seen.get(`PATCH /api/c/${room.id}/posts/${post}`)).toBe(2);
  expect(seen.get(`DELETE /api/c/${room.id}/posts/${post}`)).toBe(2);
  expect(seen.get("POST /api/rooms")).toBe(1);
  await expect.poll(() => errors).toEqual(["POST /api/rooms: POST /api/rooms failed with 502"]);
});
