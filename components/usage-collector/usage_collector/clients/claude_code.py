"""Claude Code CLI and Claude Desktop's local agent sessions.

A port of tokscale's Claude Code reader (crates/tokscale-core/src/sessions/claudecode.rs
and the Claude lane of lib.rs at b265e836). One row per assistant response, keyed by
message.id:requestId. Claude Code writes a response several times while it streams,
so copies of one key merge by the largest value of each token field, inside a file and
across files (a resumed or forked transcript repeats earlier responses). call_at is the earliest
timestamp any copy of the response carries, so it does not depend on which copy is read first;
tokscale instead stamps the row with the prompt's time, which only moves duration, not tokens.
"""

from __future__ import annotations

import json
import os
from typing import Iterable, Optional

from usage_collector.outside import changed_files, parse_ts, row, walk_files

CLIENT = "claude-code"
SUBAGENT = "claude-code-subagent"


def roots(home: str) -> list:
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(home, ".claude")
    out = [os.path.join(base, "projects"), os.path.join(base, "transcripts")]
    for app in ("Library/Application Support/Claude", "AppData/Roaming/Claude", ".config/Claude"):
        for name in ("local-agent-mode-sessions", "claude-code-sessions"):
            top = os.path.join(home, app, name)
            for dirpath, dirnames, _ in os.walk(top):
                if os.path.basename(dirpath) == ".claude":
                    out += [os.path.join(dirpath, "projects"), os.path.join(dirpath, "transcripts")]
                    dirnames[:] = []
                dirnames.sort()
    return out


def _is_journal(path: str) -> bool:
    return os.path.basename(path) == "journal.jsonl" and "subagents" in path.split(os.sep)


def files(home: str) -> list:
    seen, out = set(), []
    for r in roots(home):
        for p in walk_files(r, lambda n: n.endswith(".jsonl")):
            real = os.path.realpath(p)
            if real not in seen and not _is_journal(p):
                seen.add(real)
                out.append(p)
    return out


def collect(ctx) -> Iterable[dict]:
    cache = ctx.cache.setdefault(CLIENT, {})
    paths = files(str(ctx.home))
    changed = changed_files(paths, ctx.state, ctx.since)
    for p in paths:
        try:
            st = os.stat(p)
        except OSError:
            cache.pop(p, None)
            continue
        hit = cache.get(p)
        if hit is None or hit[0] != (st.st_mtime_ns, st.st_size):
            cache[p] = ((st.st_mtime_ns, st.st_size), parse_file(p))
    for p in list(cache):
        if p not in paths:
            del cache[p]
    merged, unkeyed = merge(cache[p][1] for p in paths if p in cache)
    wanted = {p for _, p in changed}
    for m in list(merged.values()) + unkeyed:
        if m["path"] in wanted or m["paths"] & wanted:
            if m["ts"] >= ctx.since:
                yield to_row(m, ctx.host)
    if changed:
        ctx.state["mtime_cursor_ms"] = changed[-1][0]


def merge(per_file) -> tuple:
    """tokscale's cross-file merge: one message per key, each field the most complete copy."""
    merged, unkeyed = {}, []
    for messages in per_file:
        for m in messages:
            if m["key"] is None:
                unkeyed.append(dict(m, paths=set()))
                continue
            have = merged.get(m["key"])
            if have is None:
                merged[m["key"]] = dict(m, tokens=dict(m["tokens"]), paths=set())
                continue
            _merge_copy(have, m)
            have["paths"].add(m["path"])
    return merged, unkeyed


def _merge_copy(a: dict, b: dict):
    ta, tb = a["tokens"], b["tokens"]
    a_cache = ta["cache_read"] > 0 or ta["cache_write"] > 0
    b_cache = tb["cache_read"] > 0 or tb["cache_write"] > 0
    if a_cache and not b_cache and ta["input"] > 0:
        pass
    elif b_cache and not a_cache and tb["input"] > 0:
        ta["input"] = tb["input"]
    else:
        ta["input"] = max(ta["input"], tb["input"])
    for k in ("output", "cache_read", "cache_write"):
        ta[k] = max(ta[k], tb[k])
    ta["cache_write_1h"] = min(max(ta["cache_write_1h"], tb["cache_write_1h"]), ta["cache_write"])
    a["ts"] = min(a["ts"], b["ts"])
    a["duration"] = max(a["duration"] or 0, b["duration"] or 0) or None
    if not a["agent"]:
        a["agent"] = b["agent"]


