"""The 10-18 keeper storm: a slow daemon or a live daemon with no socket path never gets a second daemon started next to it."""
import importlib.util, os, socket, tempfile, threading, unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("keeper", Path(__file__).resolve().parents[1] / "keeper.py")
keeper = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keeper)

SOCK = "/var/folders/xr/dg7p5bwj479742q3nl2t23b80000gn/T/prime-agent-501/daemon.sock"


class Decide(unittest.TestCase):
    def test_a_slow_connect_counts_as_alive(self):
        self.assertEqual(keeper.decide(["slow", "slow"], []), "wait")

    def test_a_single_down_probe_waits(self):
        self.assertEqual(keeper.decide(["up", "down"], []), "wait")

    def test_a_live_daemon_with_no_socket_path_is_stuck_and_gets_no_second_daemon(self):
        self.assertEqual(keeper.decide(["down", "down"], [2547]), "stuck")

    def test_no_daemon_and_a_dead_socket_starts_one(self):
        self.assertEqual(keeper.decide(["down", "down"], []), "start")


class Pids(unittest.TestCase):
    def test_finds_the_daemon_and_a_login_shell_starting_one_and_nothing_else(self):
        ps = "\n".join([
            f" 2547 /Users/x/.local/share/prime-agent/releases/r/prime-agent /$bunfs/root/prime-agent --mode daemon --daemon-socket {SOCK}",
            f"78741 /bin/zsh -i -l -c exec /Users/x/.local/share/prime-agent/bin/prime-agent --mode daemon --daemon-socket {SOCK}",
            " 4434 /Users/x/.local/share/prime-agent/releases/r/prime-agent --mode daemon --daemon-socket /var/folders/T/prime-agent-501/worker-a-b.sock",
            "  900 grep daemon.sock",
        ])
        self.assertEqual(keeper.daemon_pids(SOCK, ps), [2547, 78741])


class Probe(unittest.TestCase):
    def test_missing_path_is_down_and_a_listening_socket_is_up(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = os.path.join(tmp, "d.sock")
            self.assertEqual(keeper.probe(path, 1.0), "down")
            server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            server.bind(path)
            server.listen(1)
            try:
                self.assertEqual(keeper.probe(path, 1.0), "up")
            finally:
                server.close()


if __name__ == "__main__":
    unittest.main()
