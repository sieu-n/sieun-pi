"""10-27 hello fix: the thread mover opened the moved thread with DaemonClient's default 3 s waits, while probes on us-metal02 got the daemon's
hello after 3 to 7 s on 10-22. Run: python3 -B -m unittest tests/test_move_thread_host_hello.py"""
import importlib.util, json, os, socket, tempfile, threading, time, unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().parent.parent / "scripts/move-thread-host.py"
HELLO = {"type": "daemon_hello", "protocol": {"name": "prime-agent.daemon", "version": 7}, "schemaRevision": 30, "appVersion": "fixture",
         "serverCapabilities": []}


def slow_daemon(path, hello_s):
    """A daemon on `path` that greets after `hello_s` and answers create and prompt with success."""
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(path)
    server.listen()

    def serve(conn):
        time.sleep(hello_s)
        conn.sendall((json.dumps(HELLO) + "\n").encode())
        buf = b""
        while True:
            chunk = conn.recv(65536)
            if not chunk:
                return
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                msg = json.loads(line)
                command = msg.get("command") or msg
                if command.get("type") == "ack_result":
                    continue
                data = {"activeSessionId": "w1", "sessionId": "s1"} if command.get("type") == "create" else {}
                conn.sendall((json.dumps({"type": "response", "id": msg["id"], "command": command.get("type"), "success": True, "data": data}) + "\n").encode())

    def accept():
        while True:
            try:
                conn, _ = server.accept()
            except OSError:
                return
            threading.Thread(target=serve, args=(conn,), daemon=True).start()

    threading.Thread(target=accept, daemon=True).start()
    return server


class OpenWaitsForASlowHello(unittest.TestCase):
    def test_the_open_takes_a_hello_that_comes_after_4_s(self):
        spec = importlib.util.spec_from_file_location("move_thread_host", SCRIPT)
        mover = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mover)
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "daemon.sock")
            server = slow_daemon(path, 4)
            try:
                code, out, err = mover.run(["node", "--input-type=module", "-e", mover.OPEN_JS, str(mover.DAEMON_CLIENT), path, "/tmp/s1.jsonl", "60000", ""])
            finally:
                server.close()
        self.assertEqual(code, 0, err)
        self.assertTrue(json.loads(out)["created"]["success"])


if __name__ == "__main__":
    unittest.main()
