// One private X display per browser run, so Chrome runs headful on a Linux host with no screen. Xvfb picks a free display
// number itself (-displayfd) and dies with the process that started it (setpriv --pdeathsig), so a killed runner leaves
// no X server behind.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const UNPACKED = path.join(os.homedir(), ".local/opt/xvfb");

// The unpacked Xvfb from deploy/linux/README.md (Tools, steps 3 and 4) runs xkbcomp from its working directory, else Xvfb on PATH.
function xvfb() {
  if (process.env.BOX_XVFB) return { bin: process.env.BOX_XVFB, cwd: undefined, env: process.env };
  const bin = path.join(UNPACKED, "usr/bin/Xvfb-localxkb");
  if (fs.existsSync(bin)) {
    return { bin, cwd: path.dirname(bin), env: { ...process.env, LD_LIBRARY_PATH: path.join(UNPACKED, "usr/lib/x86_64-linux-gnu") } };
  }
  const found = (process.env.PATH || "").split(":").map((d) => path.join(d, "Xvfb")).find((p) => fs.existsSync(p));
  return found ? { bin: found, cwd: undefined, env: process.env } : null;
}

export function hasDisplayServer() {
  return process.platform === "linux" && xvfb() !== null;
}

export async function startDisplay() {
  const x = xvfb();
  if (!x) throw new Error("no Xvfb on this host; install it as deploy/linux/README.md (Tools, steps 3 and 4) says");
  const proc = spawn("setpriv", ["--pdeathsig", "KILL", "--", x.bin, "-displayfd", "3", "-screen", "0", "1920x1080x24", "-nolisten", "tcp", "-xkbdir", "/usr/share/X11/xkb"],
    { cwd: x.cwd, env: x.env, stdio: ["ignore", "ignore", "pipe", "pipe"] });
  let log = "";
  proc.stderr.on("data", (d) => { log += d; });
  const display = await new Promise((resolve, reject) => {
    let out = "";
    proc.stdio[3].on("data", (d) => {
      out += d;
      if (out.includes("\n")) resolve(`:${out.trim()}`);
    });
    proc.on("exit", (code, signal) => reject(new Error(`Xvfb exited (${code ?? signal}) before it named a display: ${log.slice(-800)}`)));
    proc.on("error", reject);
  });
  proc.stdio[3].destroy();
  proc.unref();
  proc.stderr.unref();
  return { display, pid: proc.pid, close: () => { proc.kill("SIGKILL"); } };
}
