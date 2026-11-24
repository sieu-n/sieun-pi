"""Codex CLI and the Codex app: rollouts under ~/.codex/sessions and archived_sessions.

A port of tokscale's Codex reader (crates/tokscale-core/src/sessions/codex.rs at
b265e836): one row per token_count that advances the thread's cumulative totals,
using last_token_usage when present and the total's delta otherwise, plus
token_usage_record items no token_count confirmed (compactions). A forked child
skips the parent's replayed history. Keys are tokscale's dedup keys, so a
rollout in both sessions/ and archived_sessions/ counts once.
"""

from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Iterable, Optional

from usage_collector.outside import changed_files, mark_read, parse_ts, read_text, row, walk_files

CLIENT = "codex"
MAX_DECODED_BYTES = 1024 * 1024 * 1024
MAX_RECORD_BYTES = 16 * 1024 * 1024
SETTLED_LIMIT = 16
# A full read of the Mac's 41,899 rollouts took 103 s on 2026-11-24, so 500 rollouts save the cursor about every 1.3 s.
CHECKPOINT_FILES = 500
AGENT_DEFAULT, AGENT_SUBAGENT, AGENT_GUARDIAN, AGENT_EXEC = "Codex", "Codex Subagent", "Codex Guardian", "Codex Headless"
_STR_FIELDS = ("id", "forked_from_id", "originator", "type", "model", "model_name", "service_tier", "response_id",
               "thread_id", "turn_id", "thread_source", "cwd", "model_provider", "message")
_INJECTED = ("<environment_context>", "<user_instructions>", "<system-reminder>")


def _keep(name: str) -> bool:
    stem, sep, suffix = name.partition(".jsonl")
    if not sep or not stem:
        return False
    return suffix == "" or (suffix.startswith(".") and not suffix.endswith(".json") and not suffix.endswith(".json.migrated"))


def roots(home: str) -> list:
    base = os.environ.get("CODEX_HOME") or os.path.join(home, ".codex")
    return [os.path.join(base, "sessions"), os.path.join(base, "archived_sessions")]


def collect(ctx) -> Iterable[dict]:
    from usage_collector.core import CHECKPOINT

    paths = [p for r in roots(str(ctx.home)) for p in walk_files(r, _keep)]
    seen = set()
    for n, (mtime, path) in enumerate(changed_files(paths, ctx.state, ctx.since), 1):
        for m in parse_file(path):
            key = m["key"]
            if key is not None:
                if key in seen:
                    continue
                seen.add(key)
            if m["ts"] >= ctx.since:
                yield to_row(m, ctx.host)
        mark_read(ctx.state, mtime, path)
        if n % CHECKPOINT_FILES == 0:
            yield CHECKPOINT


def to_row(m: dict, host: str) -> dict:
    t = m["tokens"]
    key = m["key"] or f"nokey:{m['session']}:{m['ordinal']}"
    return row(
        source_key=f"codex:{host}:{key[len('codex:'):] if key.startswith('codex:') else key}",
        call_at=m["ts"], host=host, client=CLIENT, agent=m["agent"], session=m["session"],
        provider=m["provider"], model=_bare(m["model"]),
        input_tokens=t["input"], output_tokens=t["output"] + t["reasoning"], reasoning_tokens=t["reasoning"],
        cache_read_tokens=t["cache_read"], duration_ms=m["duration"] or 0,
    )


def _bare(model: str) -> str:
    """tokscale reports 'anthropic/claude-fable-5' as 'claude-fable-5'."""
    head, sep, tail = model.partition("/")
    return tail if sep and head.lower() in ("anthropic", "openai", "google", "gemini", "xai") and tail else model


def _totals(u: Optional[dict]) -> Optional[tuple]:
    if not isinstance(u, dict):
        return None
    g = lambda k: max(_int(u.get(k)), 0)
    return (g("input_tokens"), g("output_tokens"), max(_int(u.get("cached_input_tokens")), _int(u.get("cache_read_input_tokens")), 0), g("reasoning_output_tokens"))


def _int(v) -> int:
    if isinstance(v, bool) or v is None:
        return 0
    if isinstance(v, (int, float)):
        return int(v)
    return 0


def _has_counters(u) -> bool:
    return isinstance(u, dict) and any(isinstance(u.get(k), (int, float)) and not isinstance(u.get(k), bool) for k in
                                       ("input_tokens", "output_tokens", "cached_input_tokens", "cache_read_input_tokens", "reasoning_output_tokens"))


