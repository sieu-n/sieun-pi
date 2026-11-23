"""The ClickHouse sink: one HTTP POST of `INSERT INTO <table> FORMAT JSONEachRow` per batch.

sink.json (default ~/.config/usage-collector/sink.json):
  url             ClickHouse's HTTP address, or the HTTPS door that forwards to it
  table           default ai_usage.model_calls (DATABASE below)
  user, password  sent as X-ClickHouse-User and X-ClickHouse-Key when set
  headers         extra headers, such as {"Authorization": "Bearer ..."} for a door
  token_file      a file whose text is sent as "Authorization: Bearer <text>", so the secret stays in the file it already lives in
  max_body_bytes  default 1000000, the body cap of the devbox-push door (store.md section 3)

The prod store takes writes through the devbox-push door, which forwards a fixed INSERT as usage_writer and passes
insert_deduplication_token through; on us-metal02 its sink.json is
  {"url": "https://devbox-push.virev.ai/ai_usage/model_calls", "token_file": "/home/sieun/box-ops/obs/alloy/push-token"}
A test rig is ClickHouse itself: {"url": "http://127.0.0.1:18123/"}.
"""
from __future__ import annotations

import hashlib
import json
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict


# The store's database. The product's billing ledger took the name `usage`, and the name may move again, so this is its one place:
# schema.sql names it too, and the tests read it from here.
DATABASE = "ai_usage"
TABLE = f"{DATABASE}.model_calls"


class SinkError(RuntimeError):
    pass


class Sink:
    def __init__(self, config: Dict[str, Any]) -> None:
        if not config.get("url"):
            raise SinkError("sink config has no url")
        self.url = str(config["url"])
        self.table = str(config.get("table") or TABLE)
        self.max_body_bytes = int(config.get("max_body_bytes") or 1_000_000)
        self.timeout = float(config.get("timeout_s") or 60)
        self.headers = {"Content-Type": "application/x-ndjson", **{str(k): str(v) for k, v in (config.get("headers") or {}).items()}}
        if config.get("user"):
            self.headers["X-ClickHouse-User"] = str(config["user"])
            self.headers["X-ClickHouse-Key"] = str(config.get("password") or "")
        if config.get("token_file"):
            token = Path(str(config["token_file"])).expanduser().read_text().strip()
            self.headers["Authorization"] = f"Bearer {token}"

    @property
    def id(self) -> str:
        """Names the store this sink writes to; the cursors live under it, so a new url or table starts with no cursor."""
        return hashlib.sha256(f"{self.url}\n{self.table}".encode()).hexdigest()[:16]

    @classmethod
    def load(cls, path: Path) -> "Sink":
        try:
            return cls(json.loads(path.read_text()))
        except FileNotFoundError:
            raise SinkError(f"no sink config at {path}") from None

    def query_url(self, params: Dict[str, str]) -> str:
        joiner = "&" if "?" in self.url else "?"
        return self.url + joiner + urllib.parse.urlencode(params)

    def insert(self, body: bytes, token: str) -> None:
        url = self.query_url({
            "query": f"INSERT INTO {self.table} FORMAT JSONEachRow",
            "insert_deduplication_token": token,
            "async_insert": "0",
        })
        request = urllib.request.Request(url, data=body, headers=self.headers, method="POST")
        try:
            with urllib.request.urlopen(request, timeout=self.timeout) as response:
                response.read()
        except urllib.error.HTTPError as error:
            detail = error.read()[:500].decode(errors="replace")
            raise SinkError(f"HTTP {error.code} from {self.url}: {detail}") from None
        except OSError as error:
            raise SinkError(f"{type(error).__name__} from {self.url}: {error}") from None

    def query(self, sql: str) -> str:
        """A read, for tests and checks against a sink that is ClickHouse itself."""
        request = urllib.request.Request(self.query_url({}), data=sql.encode(), headers=self.headers, method="POST")
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return response.read().decode()
