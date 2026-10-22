// Chrome DevTools Protocol over --remote-debugging-pipe for client tests that mount a Svelte component in a headless Chrome.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const CHROMES = [process.env.CHROME_BIN, "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].filter((path): path is string => !!path);
/** The first Chrome binary on this host, undefined when none is installed. */
export const chrome = CHROMES.find(path => existsSync(path));

/** Talks Chrome DevTools Protocol over --remote-debugging-pipe: fd 3 carries requests, fd 4 carries replies, each a NUL-ended JSON message. */
export function devtools(binary: string, profile: string, url: string) {
  const child = spawn(binary, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-pipe", `--user-data-dir=${profile}`, "--window-size=1100,800", url],
    { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] });
  const [input, output] = [child.stdio[3] as NodeJS.WritableStream, child.stdio[4] as NodeJS.ReadableStream];
  const waiting = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const listeners: { method: string; sessionId: string; done: () => void }[] = [];
  let buffered = "", next = 0;
  output.on("data", (chunk: Buffer) => {
    buffered += chunk.toString("utf8");
    for (let end = buffered.indexOf("\0"); end >= 0; end = buffered.indexOf("\0")) {
      const message = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      if (message.method) { for (const listen of listeners) if (listen.method === message.method && listen.sessionId === message.sessionId) listen.done(); continue; }
      const entry = waiting.get(message.id);
      if (!entry) continue;
      waiting.delete(message.id);
      if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
    }
  });
  const send = (method: string, params: object = {}, sessionId?: string): Promise<any> => new Promise((resolve, reject) => {
    const id = ++next;
    waiting.set(id, { resolve, reject });
    input.write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
  const onEvent = (method: string, sessionId: string, done: () => void) => { listeners.push({ method, sessionId, done }); };
  return { send, onEvent, close: () => new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill(); }) };
}

/** Opens `url` in a fresh headless Chrome page and returns an evaluate that awaits promises and returns values; Chrome starts on about:blank and navigates once attached, as accounts-row-click.test.ts explains. */
export async function openPage(binary: string, profile: string, url: string) {
  const browser = devtools(binary, profile, "about:blank");
  const { targetInfos } = await browser.send("Target.getTargets");
  const page = targetInfos.find((target: { type: string }) => target.type === "page");
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  await browser.send("Page.enable", {}, sessionId);
  const loaded = new Promise<void>(resolve => browser.onEvent("Page.loadEventFired", sessionId, resolve));
  await browser.send("Page.navigate", { url }, sessionId);
  await loaded;
  const evaluate = async (expression: string) => {
    const reply = await browser.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  };
  return { browser, evaluate };
}