def _delta(cur: tuple, prev: tuple) -> Optional[tuple]:
    if any(c < p for c, p in zip(cur, prev)):
        return None
    return tuple(c - p for c, p in zip(cur, prev))


def _stale_regression(cur: tuple, prev: tuple, last: tuple) -> bool:
    pt, ct, lt = sum(prev), sum(cur), sum(last)
    if pt <= 0 or ct <= 0 or lt <= 0:
        return False
    return ct * 100 >= pt * 98 or ct + lt * 2 >= pt


def _tokens(t: tuple) -> dict:
    inp, out, cached, reasoning = t
    cached = max(min(cached, inp), 0)
    reasoning = min(max(reasoning, 0), max(out, 0))
    return {"input": max(inp - cached, 0), "output": max(max(out, 0) - reasoning, 0), "cache_read": cached, "reasoning": reasoning}


def _empty(tok: dict) -> bool:
    return not (tok["input"] or tok["output"] or tok["cache_read"] or tok["reasoning"])


def _uuid7_key(s: Optional[str]) -> Optional[str]:
    if not s:
        return None
    parts = s.split("-")
    if len(parts) != 5 or [len(p) for p in parts] != [8, 4, 4, 4, 12] or not parts[2].startswith("7"):
        return None
    if not all(c in "0123456789abcdefABCDEF" for c in "".join(parts)):
        return None
    return "".join(parts).lower()


def _model(p: dict) -> Optional[str]:
    mi = p.get("model_info")
    if isinstance(mi, dict) and isinstance(mi.get("slug"), str) and mi["slug"]:
        return mi["slug"]
    for k in ("model", "model_name"):
        if isinstance(p.get(k), str) and p[k]:
            return p[k]
    return _info_model(p.get("info"))


def _info_model(info) -> Optional[str]:
    if not isinstance(info, dict):
        return None
    for k in ("model", "model_name"):
        if isinstance(info.get(k), str) and info[k]:
            return info[k]
    return None


def _human_turn(message) -> bool:
    if not isinstance(message, str):
        return False
    s = message.lstrip()
    return bool(s) and not any(s.startswith(p) for p in _INJECTED)


def _infer_provider(model: Optional[str]) -> Optional[str]:
    if not model:
        return None
    m = model.lower()
    if m.startswith("claude"):
        return "anthropic"
    if m.startswith("gemini"):
        return "google"
    if m.startswith(("gpt", "o1", "o3", "o4", "codex")):
        return "openai"
    return None


class _State:
    def __init__(self):
        self.current_model = None
        self.turn_start_ms = None
        self.last_accepted_ms = None
        self.previous = None
        self.exec_run = False
        self.subagent = False
        self.guardian = False
        self.session_meta_id = None
        self.forked_from = None
        self.fork_child_id = None
        self.fork_replay_id = None
        self.provider = None
        self.agent = None
        self.fork_waiting = False
        self.fork_baseline = None
        self.fork_baseline_total = None
        self.fork_task_turns = set()
        self.fork_user = False
        self.openclaw = False
        self.current_turn = None
        self.turn_announced = False
        self.ordinal = 0
        self.pending = None
        self.settled = []


def rollout_start_ms(name: str) -> int:
    """The rollout's start time from its name (the thread id is a UUID v7), the same for every copy of it.

    tokscale stamps a usage event that has no timestamp with the file's mtime, which differs between
    sessions/ and archived_sessions/ and changes when Codex appends; a row's call_at must not change.
    """
    stem = name.split(".jsonl")[0]
    k = _uuid7_key(stem[-36:])
    if k:
        return int(k[:12], 16)
    if stem.startswith("rollout-") and len(stem) >= 27:
        try:
            return int(datetime.strptime(stem[8:27], "%Y-%m-%dT%H-%M-%S").replace(tzinfo=timezone.utc).timestamp() * 1000)
        except ValueError:
            pass
    return 0


