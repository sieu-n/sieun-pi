"""pi-rlm kernel relay: keeps one `python -m rlm.repl` kernel alive across pi-host restarts.

pi-rlm starts this relay in its own systemd scope (or its own session without systemd), so stopping pi-host does not stop the
kernel or the `bash()` process groups the kernel owns. The relay holds the kernel's stdio and serves the same JSONL protocol on a
unix socket to one client at a time, which is the session's pi-rlm.

While no client is attached, the relay keeps every kernel event in order and replays it to the next client, after a fresh `ready`
event that carries `reattached: true`, the id of a request still running, and the ids of host requests nobody answered. Host
requests the old client never answered are sent again, so a cell awaiting `rlm.spawn` or a `bash.completed` notice is not lost.

Relay-only requests from the client, never forwarded to the kernel:
  {"type":"relay_hello","host_socket":str|null,"wake_session":str}  where to ask for a reattach after a detach
  {"type":"relay_detach","wake":"now"|"on_event"}                   the client goes away on purpose
  {"type":"relay_kill"}                                              SIGKILL the kernel's process group and exit

After a detach with wake "now", or after the client vanished, the relay sends {"type":"get_state","activeSessionId":wake_session}
to pi-host's socket every 2 s until a client attaches, which reopens the session there. With wake "on_event" it does that only once
the kernel sends an event, such as a finished `bash()` handle. With no client for PI_RLM_RELAY_TTL_S seconds (default 86400) the
relay shuts the kernel down and exits.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
import time

TTL_S = float(os.environ.get("PI_RLM_RELAY_TTL_S", "86400"))
WAKE_EVERY_S = 2.0


class Relay:
    def __init__(self, socket_path: str, argv: list[str]) -> None:
        self.socket_path = socket_path
        self.argv = argv
        self.client: asyncio.StreamWriter | None = None
        self.buffer: list[bytes] = []
        self.ready: dict | None = None
        self.running: str | None = None
        self.unanswered: dict[str, bytes] = {}
        self.host_socket: str | None = None
        self.wake_session: str | None = None
        self.wake = "now"
        self.detached_at = time.monotonic()
        self.kernel: asyncio.subprocess.Process | None = None

    async def start(self) -> None:
        # The kernel exits when its owner pid dies. Its owner is this relay, its parent, never the pi-host that started the relay.
        os.environ.pop("PRIME_AGENT_KERNEL_OWNER_PID", None)
        self.kernel = await asyncio.create_subprocess_exec(
            *self.argv, stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, limit=64 * 1024 * 1024, start_new_session=True
        )
        if os.path.exists(self.socket_path):
            os.unlink(self.socket_path)
        server = await asyncio.start_unix_server(self.on_client, path=self.socket_path, limit=64 * 1024 * 1024)
        os.chmod(self.socket_path, 0o600)
        print(json.dumps({"relay": "listening", "pid": os.getpid(), "kernel_pid": self.kernel.pid}), flush=True)
        asyncio.get_running_loop().create_task(self.wake_loop())
        try:
            await self.pump_kernel()
        finally:
            server.close()
            try:
                os.unlink(self.socket_path)
            except FileNotFoundError:
                pass

    async def pump_kernel(self) -> None:
        assert self.kernel and self.kernel.stdout
        while True:
            line = await self.kernel.stdout.readline()
            if not line:
                break
            try:
                event = json.loads(line)
            except ValueError:
                event = {}
            kind = event.get("event")
            if kind == "ready":
                self.ready = event
            elif kind == "host_request":
                self.unanswered[str(event.get("id"))] = line
            elif kind == "done" and event.get("id") == self.running:
                self.running = None
            await self.forward(line)
        await self.kernel.wait()
        if self.client:
            self.client.close()

    async def forward(self, line: bytes) -> None:
        if self.client is not None:
            try:
                self.client.write(line)
                await self.client.drain()
                return
            except (ConnectionError, RuntimeError):
                self.drop_client()
        self.buffer.append(line)

    def drop_client(self) -> None:
        if self.client is not None:
            try:
                self.client.close()
            except Exception:
                pass
        self.client = None
        self.detached_at = time.monotonic()

    async def on_client(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if self.client is not None:
            self.drop_client()
        self.client = writer
        ready = dict(self.ready or {"event": "ready", "protocol": 3})
        if self.ready is not None:
            ready.update({"reattached": True, "running": self.running, "unanswered": list(self.unanswered)})
        replay = [json.dumps(ready).encode() + b"\n"] if self.ready is not None else []
        replayed = set()
        for line in self.buffer:
            replay.append(line)
            try:
                rid = json.loads(line).get("id")
            except ValueError:
                rid = None
            replayed.add(str(rid))
        replay += [line for rid, line in self.unanswered.items() if rid not in replayed]
        self.buffer = []
        try:
            for line in replay:
                writer.write(line)
            await writer.drain()
        except ConnectionError:
            self.drop_client()
            return
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                await self.on_request(line)
        except ConnectionError:
            pass
        finally:
            if self.client is writer:
                self.drop_client()

    async def on_request(self, line: bytes) -> None:
        try:
            req = json.loads(line)
        except ValueError:
            req = {}
        kind = req.get("type")
        if kind == "relay_hello":
            self.host_socket = req.get("host_socket") or None
            self.wake_session = req.get("wake_session") or None
            self.wake = "now"
            return
        if kind == "relay_detach":
            self.wake = req.get("wake") or "on_event"
            self.drop_client()
            return
        if kind == "relay_kill":
            self.kill()
            return
        if kind == "execute":
            self.running = str(req.get("id"))
        elif kind == "host_reply":
            self.unanswered.pop(str(req.get("id")), None)
        assert self.kernel and self.kernel.stdin
        self.kernel.stdin.write(line)
        await self.kernel.stdin.drain()

    def kill(self) -> None:
        if self.kernel and self.kernel.returncode is None:
            try:
                os.killpg(self.kernel.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    async def wake_loop(self) -> None:
        while True:
            await asyncio.sleep(WAKE_EVERY_S)
            if self.client is not None:
                continue
            if time.monotonic() - self.detached_at > TTL_S:
                assert self.kernel and self.kernel.stdin
                self.kernel.stdin.write(b'{"type":"shutdown"}\n')
                return
            due = self.wake == "now" or bool(self.buffer)
            if due and self.host_socket and self.wake_session:
                await self.ask_host()

    async def ask_host(self) -> None:
        try:
            reader, writer = await asyncio.wait_for(asyncio.open_unix_connection(self.host_socket), 2)
        except (OSError, asyncio.TimeoutError):
            return
        try:
            await asyncio.wait_for(reader.readline(), 5)
            writer.write(json.dumps({"id": "relay-wake", "type": "get_state", "activeSessionId": self.wake_session}).encode() + b"\n")
            await writer.drain()
            deadline = time.monotonic() + 60
            while time.monotonic() < deadline:
                line = await asyncio.wait_for(reader.readline(), 60)
                if not line:
                    break
                if b'"relay-wake"' in line:
                    break
        except (OSError, asyncio.TimeoutError, ValueError):
            pass
        finally:
            writer.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--socket", required=True)
    parser.add_argument("kernel", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    argv = args.kernel[1:] if args.kernel[:1] == ["--"] else args.kernel
    signal.signal(signal.SIGHUP, signal.SIG_IGN)
    asyncio.run(Relay(args.socket, argv).start())


if __name__ == "__main__":
    sys.exit(main())