def to_row(m: dict, host: str) -> dict:
    t = m["tokens"]
    key = m["key"] or f"nokey:{m['session']}:{os.path.basename(m['path'])}:{m['line']}"
    return row(
        source_key=f"claude-code:{host}:{key}", call_at=m["ts"], host=host, client=CLIENT,
        agent=m["agent"], session=m["session"], provider=m["provider"], model=m["model"],
        input_tokens=t["input"], output_tokens=t["output"], cache_read_tokens=t["cache_read"],
        cache_write_tokens=t["cache_write"], cache_write_1h_tokens=t["cache_write_1h"], duration_ms=m["duration"] or 0,
    )


def _int(v) -> Optional[int]:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    return int(v)


def _usage(u: dict) -> Optional[dict]:
    """The AnthropicUsage fields tokscale reads, or None when one has the wrong type (serde rejects the line)."""
    out = {}
    for k in ("input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"):
        v = u.get(k)
        if v is not None and _int(v) is None:
            return None
        out[k] = _int(v)
    cc = u.get("cache_creation")
    one_hour = cc.get("ephemeral_1h_input_tokens") if isinstance(cc, dict) else None
    out["one_hour"] = max(_int(one_hour) or 0, 0)
    out["split"] = out["cache_read_input_tokens"] is not None or out["cache_creation_input_tokens"] is not None
    return out


def _tokens(u: dict) -> dict:
    z = lambda k: max(u[k] or 0, 0)
    return {"input": z("input_tokens"), "output": z("output_tokens"), "cache_read": z("cache_read_input_tokens"),
            "cache_write": z("cache_creation_input_tokens"), "cache_write_1h": u["one_hour"]}


def _provider(model: str, hint: Optional[str]) -> str:
    m = model.lower()
    inferred = "anthropic" if m.startswith("claude") else "openai" if m.startswith(("gpt", "o1", "o3", "o4")) else "google" if m.startswith("gemini") else None
    if hint:
        h = hint.strip().lower()
        if h == "anthropic" and inferred and inferred != "anthropic":
            return inferred
        return h
    if "/" in model:
        return model.split("/", 1)[0].lower()
    return inferred or "unknown"


def _agent_name(path: str) -> str:
    stem = os.path.basename(path)[: -len(".jsonl")]
    try:
        with open(os.path.join(os.path.dirname(path), f"{stem}.meta.json")) as fh:
            agent_type = json.load(fh).get("agentType")
        if isinstance(agent_type, str) and agent_type.strip():
            return agent_type.strip()
    except (OSError, ValueError, AttributeError):
        pass
    return SUBAGENT


