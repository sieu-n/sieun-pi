// 10-27: a pi-host session on the Mac failed every cell with "AF_UNIX path too long", because its kernel socket sat under macOS's per-user
// tmpdir, /var/folders/xr/<...>/T/pi-rlm/kernel-<session id>.sock, past the 104-byte cap on unix socket paths.
import assert from "node:assert/strict";
import { test } from "node:test";
import { relayPaths } from "../src/core/kernel.ts";

test("off Linux the kernel socket path stays under macOS's 104-byte cap", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
  const tmp = process.env.TMPDIR;
  Object.defineProperty(process, "platform", { value: "darwin" });
  process.env.TMPDIR = "/var/folders/xr/dg7p5bwj479742q3nl2t23b80000gn/T/";
  try {
    const { socket } = relayPaths("/tmp/artifacts", "01a17e93-389f-7011-a6da-607d868f4562");
    assert.ok(Buffer.byteLength(socket) < 104, `${socket} is ${Buffer.byteLength(socket)} bytes`);
    assert.ok(!socket.startsWith("/var/folders/"), socket);
  } finally {
    Object.defineProperty(process, "platform", platform);
    if (tmp === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = tmp;
  }
});