def parse_file(path: str) -> list:
    """Usage messages of one rollout, as tokscale's parse_codex_file returns them."""
    name = os.path.basename(path)
    session = name.split(".jsonl")[0]
    fallback_ts = rollout_start_ms(name)
    st = _State()
    out = []
    pending_model = []
    decoded = 0
    with read_text(path) as fh:
        for line in fh:
            decoded += len(line)
            if decoded > MAX_DECODED_BYTES and path.endswith(".zst"):
                return []
            if len(line) > MAX_RECORD_BYTES:
                continue
            s = line.strip()
            if not s:
                continue
            try:
                entry = json.loads(s)
            except ValueError:
                continue
            if not isinstance(entry, dict) or not isinstance(entry.get("type"), str):
                continue
            payload = entry.get("payload")
            if not isinstance(payload, dict) or any(payload.get(k) is not None and not isinstance(payload.get(k), str) for k in _STR_FIELDS):
                continue
            _step(st, entry["type"], entry.get("timestamp") if isinstance(entry.get("timestamp"), str) else None,
                  payload, session, fallback_ts, out, pending_model)
    _flush_pending_model(pending_model, out, "unknown")
    thread = session[-36:] if session.startswith("rollout-") and len(session) >= 56 else session
    for m in out:
        m["session"] = thread
    return out


def _new_message(st: _State, model: Optional[str], ts: int, tokens: dict) -> dict:
    agent = AGENT_EXEC if st.exec_run else (st.agent or "")
    provider = st.provider or _infer_provider(model) or "openai"
    return {"model": model or "unknown", "provider": provider, "agent": agent, "ts": ts, "tokens": tokens,
            "duration": None, "key": None, "ordinal": st.ordinal, "openclaw": st.openclaw}


def _emit_record(st: _State, session: str, fallback_ts: int, out: list, pending_model: list):
    rec, st.pending = st.pending, None
    if rec is None:
        return
    tokens = _tokens(rec["usage"])
    if _empty(tokens):
        return
    model = rec["model"] or st.current_model
    ts = rec["ts"] if rec["ts"] is not None else fallback_ts
    m = _new_message(st, model, ts, tokens)
    scope = st.forked_from or st.session_meta_id or session
    u = rec["usage"]
    m["key"] = f"codex:usage-record:{scope}:{rec['response_id']}" if rec["response_id"] else f"codex:usage-record:{scope}:{ts}:{u[0]}:{u[1]}:{u[2]}:{u[3]}"
    if len(st.settled) == SETTLED_LIMIT:
        st.settled.pop(0)
    st.settled.append(rec["usage"])
    if model:
        out.append(m)
    else:
        pending_model.append(m)


def _set_fallback_key(m: dict, model: str):
    rid, t = m["fallback_rid"], m["tokens"]
    m["key"] = f"codex:usage-fallback:{len(rid)}:{rid}:{m['ordinal']}:{len(model)}:{model}:{t['input']}:{t['output']}:{t['cache_read']}:0:0:{t['reasoning']}"


def _flush_pending_model(pending_model: list, out: list, model: str):
    for m in pending_model:
        if m["key"] is None and "fallback_rid" in m:
            _set_fallback_key(m, model)
        m["model"] = model
        out.append(m)
    pending_model.clear()


def _fork_turn_starts_own(st: _State, turn_id: Optional[str]) -> bool:
    if st.fork_replay_id is None or st.fork_child_id is None:
        return True
    child = _uuid7_key(st.fork_child_id)
    if turn_id is None or child is None:
        return True
    tk = _uuid7_key(turn_id)
    if tk is None:
        return st.fork_user or turn_id in st.fork_task_turns
    if tk[:12] > child[:12]:
        return True
    if tk[:12] < child[:12]:
        return False
    return st.fork_user or turn_id in st.fork_task_turns


def _fork_task_starts_own(st: _State, turn_id: Optional[str], started_at) -> bool:
    if turn_id is None or st.fork_child_id is None:
        return False
    child = _uuid7_key(st.fork_child_id)
    if child is None:
        return True
    tk = _uuid7_key(turn_id)
    if tk is not None:
        return tk[:12] >= child[:12]
    if not isinstance(started_at, (int, float)) or isinstance(started_at, bool):
        return False
    return int(started_at) >= int(child[:12], 16) // 1000