def parse_file(path: str) -> list:
    """Messages of one transcript, as tokscale's parse_claude_file returns them."""
    session = os.path.basename(path)[: -len(".jsonl")]
    messages, index, split_keys = [], {}, set()
    pending_start = None
    sidechain_checked = False
    agent = ""
    try:
        fh = open(path, "rb")
    except OSError:
        return []
    with fh:
        lineno = 0
        for raw_line in fh:
            lineno += 1
            try:
                s = raw_line.decode("utf-8").strip()
            except UnicodeDecodeError:
                continue
            if not s:
                continue
            try:
                e = json.loads(s)
            except ValueError:
                continue
            if not isinstance(e, dict) or not isinstance(e.get("type"), str):
                continue
            msg = e.get("message")
            if msg is not None and not isinstance(msg, dict):
                continue
            if not sidechain_checked:
                sidechain_checked = True
                if e.get("isSidechain") is True:
                    if isinstance(e.get("sessionId"), str):
                        session = e["sessionId"]
                    agent = _agent_name(path)
            etype = e["type"]
            ts = parse_ts(e.get("timestamp")) if isinstance(e.get("timestamp"), str) else None
            if etype in ("user", "tool_result"):
                if ts is not None:
                    pending_start = ts
                continue
            if etype != "assistant" or msg is None:
                continue
            model = msg.get("model") if isinstance(msg.get("model"), str) else None
            hint = msg.get("providerId") or msg.get("provider_id") or msg.get("provider") or e.get("providerId") or e.get("provider_id") or e.get("provider")
            hint = hint if isinstance(hint, str) else None
            if model is not None and model.strip().lower() == "<synthetic>":
                pending_start = None
                continue
            raw = msg.get("usage")
            if not isinstance(raw, dict):
                continue
            u = _usage(raw)
            if u is None:
                continue
            mid, rid = msg.get("id"), e.get("requestId")
            key = f"{mid}:{rid}" if isinstance(mid, str) and isinstance(rid, str) else f"message:{mid}" if isinstance(mid, str) else None
            if key is not None and key in index:
                have = messages[index[key]]
                _merge_stream(have, u, ts, key in split_keys)
                if u["split"]:
                    split_keys.add(key)
                parent = have
            else:
                if model is None:
                    continue
                stamp = ts if ts is not None else pending_start
                if stamp is None:
                    continue
                start = pending_start if pending_start is not None else stamp
                dur = (ts - pending_start) if ts is not None and pending_start is not None and ts > pending_start else None
                parent = {"key": key, "ts": stamp, "start": start, "model": model, "provider": _provider(model, hint), "session": session,
                          "agent": agent, "tokens": _tokens(u), "duration": dur, "path": path, "line": lineno}
                if key is not None:
                    index[key] = len(messages)
                    if u["split"]:
                        split_keys.add(key)
                messages.append(parent)
                pending_start = None
            for i, it in enumerate(raw.get("iterations") or [] if isinstance(raw.get("iterations"), list) else []):
                if not isinstance(it, dict) or it.get("type") != "advisor_message":
                    continue
                am = it.get("model")
                if not isinstance(am, str) or not am.strip() or am.strip().lower() == "<synthetic>":
                    continue
                au = _usage(it)
                if au is None:
                    continue
                akey = f"{parent['key']}:advisor:{i}" if parent["key"] else None
                if akey is not None and akey in index:
                    _merge_stream(messages[index[akey]], au, None, akey in split_keys)
                    if au["split"]:
                        split_keys.add(akey)
                    continue
                adv = {"key": akey, "ts": parent["ts"], "start": parent["start"], "model": am, "provider": parent["provider"], "session": session,
                       "agent": parent["agent"], "tokens": _tokens(au), "duration": None, "path": path, "line": lineno}
                if akey is not None:
                    index[akey] = len(messages)
                    if au["split"]:
                        split_keys.add(akey)
                messages.append(adv)
    for m in messages:
        t = m["tokens"]
        t["cache_write_1h"] = min(t["cache_write_1h"], t["cache_write"])
    return messages


def _merge_stream(have: dict, u: dict, ts: Optional[int], have_split: bool):
    t = have["tokens"]
    if u["split"] and not have_split:
        if u["input_tokens"] is not None:
            t["input"] = max(u["input_tokens"], 0)
    elif not (have_split and not u["split"]):
        t["input"] = max(t["input"], max(u["input_tokens"] or 0, 0))
    t["output"] = max(t["output"], max(u["output_tokens"] or 0, 0))
    t["cache_read"] = max(t["cache_read"], max(u["cache_read_input_tokens"] or 0, 0))
    t["cache_write"] = max(t["cache_write"], max(u["cache_creation_input_tokens"] or 0, 0))
    t["cache_write_1h"] = max(t["cache_write_1h"], u["one_hour"])
    if ts is not None:
        have["ts"] = min(have["ts"], ts)
        d = ts - have["start"]
        if d > 0:
            have["duration"] = max(have["duration"] or 0, d)
