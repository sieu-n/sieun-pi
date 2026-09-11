import ipaddress
import json
import os
import re
import sys
from urllib.parse import urlsplit


def deny(message):
    marker = os.environ.get("PI_POOL_TEST_ISOLATION_LOG")
    if marker:
        with open(marker, "a") as output:
            output.write(json.dumps({"pid": os.getpid(), "violation": message}) + "\n")
    raise RuntimeError("pi-pool fixture isolation: " + message)


def check_host(host):
    if os.environ.get("PI_POOL_TEST_ALLOW_LOOPBACK") == "1":
        try:
            if ipaddress.ip_address(host).is_loopback:
                return
        except ValueError:
            if host == "localhost":
                return
    deny("network access denied to " + str(host))


def guard(event, args):
    if event in ("subprocess.Popen", "os.posix_spawn", "os.system", "os.exec"):
        command = " ".join(str(value) for value in args[:2])
        if re.search(r"(?:/usr/bin/security|[\s'\"]security[\s'\"])", command):
            deny("macOS Keychain command denied")
    elif event == "urllib.Request":
        check_host(urlsplit(args[0]).hostname)
    elif event == "socket.connect" and isinstance(args[1], tuple):
        check_host(args[1][0])
    elif event == "socket.getaddrinfo":
        check_host(args[0])


sys.addaudithook(guard)