def _step(st: _State, etype: str, ts_raw: Optional[str], p: dict, session: str, fallback_ts: int, out: list, pending_model: list):
    ptype = p.get("type")
    if etype == "token_usage_record":
        other = p.get("thread_id") is not None and st.session_meta_id is not None and p["thread_id"] != st.session_meta_id
        if not st.fork_waiting and not other:
            _emit_record(st, session, fallback_ts, out, pending_model)
            u = p.get("usage")
            st.pending = None
            if _has_counters(u):
                st.pending = {"usage": _totals(u), "ts": parse_ts(ts_raw), "turn": p.get("turn_id") or st.current_turn,
                              "response_id": p.get("response_id"), "model": _model(p), "after_compacted": False}
        return

    if not st.fork_waiting:
        if etype == "compacted" and st.pending is not None:
            st.pending["after_compacted"] = True
        starts_other = (etype == "event_msg" and ptype == "task_started") or (
            etype == "turn_context" and st.pending is not None and st.pending["turn"] != p.get("turn_id"))
        ends_pending = (etype == "event_msg" and ptype in ("turn_aborted", "task_complete") and st.pending is not None
                        and (p.get("turn_id") is None or st.pending["turn"] == p.get("turn_id")))
        if starts_other or ends_pending:
            _emit_record(st, session, fallback_ts, out, pending_model)

    if etype == "event_msg" and ptype == "thread_settings_applied" and not st.fork_waiting:
        ts_ = p.get("thread_settings")
        if isinstance(ts_, dict) and isinstance(ts_.get("model_provider_id"), str):
            st.provider = ts_["model_provider_id"]

    payload_model = _model(p)
    is_token_count = etype == "event_msg" and ptype == "token_count"
    info = p.get("info") if isinstance(p.get("info"), dict) else None
    info_model = _info_model(info) if is_token_count else None
    ordinal = None
    if is_token_count:
        ordinal = st.ordinal
        st.ordinal += 1

    if etype == "event_msg" and ptype == "task_started":
        st.current_turn = p.get("turn_id")
        st.turn_announced = st.current_turn is not None
    elif etype == "turn_context":
        if p.get("turn_id") is not None:
            st.current_turn = p["turn_id"]
        elif not st.turn_announced:
            st.current_turn = None
        st.turn_announced = False

    if st.fork_waiting:
        if etype == "turn_context" and _fork_turn_starts_own(st, p.get("turn_id")):
            st.fork_waiting = False
            st.fork_replay_id = None
            st.fork_task_turns.clear()
            st.fork_user = False
            if st.fork_child_id:
                st.session_meta_id = st.fork_child_id
            st.current_model = payload_model
        else:
            if etype == "event_msg" and ptype == "task_started" and _fork_task_starts_own(st, p.get("turn_id"), p.get("started_at")):
                if p.get("turn_id"):
                    st.fork_task_turns.add(p["turn_id"])
            if etype == "session_meta" and p.get("id") and st.fork_child_id and st.fork_child_id != p["id"]:
                st.fork_replay_id = p["id"]
            if is_token_count and info is not None and isinstance(info.get("total_token_usage"), dict):
                tu = info["total_token_usage"]
                st.previous = _totals(tu)
                st.fork_baseline = st.previous
                total = tu.get("total_tokens")
                st.fork_baseline_total = total if isinstance(total, int) and not isinstance(total, bool) and total >= 0 else None
            return

    if etype == "world_state" and st.current_model is None:
        state = p.get("state")
        wm = state.get("model") if isinstance(state, dict) else None
        if isinstance(wm, str) and wm:
            _flush_pending_model(pending_model, out, wm)
            st.current_model = wm

    if pending_model and payload_model is None and info_model is None and not is_token_count and etype != "session_meta":
        _flush_pending_model(pending_model, out, "unknown")

    if etype == "session_meta":
        if p.get("originator") in ("openclaw", "OpenClaw"):
            st.openclaw = True
        if p.get("source") == "exec":
            st.exec_run = True
        if p.get("id"):
            st.session_meta_id = p["id"]
        source = p.get("source")
        forked = p.get("forked_from_id") or None
        if forked is None and isinstance(source, dict):
            spawn = (source.get("subagent") or {}).get("thread_spawn") if isinstance(source.get("subagent"), dict) else None
            if isinstance(spawn, dict) and isinstance(spawn.get("parent_thread_id"), str) and spawn["parent_thread_id"]:
                forked = spawn["parent_thread_id"]
        if forked:
            repeated = not st.fork_waiting and p.get("id") is not None and st.fork_child_id == p.get("id")
            st.forked_from = forked
            st.fork_child_id = p.get("id")
            if not repeated:
                st.fork_waiting = True
                st.fork_replay_id = None
                st.fork_baseline = None
                st.fork_baseline_total = None
                st.fork_task_turns.clear()
                st.fork_user = p.get("thread_source") == "user"
        if p.get("model_provider"):
            st.provider = p["model_provider"]
        sub = source.get("subagent") if isinstance(source, dict) else None
        if p.get("thread_source") == "guardian_review" or (isinstance(sub, dict) and sub.get("other") == "guardian"):
            st.guardian = True
        elif p.get("thread_source") == "subagent" or (isinstance(source, dict) and "subagent" in source):
            st.subagent = True
        st.agent = AGENT_GUARDIAN if st.guardian else AGENT_SUBAGENT if st.subagent else AGENT_DEFAULT

    if etype == "turn_context":
        st.current_model = payload_model
        st.turn_start_ms = parse_ts(ts_raw)
        st.last_accepted_ms = st.turn_start_ms
        if st.current_model:
            _flush_pending_model(pending_model, out, st.current_model)

    if etype == "event_msg" and ptype == "task_started":
        sa = p.get("started_at")
        st.turn_start_ms = int(sa) * 1000 if isinstance(sa, (int, float)) and not isinstance(sa, bool) else parse_ts(ts_raw)
        st.last_accepted_ms = st.turn_start_ms

    if etype == "event_msg" and ptype == "user_message" and _human_turn(p.get("message")):
        st.last_accepted_ms = parse_ts(ts_raw)

    if not is_token_count or info is None:
        return

    model = payload_model or info_model or st.current_model
    if model:
        st.current_model = model
        _flush_pending_model(pending_model, out, model)

    tu, lu = info.get("total_token_usage"), info.get("last_token_usage")
    total = _totals(tu)
    last = _totals(lu)

    if isinstance(tu, dict):
        reported = tu.get("total_tokens")
        if st.fork_baseline_total is not None and isinstance(reported, int) and not isinstance(reported, bool) and 0 <= reported <= st.fork_baseline_total:
            st.pending = None
            return
    if total is not None and st.fork_baseline is not None and all(a <= b for a, b in zip(total, st.fork_baseline)):
        st.pending = None
        return
    st.fork_baseline = None
    st.fork_baseline_total = None

    prev = st.previous
    emitted = None
    if total is not None and last is not None and prev is not None:
        if not (total == prev or (_delta(total, prev) is None and _stale_regression(total, prev, last))):
            emitted = (last, total)
    elif total is not None and last is not None:
        emitted = (last, total)
    elif total is not None and prev is not None:
        if total != prev:
            d = _delta(total, prev)
            if d is not None:
                emitted = (d, total)
            else:
                st.previous = total
    elif total is not None:
        emitted = (total, total)
    elif last is not None and prev is not None:
        emitted = (last, tuple(a + b for a, b in zip(prev, last)))
    elif last is not None:
        emitted = (last, None)
    if emitted is not None and _empty(_tokens(emitted[0])):
        emitted = None

    if emitted is None:
        if st.pending is not None and st.pending["after_compacted"]:
            _emit_record(st, session, fallback_ts, out, pending_model)
        return
    usage, next_totals = emitted
    tokens = _tokens(usage)
    st.previous = next_totals

    same = lambda a, b: a[0] == b[0] and a[1] == b[1]
    if st.pending is not None and same(st.pending["usage"], usage):
        st.pending = None
    else:
        hit = next((i for i, u in enumerate(st.settled) if same(u, usage)), None)
        if hit is not None:
            st.settled.pop(hit)
            return
        if st.pending is not None and st.pending["after_compacted"]:
            _emit_record(st, session, fallback_ts, out, pending_model)
        else:
            st.pending = None

    parsed = parse_ts(ts_raw)
    ts = st.last_accepted_ms if st.last_accepted_ms is not None else (parsed if parsed is not None else fallback_ts)
    duration = (parsed - st.last_accepted_ms) if parsed is not None and st.last_accepted_ms is not None else None
    m = _new_message(st, model, ts, tokens)
    m["duration"] = duration if duration and duration > 0 else None
    m["ordinal"] = ordinal
    st.turn_announced = False
    mdl = model or "unknown"
    if parsed is not None or total is not None:
        scope = st.forked_from or st.session_meta_id or session
        if total is not None:
            m["key"] = f"codex:token_count-total:{scope}:{m['provider']}:{mdl}:{total[0]}:{total[1]}:{total[2]}:{total[3]}"
        else:
            m["key"] = f"codex:token_count:{ts}:{m['provider']}:{mdl}:{tokens['input']}:{tokens['output']}:{tokens['cache_read']}:0:{tokens['reasoning']}"
    else:
        m["fallback_rid"] = st.session_meta_id or session
        if model:
            _set_fallback_key(m, model)
    if parsed is not None and (st.last_accepted_ms is None or parsed > st.last_accepted_ms):
        st.last_accepted_ms = parsed
    if model:
        out.append(m)
    else:
        pending_model.append(m)
