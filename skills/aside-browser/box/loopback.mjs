// The tunnel a box runner opens when a kernel on the owner's Mac starts it over ssh (BOX_LOOPBACK_VIA=<the Mac's ssh host>):
// `ssh -D` gives Chrome a SOCKS5 proxy whose connections open on the Mac, so localhost:5180 and cc.localhost:5180 in a box tab
// are the Mac's own dev servers while the page renders here. The ssh client dies with the runner (setpriv --pdeathsig).
import { spawn } from "node:child_process";
import net from "node:net";

const accepts = (port) => new Promise((resolve) => {
  const c = net.connect(port, "127.0.0.1");
  c.once("connect", () => { c.destroy(); resolve(true); });
  c.once("error", () => resolve(false));
});

async function freePort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, "127.0.0.1", resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

/** Starts `ssh -N -D` to `host` and resolves once its SOCKS port takes connections; rejects when ssh exits first. */
export async function startLoopbackTunnel(host) {
  const port = await freePort();
  const proc = spawn("setpriv", ["--pdeathsig", "KILL", "--", "ssh", "-N", "-T", "-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes",
    "-D", `127.0.0.1:${port}`, host], { stdio: ["ignore", "ignore", "pipe"] });
  let log = "";
  proc.stderr.on("data", (d) => { log += d; });
  // ssh binds the port only after it has logged in, so the wait ends at the first accepted connect or when ssh exits.
  while (!(await accepts(port))) {
    if (proc.exitCode !== null || proc.signalCode !== null) throw new Error(`ssh -D to ${host} exited (${proc.exitCode ?? proc.signalCode}): ${log.slice(-500)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  proc.stderr.unref();
  return { proxy: { server: `socks5://127.0.0.1:${port}`, bypass: "<-loopback>" }, close: () => proc.kill("SIGKILL") };
}
