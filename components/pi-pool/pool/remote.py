"""One pool for two machines. The machine that holds the accounts runs `pi-pool serve` on
its tailnet address; the other machine's pi-pool sends its token requests and account
commands there and keeps turn slots to itself.

serve.json (holder) and remote.json (client) live in the pool folder, mode 0600:
    serve.json   {"host": "<tailnet ip>", "port": 7781, "secret": "..."}
    remote.json  {"url": "http://<tailnet ip>:7781", "secret": "..."}
"""
import json, os, sys

from . import base, registry

SERVE = os.path.join(base.POOL, "serve.json")
REMOTE = os.path.join(base.POOL, "remote.json")
KEY_ENV = "PI_POOL_SESSION_KEY"
OFF_ENV = "PI_POOL_REMOTE"
# Turn slots, the session's class and the login hand-off stay on the machine the session runs on.
# A sign-in runs where its browser is and files the login with the holder (file-login).
LOCAL_COMMANDS = {"admit", "release", "owner-turn", "prod", "queue", "priority", "adopt-logins", "config", "set", "log", "serve",
                  "login"}
# This holds a terminal open; run it on the machine that holds the accounts.
HOLDER_ONLY = {"watch"}
# Prime gives the token hook 10 s (vend.log_when_killed); answer before that so the hook can log why.
TOKEN_WAIT_SEC = 9


class Unreachable(Exception):
    pass


def client():
    if os.environ.get(OFF_ENV) == "off":
        return None
    cfg = base.load_json(REMOTE)
    return cfg if isinstance(cfg, dict) and cfg.get("url") and cfg.get("secret") else None


def forwards(argv):
    if argv and argv[0] == "--cli":
        return (argv[1] if len(argv) > 1 else "status") not in LOCAL_COMMANDS
    return True


def session_fields():
    key = registry.session_key()
    return {"key": key.key, "uuid": key.uuid, "active": key.active_id} if key else None


def ask(cfg, argv, stdin=None):
    """(exit code, stdout, stderr) of argv run by the holder's pool, with `stdin` as its input."""
    import socket, urllib.error, urllib.request
    token = not (argv and argv[0] == "--cli")
    body = json.dumps({"argv": argv, "session": session_fields(), "stdin": stdin}).encode()
    request = urllib.request.Request(cfg["url"].rstrip("/") + "/run", data=body, method="POST", headers={
        "Authorization": "Bearer " + cfg["secret"], "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TOKEN_WAIT_SEC if token else None) as answer:
            out = json.loads(answer.read())
    except urllib.error.HTTPError as e:
        raise Unreachable(f"remote pool refused the request (HTTP {e.code})") from None
    except (socket.timeout, urllib.error.URLError) as e:
        if isinstance(e, socket.timeout) or isinstance(getattr(e, "reason", None), socket.timeout):
            raise Unreachable(f"remote pool gave no answer in {TOKEN_WAIT_SEC} s") from None
        raise Unreachable(f"remote pool unreachable at {cfg['url']}: {type(e.reason).__name__}") from None
    except (OSError, ValueError) as e:
        raise Unreachable(f"remote pool unreachable at {cfg['url']}: {type(e).__name__}") from None
    return int(out["code"]), out.get("out") or "", out.get("err") or ""


def run_remote(cfg, argv):
    try:
        code, out, err = ask(cfg, argv)
    except Unreachable as e:
        raise SystemExit(f"pi-pool: {e}") from None
    sys.stdout.write(out)
    sys.stdout.flush()
    if code:
        raise SystemExit(err.strip() or code)
    if err:
        sys.stderr.write(err)
    return 0


def holder_command(root, argv):
    if argv and argv[0] == "--cli":
        return ["/usr/bin/python3", "-B", os.path.join(root, "bin", "pi-pool"), *argv[1:]]
    return ["/usr/bin/python3", "-B", os.path.join(root, "bin", "pi-pool-token"), *argv]


def holder_env(session):
    env = {k: v for k, v in os.environ.items() if k not in (base.SESSION_ENV, base.JOURNAL_ENV, KEY_ENV)}
    env[OFF_ENV] = "off"
    if session and session.get("key"):
        env[KEY_ENV] = json.dumps(session)
    return env


def valid_argv(argv):
    if not (isinstance(argv, list) and all(isinstance(a, str) for a in argv) and forwards(argv)):
        return False
    return not (argv and argv[0] == "--cli" and len(argv) > 1 and argv[1] in HOLDER_ONLY)


def make_handler(cfg, root):
    import hmac, http.server, subprocess
    secret = cfg["secret"].encode()

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_POST(self):
            given = (self.headers.get("Authorization") or "").removeprefix("Bearer ").encode()
            if self.path != "/run" or not hmac.compare_digest(given, secret):
                base.log("remote_refused", client=self.client_address[0], path=self.path)
                return self.send_error(403)
            try:
                req = json.loads(self.rfile.read(int(self.headers.get("Content-Length") or 0)))
                argv, session, given_in = req["argv"], req.get("session"), req.get("stdin")
            except (ValueError, KeyError, TypeError):
                return self.send_error(400)
            if not valid_argv(argv) or not (session is None or isinstance(session, dict)) \
                    or not (given_in is None or isinstance(given_in, str)):
                return self.send_error(400)
            done = subprocess.run(holder_command(root, argv), env=holder_env(session), input=given_in or "",
                                  capture_output=True, text=True)
            body = json.dumps({"code": done.returncode, "out": done.stdout, "err": done.stderr}).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def cmd_serve(rest=()):
    import http.server
    cfg = base.load_json(SERVE)
    if not (isinstance(cfg, dict) and cfg.get("host") and cfg.get("port") and cfg.get("secret")):
        raise SystemExit(f"pi-pool serve: {SERVE} needs host, port and secret")
    root = cfg.get("root") or base.POOL
    server = http.server.ThreadingHTTPServer((cfg["host"], int(cfg["port"])), make_handler(cfg, root))
    base.log("remote_serve", host=cfg["host"], port=int(cfg["port"]))
    server.serve_forever()
