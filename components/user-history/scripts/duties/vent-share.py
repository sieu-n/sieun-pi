#!/usr/bin/env python3
"""Vent share of the in-scope prod outside-call sites, the Vent gateway duty's call-site count.

Moved from the auto-sns-agent session folder sessions/2026/10/18/1949-vent-share-measure/data/vent_share.py so the duty
(vent-gateway.ts) runs tracked code. Reads the 1610 call-site inventory (83 rows at 8bc0fa3615), keeps the 70 rows the cutover
coordinator counted as in scope, and decides for each one, at a git ref, whether the code at that site goes through Vent or still
calls the provider. The call sites at a ref are the rows whose call is still in the code there, since a row whose files are deleted
(removed) or no longer name the provider (gone) has no caller left, plus every direct provider call the call scan finds in deployed
code that no live row covers, so a new direct call counts as a site of its own. With --traffic
it also counts Vent's vent.call log rows per caller and integration in the shared otel ClickHouse, and matches them to sites through
the integrations in apps/vent/src/vent/tables.py, so a new Vent integration needs no edit here.

Run from the auto-sns-agent repo root:
  python3 <this> [--ref origin/sieun/dev] [--ref origin/main] [--traffic] [--json out.json]
Stdlib only. Reads git objects, never the working tree (except the inventory file), so any ref works without a checkout.
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
INVENTORY = Path("apps/llm-wiki/content/sessions/2026/10/18/1610-vent-cutover-all-callers/data/inventory-calls.md")
INVENTORY_REF = "8bc0fa3615"

# The coordinator's in-scope rule (cutover thread 2026-10-18T07:30Z): a row is out of scope
# when its "Vent today" cell says one of these. 83 rows minus 13 leaves 70.
OUT_OF_SCOPE = ["out of scope", "not a provider", "upstream of Vent", "browser call", "keyless", "ops platform"]

# Owner scope (2026-10-18 cutover train): every one of the 70 moves to Vent except the GeoNode
# proxy. Browser-side Clerk may stay direct too, but no row of the 70 is browser-side.
EXCEPTION_ROWS = {
    63: "GeoNode is HTTP CONNECT proxy egress for the crawler fleet, and Vent forwards API calls only",
}
# Alarm paths call Vent first and keep a direct Slack fallback for when Vent is down, so a
# partial verdict (Vent sign plus a direct line) is the target shape for these rows.
FALLBACK_ROWS = {69, 70, 71}
# Rows whose call is no longer in the code at a ref, which leave that ref's call-site list.
GONE = ("removed", "gone")

# Provider signatures. "strong" is a host or key name, which proves a direct call wherever it
# sits. "sdk" is a client import, which proves a direct call only in a file with no Vent sign,
# because stripe-node or openai over Vent keeps the import. The Vent integration each provider's
# traffic lands under comes from tables.py (vent_integrations), not from this table.
P = {
    "zernio": dict(strong=r"zernio\.com|ZERNIO_API_KEY", sdk=r"(?!)"),
    "resend": dict(strong=r"api\.resend\.com|RESEND_API_KEY", sdk=r"@convex-dev/resend|from ['\"]resend['\"]"),
    "slack": dict(strong=r"slack\.com/api|SLACK_BOT_TOKEN\w*", sdk=r"@slack/web-api"),
    "stripe": dict(strong=r"api\.stripe\.com|STRIPE_SECRET_KEY", sdk=r"from ['\"]stripe['\"]|require\(['\"]stripe['\"]\)|\bimport stripe\b"),
    "gmail": dict(strong=r"gmail\.googleapis\.com", sdk=r"(?!)"),
    "google-oauth": dict(strong=r"oauth2\.googleapis\.com|googleapis\.com/oauth2|GOOGLE_\w*CLIENT_SECRET", sdk=r"(?!)"),
    "google-sheets": dict(strong=r"sheets\.googleapis\.com", sdk=r"(?!)"),
    "google-drive": dict(strong=r"googleapis\.com/(drive|upload/drive)|www\.googleapis\.com", sdk=r"(?!)"),
    "gemini": dict(strong=r"generativelanguage\.googleapis\.com|GEMINI_API_KEY|\bgemini_api_key\b", sdk=r"genai\.Client\("),
    "clerk": dict(strong=r"api\.clerk\.com|CLERK_(DEV_)?SECRET_KEY", sdk=r"svelte-clerk|@clerk/backend"),
    "notion": dict(strong=r"api\.notion\.com", sdk=r"(?!)"),
    "telegram": dict(strong=r"api\.telegram\.org|telegramSendMessageUrl", sdk=r"(?!)"),
    "slack-webhook": dict(strong=r"hooks\.slack\.com|fetch\(\s*webhook_?[uU]rl", sdk=r"(?!)"),
    "posthog": dict(strong=r"i\.posthog\.com|(?<!PUBLIC_)POSTHOG_KEY", sdk=r"posthog-node|/capture"),
    "cliproxy": dict(strong=r"CLIPROXY_(BASE_URL|API_KEY)|cliproxy_(base_url|api_key)|cliproxy\.virev|LITELLM_API_KEY", sdk=r"\b(Async)?(OpenAI|Anthropic)\(|\bnew (OpenAI|Anthropic)\b"),
    "openai-paid": dict(strong=r"api\.openai\.com|OPENAI_API_KEY|openai_api_key", sdk=r"\b(Async)?OpenAI\("),
    "elevenlabs": dict(strong=r"elevenlabs\.io|ELEVENLABS_API_KEY|elevenlabs_api_key", sdk=r"(?!)"),
    "aimlapi": dict(strong=r"aimlapi\.com|AIMLAPI_KEY|aimlapi_key", sdk=r"(?!)"),
    "pexels": dict(strong=r"pexels\.com|PEXELS_API_KEY|pexels_api_key", sdk=r"(?!)"),
    "instagram-graph": dict(strong=r"graph\.instagram\.com|rupload\.facebook\.com|graph\.facebook\.com|INSTAGRAM_ACCESS_TOKEN|instagram_access_token", sdk=r"(?!)"),
    "instagram-oauth": dict(strong=r"api\.instagram\.com|graph\.instagram\.com|INSTAGRAM_APP_SECRET", sdk=r"(?!)"),
    "typesafe": dict(strong=r"typesafe\.ai|TYPESAFE_API_KEY|typesafe_api_key", sdk=r"(?!)"),
    "zerobounce": dict(strong=r"zerobounce\.net|ZEROBOUNCE_API_KEY|zerobounce_api_key", sdk=r"(?!)"),
    "geonode": dict(strong=r"geonode\.(io|com)|proxy_url|proxy_endpoints", sdk=r"(?!)"),
    "grafana-slack": dict(strong=r"type:\s*slack|SLACK_BOT_TOKEN\w*|slack\.com/api", sdk=r"(?!)"),
    "seo": dict(strong=r"api\.indexnow\.org|bing\.com/indexnow|searchconsole\.googleapis\.com|googleapis\.com/webmasters/", sdk=r"(?!)"),
}

def provider_of(row: int, name: str) -> str:
    n = name.lower()
    if row == 70:
        return "grafana-slack"
    table = [
        ("slack incoming", "slack-webhook"), ("zernio", "zernio"), ("resend", "resend"), ("slack", "slack"),
        ("stripe", "stripe"), ("gmail", "gmail"), ("google oauth", "google-oauth"), ("google sheets", "google-sheets"),
        ("google drive", "google-drive"), ("gemini", "gemini"), ("clerk", "clerk"), ("notion", "notion"),
        ("telegram", "telegram"), ("posthog", "posthog"), ("cliproxy", "cliproxy"), ("sora", "openai-paid"),
        ("elevenlabs", "elevenlabs"), ("aimlapi", "aimlapi"), ("pexels", "pexels"), ("instagram graph", "instagram-graph"),
        ("instagram oauth", "instagram-oauth"), ("typesafe", "typesafe"), ("zerobounce", "zerobounce"),
        ("geonode", "geonode"), ("indexnow", "seo"),
    ]
    for needle, key in table:
        if needle in n:
            return key
    raise SystemExit(f"row {row}: no provider signature for {name!r}")

# The Vent caller each app logs in as, for the traffic join.
CALLER = {"convex": "convex", "search": "search", "api-portal": "api-portal", "admin": "admin",
          "research-agent-be": "research-agent-be", "crawler-v3": "crawler-v3", "infra obs": "infra-obs",
          "llm-wiki": "specs"}

# A Vent sign: the app's Vent helper, the Vent env names, or the Vent headers.
VENT_RE = re.compile(
    r"\bVENT_(URL|KEY|INTEGRATION)\b|\bvent(Url|Fetch|Request|Auth|Headers|Client)\b|\bvent_(url|auth|headers|client|base)\b"
    r"|\breadVent\b|(?i:x-vent-)|lib/server/vent['\"]|lib/vent['\"]|/vent\.(m?js|ts)['\"]|[-/]vent['\"]|from \.+vent import|from (src\.)?vent import|import vent\b"
    r"|\b_?vent_(post|call|api|credential)\b|\bvent\.call\(|\bVentSession\b|VENT_PROVIDER_TOKEN"
)
COMMENT_RE = re.compile(r"^\s*(//|#|\*|/\*|<!--)")
# stripe-node's fetch client matches the Stripe origin to rewrite it onto Vent (egress guard exception).
# OAuth scope strings name a googleapis URL but make no call.
ALLOW_RE = re.compile(r"\bSTRIPE_ORIGIN\s*=|googleapis\.com/auth/")
# An SDK built with an empty key cannot call its provider (the @convex-dev/resend component).
KEYLESS_RE = re.compile(r"apiKey:\s*(''|\"\")")
# A TypeScript type-only import is erased at build, so it cannot call a provider
# (convex/search/campaigns/scheduler.ts imports the EmailId type from @convex-dev/resend).
TYPE_IMPORT_RE = re.compile(r"^\s*import\s+type\b")


def code_lines(path: str, text: str) -> list[tuple[int, str]]:
    """Numbered lines minus comments and Python docstrings."""
    out, in_doc = [], False
    for n, line in enumerate(text.split("\n"), 1):
        if path.endswith(".py"):
            quotes = line.count('\"\"\"') + line.count("\'\'\'")
            if in_doc or (quotes and line.strip().startswith(('\"\"\"', "\'\'\'", 'r\"\"\"', 'f\"\"\"'))):
                if quotes % 2 == 1:
                    in_doc = not in_doc
                continue
        if COMMENT_RE.match(line):
            continue
        out.append((n, line))
    return out
PATH_RE = re.compile(r"[\w.\-+()\[\]/{},:]+?\.(?:ts|py|mjs|js|svelte|yaml)\b")

# Rows whose call goes through a helper in another file the row text does not name.
EXTRA_FILES = {
    49: ["apps/research-agent-be/src/llm.py"],
    35: ["apps/search/src/hooks.server.ts"],
    71: ["apps/infra/ci-server/alert/config.json.j2"],
}


def git(*args: str, check: bool = True) -> str:
    out = subprocess.run(["git", *args], capture_output=True, text=True)
    if check and out.returncode != 0:
        raise SystemExit(f"git {' '.join(args)}: {out.stderr.strip()}")
    return out.stdout


class Tree:
    """File reads at one git ref, cached."""

    def __init__(self, ref: str):
        self.ref = ref
        self.sha = git("rev-parse", "--short=10", ref).strip()
        self.files = set(git("ls-tree", "-r", "--name-only", ref).splitlines())
        self._cache: dict[str, str | None] = {}

    def read(self, path: str) -> str | None:
        if path not in self._cache:
            self._cache[path] = git("show", f"{self.ref}:{path}", check=False) if path in self.files else None
        return self._cache[path]

    def grep(self, pattern: str, roots: list[str]) -> list[tuple[str, str, str]]:
        """(path, line number, text) of each line under the roots that matches the extended regex."""
        out = git("grep", "-n", "-I", "-E", pattern, self.ref, "--", *roots, check=False)
        return [(parts[1], parts[2], parts[3]) for parts in (line.split(":", 3) for line in out.splitlines()) if len(parts) == 4]


def split_paths(cell: str) -> list[str]:
    cell = cell.replace("\\", "")
    out: list[str] = []
    for m in re.finditer(r"([\w./\-+()\[\]]*)\{([^}]*)\}", cell):
        for part in m.group(2).split(","):
            out.append(m.group(1) + part.split(":")[0].strip())
    cell = re.sub(r"[\w./\-+()\[\]]*\{[^}]*\}", " ", cell)
    for tok in re.findall(r"[\w./\-+()\[\]]+\.(?:ts|py|mjs|js|svelte|yaml)\b", cell):
        out.append(tok)
    return out


def resolve(paths: list[str], base: Tree) -> list[str]:
    """Turn the inventory's short paths into repo paths, using the inventory ref's tree."""
    full = [p for p in paths if p in base.files]
    anchors = [p for p in paths if "/" in p and (p.startswith(("apps/", "convex/", "packages/", "scripts/")))]
    resolved = list(full)
    for p in paths:
        if p in base.files:
            continue
        hit = None
        for a in anchors:
            parts = a.split("/")[:-1]
            while parts and not hit:
                cand = "/".join(parts + [p])
                if cand in base.files:
                    hit = cand
                parts = parts[:-1]
            if hit:
                break
        if hit:
            resolved.append(hit)
    return list(dict.fromkeys(resolved))


@dataclass
class Site:
    row: int
    app: str
    call_site: str
    provider_name: str
    runs_in: str
    provider: str
    files: list[str]
    exception: str | None = None


@dataclass
class Verdict:
    status: str  # vent | direct | partial | removed (no file left) | gone (files left, provider never named) | unclear
    direct: list[str] = field(default_factory=list)
    vent: list[str] = field(default_factory=list)
    missing: list[str] = field(default_factory=list)
    via: int | None = None


def load_sites(base: Tree) -> list[Site]:
    rows = [l for l in INVENTORY.read_text().splitlines() if l.startswith("|")][2:]
    sites = []
    for i, line in enumerate(rows):
        c = [x.strip() for x in line.strip().strip("|").split("|")]
        if any(k in c[6] for k in OUT_OF_SCOPE):
            continue
        files = resolve(split_paths(c[1]), base) + EXTRA_FILES.get(i, [])
        if not files:
            raise SystemExit(f"row {i}: no file resolved from {c[1]!r}")
        sites.append(Site(i, c[0], c[1], c[2], c[5], provider_of(i, c[2]), list(dict.fromkeys(files)), EXCEPTION_ROWS.get(i)))
    return sites


PY_IMPORT_RE = re.compile(r"^\s*from\s+(\.*)([\w.]+)\s+import", re.M)
IMPORT_RE = re.compile(r"""from\s+['"](\$lib/[^'"]+|\.{1,2}/[^'"]+)['"]""")


def imported_files(path: str, text: str, tree: "Tree") -> list[str]:
    """Repo paths of the $lib and relative TS/JS modules a file imports."""
    out = []
    for spec in IMPORT_RE.findall(text):
        if spec.startswith("$lib/"):
            app_src = path.split("/src/")[0] + "/src/lib/"
            stem = app_src + spec[len("$lib/"):]
        else:
            stem = os.path.normpath(os.path.join(os.path.dirname(path), spec))
        for cand in (stem, stem + ".ts", stem + ".js", stem + "/index.ts"):
            if cand in tree.files:
                out.append(cand)
                break
    if path.endswith(".py"):
        for dots, mod in PY_IMPORT_RE.findall(text):
            if dots:
                base = os.path.dirname(path)
                for _ in range(len(dots) - 1):
                    base = os.path.dirname(base)
            elif mod.startswith("src."):
                base, mod = path.split("/src/")[0] + "/src", mod[len("src."):]
            else:
                continue
            stem = os.path.join(base, *mod.split("."))
            for cand in (stem + ".py", stem + "/__init__.py"):
                if cand in tree.files:
                    out.append(cand)
                    break
    return out


def judge(site: Site, tree: Tree, sites: list[Site] | None = None, seen: frozenset[int] = frozenset()) -> Verdict:
    sig = P[site.provider]
    strong, sdk = re.compile(sig["strong"]), re.compile(sig["sdk"])
    v = Verdict("unclear")
    texts = {}
    for path in site.files:
        text = tree.read(path)
        if text is None:
            v.missing.append(path)
            continue
        texts[path] = text
        lines = code_lines(path, text)
        has_vent = any(VENT_RE.search(l) for _, l in lines) or bool(KEYLESS_RE.search(text))
        for n, l in lines:
            if VENT_RE.search(l):
                v.vent.append(f"{path}:{n}")
                continue
            if ALLOW_RE.search(l):
                continue
            if strong.search(l) or (not has_vent and sdk.search(l) and not TYPE_IMPORT_RE.match(l)):
                v.direct.append(f"{path}:{n}: {l.strip()[:140]}")
    # No sign in the site's own files: look into the modules they import, two levels deep, since
    # on 10-20 fd764e4449 moved the Google OAuth code exchange to route -> google-oauth.ts -> google-token.ts.
    frontier, looked = list(texts.items()), set(texts)
    own_names = any(mentions(site.provider, text) for text in texts.values())
    for _ in range(2):
        if v.direct or v.vent:
            break
        nxt = []
        for path, text in frontier:
            for dep in imported_files(path, text, tree):
                if dep in looked:
                    continue
                looked.add(dep)
                dep_text = tree.read(dep) or ""
                nxt.append((dep, dep_text))
                # When the site's own files never name the provider, a helper that never names it either is not the
                # site's call: on 10-21 rows 25-27 (search's Resend forms) read as Vent through form-submissions.ts,
                # whose only Vent call is the slack-sales post.
                if not own_names and not mentions(site.provider, dep_text):
                    continue
                lines = code_lines(dep, dep_text)
                has_vent = any(VENT_RE.search(l) for _, l in lines) or bool(KEYLESS_RE.search(dep_text))
                for n, l in lines:
                    if VENT_RE.search(l):
                        v.vent.append(f"{dep}:{n}")
                    elif not ALLOW_RE.search(l) and (strong.search(l) or (not has_vent and sdk.search(l) and not TYPE_IMPORT_RE.match(l))):
                        v.direct.append(f"{dep}:{n}: {l.strip()[:140]}")
        frontier = nxt
    if len(v.missing) == len(site.files):
        v.status = "removed"
    elif v.direct and v.vent:
        v.status = "vent" if site.row in FALLBACK_ROWS else "partial"
    elif v.direct:
        v.status = "direct"
    elif v.vent:
        v.status = "vent"
    elif sites:
        # No sign in the site's own files: the call sits in a helper another row names, so the
        # site takes that row's verdict when one of its files imports the helper.
        for other in sites:
            if other.row == site.row or other.provider != site.provider or other.row in seen:
                continue
            stems = {Path(f).stem for f in other.files}
            if any(re.search(rf"(import|from)\b.*\b{re.escape(stem)}\b", t) for t in texts.values() for stem in stems):
                inner = judge(other, tree, sites, seen | {site.row})
                if inner.status in ("vent", "direct", "partial"):
                    v.status, v.vent, v.direct = inner.status, inner.vent, inner.direct
                    v.via = other.row
                    break
    if v.status == "unclear" and not any(mentions(site.provider, text) for text in texts.values()):
        v.status = "gone"
    return v


# The provider's name as a word, for the "gone" test: a row whose files still exist but never name the provider lost its call.
NAMES = {"openai-paid": r"openai|sora", "seo": r"indexnow|webmasters|searchconsole", "grafana-slack": r"slack", "slack-webhook": r"slack"}


def mentions(provider: str, text: str) -> bool:
    sig = P[provider]
    word = NAMES.get(provider, provider.split("-")[0])
    return bool(re.search(sig["strong"], text) or re.search(sig["sdk"], text) or re.search(rf"\b({word})", text, re.I))


# Call scan: the direct provider calls in deployed code at a ref that no live inventory row covers, so a new direct call counts as a
# site of its own. A call is a provider API host in any file, the CLIProxy base URL or a provider client built in a code file with
# no Vent sign. A key name alone is no call (provider_keys_outside_vent counts keys), nor is a host in an error message or an input
# placeholder. In a SvelteKit app only server modules count, since SvelteKit keeps private env out of the rest, which runs in the
# browser (the coordinator's "browser call" rows are out of scope).
CODE_ROOTS = re.compile(r"^(convex/|apps/[^/]+/src/|apps/infra/|apps/llm-wiki/specs/lib/|packages/[^/]+/src/)")
SKIP = re.compile(r"(^apps/vent/|^apps/llm-wiki/content/|^apps/virev-demo/|/_generated/|\.test\.|\.spec\.|/tests?/|/test_[^/]*\.py$|\.md$|\.env)")
CODE_FILE = re.compile(r"\.(ts|mts|js|mjs|cjs|py)$")
SVELTE_SERVER = re.compile(r"(/lib/server/|/\+server\.[jt]s$|/\+(page|layout)\.server\.[jt]s$|/hooks\.server\.[jt]s$)")
CALL_HOST = re.compile(
    r"https?://(api\.anthropic\.com|api\.openai\.com|(www\.)?slack\.com/api|hooks\.slack\.com|api\.resend\.com|api\.stripe\.com"
    r"|[a-z0-9.-]*zernio\.com/api|gmail\.googleapis\.com|oauth2\.googleapis\.com|sheets\.googleapis\.com|searchconsole\.googleapis\.com"
    r"|www\.googleapis\.com/(drive|upload/drive|webmasters|oauth2)|generativelanguage\.googleapis\.com|api\.elevenlabs\.io|api\.pexels\.com"
    r"|api\.aimlapi\.com|api\.heygen\.com|graph\.instagram\.com|api\.instagram\.com|graph\.facebook\.com|rupload\.facebook\.com"
    r"|[a-z]*\.?zerobounce\.net|api\.typesafe\.ai|api\.clerk\.com|api\.notion\.com|api\.telegram\.org|[a-z]+\.i\.posthog\.com"
    r"|api\.indexnow\.org|www\.bing\.com/indexnow)"
)
CALL_BASE = re.compile(r"\bCLIPROXY_BASE_URL\b|\bcliproxy_base_url\b")
CALL_CLIENT = re.compile(r"new (Stripe|PostHog|Resend|WebClient|OpenAI|Anthropic)\(|createClerkClient\(|\b(Async)?(OpenAI|Anthropic)\(|genai\.Client\(")
NOT_A_CALL = re.compile(r"\b(throw|badRequest\(|Error\(|placeholder)|^\s*\w+\s*:\s*(str|SecretStr|Optional\b)")
# The provider a client constructor builds; an OpenAI-wire client is CLIProxy's or paid OpenAI's.
CLIENT_PROVIDERS = [(r"new Stripe\(", ("stripe",)), (r"new PostHog\(", ("posthog",)), (r"new Resend\(", ("resend",)),
                    (r"new WebClient\(", ("slack",)), (r"createClerkClient\(", ("clerk",)), (r"genai\.Client\(", ("gemini",)),
                    (r"OpenAI\(", ("cliproxy", "openai-paid")), (r"Anthropic\(", ("cliproxy",))]


def providers_of(text: str) -> tuple[str, ...]:
    for pattern, providers in CLIENT_PROVIDERS:
        if re.search(pattern, text):
            return providers
    return tuple(key for key, sig in P.items() if re.search(sig["strong"], text) or re.search(sig["sdk"], text))[:1] or ("unknown",)


def is_server_code(path: str, svelte_apps: set[str]) -> bool:
    app = path.split("/src/")[0] if path.startswith("apps/") and "/src/" in path else None
    if path.endswith(".svelte"):
        return False
    return app not in svelte_apps or bool(SVELTE_SERVER.search(path))


def call_scan(tree: Tree, sites: list[Site], verdicts: dict[int, Verdict]) -> list[dict]:
    """Direct calls at the ref as (file, provider) sites, minus those a live row covers: a file the row names or reads through an
    import, on a line of the row's provider."""
    svelte_apps = {p[: -len("/svelte.config.js")] for p in tree.files if re.fullmatch(r"apps/[^/]+/svelte\.config\.js", p)}
    covered: dict[str, list[Site]] = {}
    for s in sites:
        if verdicts[s.row].status in GONE:
            continue
        v = verdicts[s.row]
        for path in {*s.files, *(entry.split(":")[0] for entry in v.direct + v.vent)}:
            covered.setdefault(path, []).append(s)
    found: dict[tuple[str, str], list[str]] = {}
    for path, n, text in tree.grep("|".join(p.pattern for p in (CALL_HOST, CALL_BASE, CALL_CLIENT)), ["convex", "apps", "packages"]):
        if not CODE_ROOTS.match(path) or SKIP.search(path) or COMMENT_RE.match(text) or not is_server_code(path, svelte_apps):
            continue
        if VENT_RE.search(text) or ALLOW_RE.search(text) or NOT_A_CALL.search(text):
            continue
        host = CALL_HOST.search(text)
        if not host and not CODE_FILE.search(path):
            continue
        if not host and not CALL_BASE.search(text):
            whole = tree.read(path) or ""
            if any(VENT_RE.search(l) for _, l in code_lines(path, whole)) or KEYLESS_RE.search(whole):
                continue
        providers = providers_of(text)
        rows = covered.get(path, [])
        if any(s.provider in providers or re.search(P[s.provider]["strong"], text) or re.search(P[s.provider]["sdk"], text) for s in rows):
            continue
        found.setdefault((path, providers[0]), []).append(f"{path}:{n}: {text.strip()[:140]}")
    return [{"path": path, "app": app_of(path), "provider": provider, "direct": lines} for (path, provider), lines in sorted(found.items())]


def app_of(path: str) -> str:
    parts = path.split("/")
    return parts[1] if parts[0] in ("apps", "packages") and len(parts) > 1 else parts[0]


def traffic_sql(day: int) -> str:
    """vent.call rows of one day back from now: day 0 is the last 24 h, day 1 the 24 h before it. They come from otel.vent_calls
    (auto-sns-agent ops/schema/vent-calls.sql), the view of Vent's own records that the Vent boards and alert rules read, and calls
    sum vent.count, since one tallied record stands for vent.count calls. On 10-23 the same day on otel_logs hit Grafana's 60 s
    deadline for days 3 and 4 (60.2 s and 60.3 s, through_vent_pct read -1 from 03:44Z), while otel.vent_calls answered each day
    in 0.2 to 1.0 s."""
    window = f"Timestamp > now() - INTERVAL {day + 1} DAY" + (f" AND Timestamp <= now() - INTERVAL {day} DAY" if day else "")
    return (
        "SELECT ResourceAttributes['deployment.environment.name'] AS env, `vent.caller` AS caller, "
        "`vent.integration` AS integration, `vent.operation` AS operation, "
        "`vent.outcome` AS outcome, sum(greatest(toUInt64OrZero(`vent.count`), 1)) AS calls, max(Timestamp) AS last "
        f"FROM otel.vent_calls WHERE ServiceName = 'vent' AND Body = 'vent.call' AND {window} "
        "GROUP BY env, caller, integration, operation, outcome ORDER BY env, calls DESC"
    )


TRAFFIC_KEY = ("env", "caller", "integration", "operation", "outcome")


def merge_traffic(days_rows: list[list[dict]]) -> list[dict]:
    """One row per env, caller, integration, operation and outcome across the day queries: calls summed, last the newest."""
    merged: dict[tuple, dict] = {}
    for rows in days_rows:
        for row in rows:
            key = tuple(row.get(k) for k in TRAFFIC_KEY)
            seen = merged.get(key)
            if seen is None:
                merged[key] = dict(row)
                continue
            seen["calls"] = (seen.get("calls") or 0) + (row.get("calls") or 0)
            if row.get("last") is not None and (seen.get("last") is None or row["last"] > seen["last"]):
                seen["last"] = row["last"]
    return sorted(merged.values(), key=lambda r: (str(r.get("env")), -(r.get("calls") or 0)))


def traffic(days: int) -> list[dict]:
    """vent.call rows per env, caller and integration from the shared otel ClickHouse via Grafana, one query per day. On 10-22 the one
    7-day query took 60.2 s and hit Grafana's 60 s datasource deadline (HTTP 400 around a 504 "context deadline exceeded"), while one
    day took 5.0 s, so each day is its own query and the rows merge."""
    token = os.environ.get("GRAFANA_AGENT_TOKEN") or subprocess.run(
        ["npx", "--no-install", "dotenvx", "get", "GRAFANA_AGENT_TOKEN", "-f", ".env"],
        cwd="apps/infra", capture_output=True, text=True).stdout.strip()
    return merge_traffic([traffic_day(token, day) for day in range(days)])


def traffic_day(token: str, day: int) -> list[dict]:
    body = {"queries": [{"refId": "A", "datasource": {"uid": "grafana_clickhouse", "type": "grafana-clickhouse-datasource"},
                         "rawSql": traffic_sql(day), "format": 1, "queryType": "sql"}], "from": f"now-{day + 1}d", "to": f"now-{day}d" if day else "now"}
    req = urllib.request.Request("https://obs.virev.ai/api/ds/query", data=json.dumps(body).encode(),
                                 headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"})
    try:
        res = json.load(urllib.request.urlopen(req))["results"]["A"]
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Grafana answered {error.code} for vent.call day {day}: {error.read().decode(errors='replace')[:400]}") from error
    frames = res.get("frames") or []
    if not frames:
        return []
    names = [f["name"] for f in frames[0]["schema"]["fields"]]
    return [dict(zip(names, r)) for r in zip(*frames[0]["data"]["values"])]


TABLES = "apps/vent/src/vent/tables.py"


def tables_ref() -> str | None:
    """The ref whose tables.py says what Vent serves: main, then sieun/dev, then the newest ci/ branch that has the file."""
    newest_ci = git("for-each-ref", "--sort=-committerdate", "--format=%(refname:short)", "refs/remotes/origin/ci").split()
    for ref in ["origin/main", "origin/sieun/dev", *newest_ci]:
        if subprocess.run(["git", "cat-file", "-e", f"{ref}:{TABLES}"], capture_output=True).returncode == 0:
            return ref
    return None


def vent_integrations(source: str) -> dict[str, str]:
    """INTEGRATIONS in tables.py: each integration name and the secret env name Vent reads for it."""
    out: dict[str, str] = {}
    for node in ast.walk(ast.parse(source)):
        target = node.target if isinstance(node, ast.AnnAssign) else (node.targets[0] if isinstance(node, ast.Assign) else None)
        if not (isinstance(target, ast.Name) and target.id == "INTEGRATIONS" and isinstance(node.value, ast.Dict)):
            continue
        for key, call in zip(node.value.keys, node.value.values):
            if not (isinstance(key, ast.Constant) and isinstance(call, ast.Call)):
                continue
            secret = next((k.value.value for k in call.keywords if k.arg == "secret_env" and isinstance(k.value, ast.Constant)), None)
            if secret is None and len(call.args) > 1 and isinstance(call.args[1], ast.Constant):
                secret = call.args[1].value
            out[key.value] = secret or ""
    return out


def integrations_for(provider: str, integrations: dict[str, str]) -> set[str]:
    """The Vent integrations a provider's calls land under: those named after it (stripe, slack-dev for slack), plus those whose
    secret is one of the provider's key names, unless that integration is named after another provider (gmail shares Google's
    client secret)."""
    strong = re.compile(P[provider]["strong"])
    named = {n for n in integrations if n == provider or n.startswith(provider + "-")}
    keyed = {n for n, secret in integrations.items() if secret and strong.search(secret)
             and not any(n == other or n.startswith(other + "-") for other in P if other != provider)}
    return named | keyed


def site_has_traffic(site: Site, rows: list[dict], env: str, integrations: dict[str, str]) -> bool:
    caller = CALLER.get(site.app)
    names = integrations_for(site.provider, integrations)
    if not caller or not names:
        return False
    return any(r["env"] == env and r["caller"] == caller and (r["integration"] or "") in names and r["outcome"] == "success" for r in rows)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", action="append", help="git ref to measure (repeatable); default origin/sieun/dev")
    ap.add_argument("--traffic", action="store_true", help="also read Vent's vent.call rows from otel ClickHouse")
    ap.add_argument("--days", type=int, default=7)
    ap.add_argument("--json", help="write the full result here")
    a = ap.parse_args()
    refs = a.ref or ["origin/sieun/dev"]
    base = Tree(INVENTORY_REF)
    sites = load_sites(base)
    assert len(sites) == 70, f"expected 70 in-scope rows, got {len(sites)}"
    result: dict = {"inventory_ref": INVENTORY_REF, "refs": {}}
    for ref in refs:
        tree = Tree(ref)
        verdicts = {s.row: judge(s, tree, sites) for s in sites}
        live = [s for s in sites if verdicts[s.row].status not in GONE and not s.exception]
        new_sites = call_scan(tree, sites, verdicts)
        vent = [s for s in live if verdicts[s.row].status == "vent"]
        res = {
            "sha": tree.sha,
            "share": f"{len(vent)}/{len(live) + len(new_sites)}",
            "counts": {k: sum(1 for v in verdicts.values() if v.status == k) for k in ["vent", "partial", "direct", "removed", "gone", "unclear"]},
            "sites": [{"row": s.row, "app": s.app, "provider": s.provider_name, "files": s.files, "exception": s.exception,
                       "runs_in": s.runs_in, **verdicts[s.row].__dict__} for s in sites],
            "new_sites": new_sites,
        }
        result["refs"][ref] = res
        print(f"\n== {ref} ({tree.sha}): Vent share {res['share']} call sites (inventory rows whose call is still there, plus new direct"
              " calls; row 63 GeoNode is the one allowed direct site)")
        print("   " + ", ".join(f"{k} {n}" for k, n in res["counts"].items()))
        by_app: dict[str, list[str]] = {}
        for s in sites:
            v = verdicts[s.row]
            if v.status != "vent":
                tag = f"#{s.row} {s.provider_name}" + (" (exception)" if s.exception else "") + ("" if v.status == "direct" else f" [{v.status}]")
                by_app.setdefault(s.app, []).append(tag)
        for app, tags in by_app.items():
            print(f"   {app} not on Vent ({len(tags)}): " + "; ".join(tags))
        for site in new_sites:
            print(f"   new direct call, {site['app']} {site['provider']}: {site['direct'][0]}")
    if a.traffic:
        rows = traffic(a.days)
        ref = tables_ref()
        integrations = vent_integrations(git("show", f"{ref}:{TABLES}")) if ref else {}
        result["traffic"] = {"days": a.days, "rows": rows, "tables_ref": ref, "integrations": sorted(integrations),
                             "providers_without_integration": sorted({p for p in P if not integrations_for(p, integrations)})}
        print(f"\n== Vent integrations from {ref or 'no ref'}: {len(integrations)}; providers with none: {', '.join(result['traffic']['providers_without_integration'])}")
        for env in ["production", "staging"]:
            live = [s.row for s in sites if site_has_traffic(s, rows, env, integrations)]
            result["traffic"][env] = {"sites_with_vent_traffic": live, "share": f"{len(live)}/{len(sites)}",
                                      "calls": sum(int(r["calls"]) for r in rows if r["env"] == env)}
            print(f"\n== traffic {env}, last {a.days} d: {result['traffic'][env]['calls']} vent.call rows; sites with successful Vent calls {result['traffic'][env]['share']}")
        for r in rows:
            print(f"   {r['env']} {r['caller']} {r['integration'] or '-'} {r['operation'] or '-'} {r['outcome']} {r['calls']}")
    if a.json:
        Path(a.json).write_text(json.dumps(result, indent=1, default=str))


if __name__ == "__main__":
    main()
