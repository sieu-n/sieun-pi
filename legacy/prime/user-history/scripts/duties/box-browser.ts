import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** The aside-browser box runner: a headful Chrome on its own Xvfb display, driven by JSON lines on stdin and stdout. */
export class BoxBrowser {
  private next = 1;
  private waiting = new Map<number, (reply: { out?: string; error?: string }) => void>();
  private constructor(private child: ReturnType<typeof spawn>) {
    createInterface({ input: child.stdout! }).on("line", line => {
      try { const reply = JSON.parse(line) as { id: number; out?: string; error?: string }; this.waiting.get(reply.id)?.(reply); this.waiting.delete(reply.id); }
      catch { /* runner chatter */ }
    });
    child.on("exit", () => { for (const done of this.waiting.values()) done({ error: "the box runner exited" }); this.waiting.clear(); });
  }
  static start(runner = process.env.BOX_RUNNER || join(homedir(), ".prime/agent/skills/aside-browser/box/box.mjs")): BoxBrowser {
    return new BoxBrowser(spawn(process.execPath, [runner], { stdio: ["pipe", "pipe", "inherit"] }));
  }
  run(code: string, timeoutMs: number): Promise<string> {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error(`the box browser call took over ${timeoutMs / 1000} s`)); }, timeoutMs);
      this.waiting.set(id, reply => { clearTimeout(timer); reply.error ? reject(new Error(reply.error.split("\n")[0])) : resolve(reply.out ?? ""); });
      this.child.stdin!.write(JSON.stringify({ id, code }) + "\n");
    });
  }
  async close(): Promise<void> {
    this.child.stdin!.end();
    await new Promise<void>(resolve => { const timer = setTimeout(() => { this.child.kill("SIGKILL"); resolve(); }, 15_000); this.child.on("exit", () => { clearTimeout(timer); resolve(); }); });
  }
}
