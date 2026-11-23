"""Write usage_collector/prices.json from Prime's bundled model list and LiteLLM.

Run: python3 -m usage_collector.build_prices [--prime-models PATH] [--litellm PATH_OR_URL]

Prime prices every call it records with its models.bundled.json (pi-ai's model
list), so a call priced here costs the same as a Prime-recorded call of the same
model. LiteLLM, the table tokscale uses first, covers models pi-ai lacks.
"""

import argparse
import glob
import hashlib
import json
import os
import urllib.request
from pathlib import Path

LITELLM_URL = "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json"
LITELLM_COMMITS = "https://api.github.com/repos/BerriAI/litellm/commits?path=model_prices_and_context_window.json&per_page=1"
LITELLM_PREFIXES = ("openai", "anthropic", "gemini", "xai", "deepseek", "mistral", "openrouter")
OUT = Path(__file__).with_name("prices.json")


def newest_prime_models() -> str:
    for root in ("~/.local/share/prime-agent/releases", "~/Library/Application Support/prime-agent/releases"):
        found = sorted(glob.glob(os.path.expanduser(f"{root}/*/models.bundled.json")), key=os.path.getmtime)
        if found:
            return found[-1]
    raise SystemExit("no Prime release with models.bundled.json found; pass --prime-models")


def read_bytes(src: str) -> bytes:
    if src.startswith("http"):
        with urllib.request.urlopen(src, timeout=60) as r:
            return r.read()
    return Path(src).read_bytes()


def litellm_sha() -> str:
    try:
        with urllib.request.urlopen(LITELLM_COMMITS, timeout=30) as r:
            return json.load(r)[0]["sha"][:8]
    except Exception:
        return ""


def per_million(v) -> float:
    return round(float(v or 0) * 1e6, 6)


def build(prime_models: str, litellm_src: str) -> dict:
    prime_raw = Path(prime_models).read_bytes()
    pi_ai = {}
    for m in json.loads(prime_raw)["models"]:
        c = m.get("cost") or {}
        pi_ai[f"{m['provider']}/{m['id']}"] = [c.get("input", 0), c.get("output", 0), c.get("cacheRead", 0), c.get("cacheWrite", 0)]
    lit_raw = read_bytes(litellm_src)
    litellm = {}
    for k, v in json.loads(lit_raw).items():
        if not isinstance(v, dict) or "input_cost_per_token" not in v or v.get("mode") not in ("chat", "responses", "completion"):
            continue
        if "/" in k and k.split("/")[0] not in LITELLM_PREFIXES:
            continue
        litellm[k] = [
            per_million(v.get("input_cost_per_token")),
            per_million(v.get("output_cost_per_token")),
            per_million(v.get("cache_read_input_token_cost")),
            per_million(v.get("cache_creation_input_token_cost")),
            per_million(v.get("cache_creation_input_token_cost_above_1hr")),
        ]
    lit_tag = litellm_sha() if litellm_src.startswith("http") else ""
    lit_tag = lit_tag or hashlib.sha256(lit_raw).hexdigest()[:8]
    version = f"pi-ai.{hashlib.sha256(prime_raw).hexdigest()[:8]}+litellm.{lit_tag}"
    return {"version": version, "prime_models": Path(prime_models).parent.name, "pi_ai": pi_ai, "litellm": litellm}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prime-models", default=None)
    ap.add_argument("--litellm", default=LITELLM_URL)
    a = ap.parse_args()
    table = build(a.prime_models or newest_prime_models(), a.litellm)
    OUT.write_text(json.dumps(table, sort_keys=True, separators=(",", ":")) + "\n")
    print(f"{OUT}: {table['version']}, {len(table['pi_ai'])} pi-ai and {len(table['litellm'])} LiteLLM models")


if __name__ == "__main__":
    main()
