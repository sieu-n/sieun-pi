import { expect, test } from "@playwright/test";
import WebSocket from "ws";

/**
 * The socket hands each event to the listeners it has when the event comes. The Skills page's listener opened the socket as its module
 * loaded, while main.ts still waited on IndexedDB before the page's lists (stores.svelte.ts `Global`) listened, and the fixture's hello
 * comes 30 to 50 ms after the socket opens: in 5 of 40 loads of #/agents on 11-23 that hello came first, and the page had no sidebar, no
 * agents from it and read no panel ahead until the socket opened again. This spec sends the hello the moment the page's socket opens.
 */
const AGENT = "ag_ai-harness-developer-environment-vp";

const firstHello = (url: string): Promise<string> => new Promise((resolve, reject) => {
  const socket = new WebSocket(url);
  socket.on("message", (data) => {
    if ((JSON.parse(String(data)) as { type: string }).type !== "hello") return;
    socket.close();
    resolve(String(data));
  });
  socket.on("error", reject);
});

test("a hello that comes the moment the socket opens fills the sidebar and reads the boards ahead", async ({ page, baseURL }) => {
  const live = `${baseURL!.replace(/^http/, "ws")}/api/live`;
  const hello = await firstHello(live);
  await page.routeWebSocket(/\/api\/live/, (route) => {
    route.send(hello);
    // The server's own hello is the one above, so only the events after it pass.
    const upstream = new WebSocket(live);
    let first = true;
    upstream.on("message", (data) => {
      if (first) {
        first = false;
        return;
      }
      route.send(String(data));
    });
    route.onMessage((message) => (upstream.readyState === WebSocket.OPEN ? upstream.send(message) : upstream.once("open", () => upstream.send(message))));
    route.onClose(() => upstream.close());
  });
  const board = page.waitForResponse((r) => new URL(r.url()).pathname === `/api/agents/${AGENT}/board`, { timeout: 10_000 });
  await page.goto("/#/agents");
  await board;
  await page.evaluate(() => { location.hash = "#/"; });
  await expect(page.getByRole("navigation", { name: "Conversations" }).locator('[data-section="solo"]')).toContainText("relay protocol");
});
