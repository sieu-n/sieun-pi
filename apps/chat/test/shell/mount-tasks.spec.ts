import { expect, test, type Page } from "@playwright/test";
import { open } from "../channel/helpers";

/**
 * A reload used to read every kept page, render its first markdown and mount the app in one task: on 11-25 that task took 164 to 196 ms at
 * CPU rate 1 and 800 ms at rate 4 on live, and held the open's first answers behind it (~/work/p300-channel-open/trace-summary.md). Now
 * each cache is read in a task of its own, markdown warms up in another, and the app mounts in a later task with no forced layout.
 * The spec reads the task of each step from a Chrome trace.
 */

/** Marks each read of a kept cache, the first HTML parse (DOMPurify's, as markdown renders) and the app's mount in the trace. */
const marks = () => {
  const reads = new WeakMap<IDBRequest, string>();
  const getAll = IDBObjectStore.prototype.getAll;
  IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, query?: IDBValidKey | IDBKeyRange | null, count?: number) {
    const request = getAll.call(this, query, count);
    if (this.name === "pages") reads.set(request, query instanceof IDBKeyRange ? String((query.lower as unknown[])[0]) : "*");
    return request;
  };
  const result = Object.getOwnPropertyDescriptor(IDBRequest.prototype, "result")!;
  const marked = new WeakSet<IDBRequest>();
  Object.defineProperty(IDBRequest.prototype, "result", {
    ...result,
    get(this: IDBRequest) {
      const cache = reads.get(this);
      if (cache !== undefined && !marked.has(this)) {
        marked.add(this);
        performance.mark(`kept-read ${cache}`);
      }
      return result.get!.call(this);
    },
  });
  const parse = DOMParser.prototype.parseFromString;
  let parsed = false;
  DOMParser.prototype.parseFromString = function (this: DOMParser, ...args: Parameters<DOMParser["parseFromString"]>) {
    if (!parsed) performance.mark("first-html-parse");
    parsed = true;
    return parse.apply(this, args);
  };
  new MutationObserver((_, observer) => {
    if (!document.getElementById("app")?.firstElementChild) return;
    performance.mark("app-mounted");
    observer.disconnect();
  }).observe(document, { childList: true, subtree: true });
};

type Frame = { functionName: string; url: string; lineNumber: number; columnNumber: number };
type TraceEvent = { name: string; ph: string; ts: number; dur?: number; pid: number; tid: number; cat?: string; args?: { beginData?: { stackTrace?: Frame[] } } };

async function traceReload(page: Page): Promise<TraceEvent[]> {
  const cdp = await page.context().newCDPSession(page);
  const events: TraceEvent[] = [];
  cdp.on("Tracing.dataCollected", ({ value }) => events.push(...(value as unknown as TraceEvent[])));
  const done = new Promise((resolve) => cdp.once("Tracing.tracingComplete", resolve));
  await cdp.send("Tracing.start", { categories: "toplevel,devtools.timeline,disabled-by-default-devtools.timeline.stack,blink.user_timing", transferMode: "ReportEvents" });
  await page.reload();
  await expect(page.locator("section.conversation [data-message-id]").first()).toBeVisible();
  await page.waitForTimeout(500);
  await cdp.send("Tracing.end");
  await done;
  return events;
}

test("a reload reads each kept cache, warms markdown and mounts the app in tasks of their own, with no layout forced in the mount", async ({ page }) => {
  await open(page, "#/c/ch_general");
  // The room's page and the hello's buckets are kept for the next load.
  await expect
    .poll(() => page.evaluate(() => new Promise<string[]>((resolve) => {
      const request = indexedDB.open("chat.pages");
      request.onsuccess = () => {
        const all = request.result.transaction("pages").objectStore("pages").getAllKeys();
        all.onsuccess = () => {
          request.result.close();
          resolve([...new Set((all.result as [string, string][]).map(([cache]) => cache))].sort());
        };
      };
    })), { timeout: 15_000 })
    .toEqual(expect.arrayContaining(["hello-bucket", "timeline"]));
  await page.addInitScript(marks);

  const events = await traceReload(page);
  const named = (name: string) => events.filter((e) => e.name === name && e.cat?.includes("blink.user_timing"));
  const mounted = named("app-mounted")[0];
  expect(mounted, "the app mounted").toBeTruthy();
  const main = (e: TraceEvent) => e.pid === mounted!.pid && e.tid === mounted!.tid;
  const tasks = events.filter((e) => main(e) && e.ph === "X" && (e.name === "RunTask" || e.name === "ThreadControllerImpl::RunTask"));
  /** The outermost task that ran an event. */
  const taskOf = (e: TraceEvent) => tasks.filter((t) => t.ts <= e.ts && e.ts <= t.ts + (t.dur ?? 0)).sort((a, b) => b.dur! - a.dur!)[0];
  const mountTask = taskOf(mounted!);
  expect(mountTask, "the mount ran in a task").toBeTruthy();

  const reads = events.filter((e) => main(e) && e.name.startsWith("kept-read ") && e.cat?.includes("blink.user_timing"));
  const readTask = (cache: string) => {
    const read = reads.find((e) => e.name === `kept-read ${cache}`);
    expect(read, `the page read the ${cache} cache on its own`).toBeTruthy();
    return taskOf(read!);
  };
  const buckets = readTask("hello-bucket");
  const timeline = readTask("timeline");
  expect(buckets, "the hello buckets came in a task apart from the timelines").not.toBe(timeline);
  for (const read of reads) expect(taskOf(read), `${read.name} came in a task apart from the mount`).not.toBe(mountTask);

  const parsed = named("first-html-parse").filter(main)[0];
  expect(parsed, "markdown rendered").toBeTruthy();
  expect(parsed!.ts, "markdown warmed up before the mount").toBeLessThan(mounted!.ts);
  expect(taskOf(parsed!), "markdown warmed up in a task apart from the mount").not.toBe(mountTask);

  const forced = events.filter((e) => main(e) && e.name === "Layout" && e.ts >= mountTask!.ts && e.ts <= mountTask!.ts + mountTask!.dur!);
  const stack = (e: TraceEvent) => (e.args?.beginData?.stackTrace ?? []).map((f) => `${f.functionName} ${f.url.split("/").pop()}:${f.lineNumber}:${f.columnNumber}`).join(" < ");
  expect(forced.map((e) => `${e.dur} us at ${stack(e)}`), "no layout ran inside the mount's task").toEqual([]);
});
