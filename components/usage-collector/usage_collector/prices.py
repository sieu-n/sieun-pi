"""One cache-aware price table for clients that record no cost.

prices.json holds Prime's own model list (pi-ai, what Prime prices its calls
with) and a LiteLLM subset for models pi-ai lacks. build_prices.py writes it.
Costs follow pi-ai's calculateCost: each token kind times its per-million
price, and for Anthropic models with standard cache pricing a 1 h cache write
costs 2x input while a 5 min write costs 1.25x (pi-ai cache-pricing.ts).
"""

import json
import re
from functools import lru_cache
from pathlib import Path

_TABLE = json.loads(Path(__file__).with_name("prices.json").read_text())
VERSION = _TABLE["version"]
SOURCE = f"priced:{VERSION}"
UNPRICED = f"unpriced:{VERSION}"

# pi-ai lists one model under many routers; a bare model id takes the vendor's own price first,
# then LiteLLM's list price, and a router's resold price (opencode sells gpt-5-codex at 1.07, not 1.25) last.
_VENDORS = ("anthropic", "openai", "openai-codex", "google", "xai", "deepseek", "mistral", "moonshotai", "zai", "minimax")
_ROUTERS = ("amazon-bedrock", "google-vertex", "azure-openai-responses", "github-copilot", "openrouter", "vercel-ai-gateway", "opencode")
_PROVIDER_ALIASES = {"claude": "anthropic", "claude-code": "anthropic", "codex": "openai", "gemini": "google", "chatgpt": "openai"}
_DATE = re.compile(r"-(20\d{6}|\d{4}-\d{2}-\d{2})$")


def _candidates(model: str) -> list[str]:
    m = model.strip()
    out = [m]
    if "/" in m:
        out.append(m.rsplit("/", 1)[1])
    for c in list(out):
        base = re.sub(r"(\[[^\]]*\]|\([^)]*\))$", "", c)
        out.append(base)
        out.append(_DATE.sub("", base))
        out.append(base.lower())
    seen = []
    for c in out:
        if c and c not in seen:
            seen.append(c)
    return seen


def _pi_ai(model: str, providers):
    pi = _TABLE["pi_ai"]
    for p in providers:
        hit = pi.get(f"{p}/{model}")
        if hit:
            return p, hit
    return None


@lru_cache(maxsize=4096)
def lookup(model: str, provider: str = ""):
    """(input, output, cache_read, cache_write_5m, cache_write_1h, where) per million tokens, or None."""
    provider = _PROVIDER_ALIASES.get(provider.lower(), provider.lower()) if provider else ""
    first = ([provider] if provider else []) + [p for p in _VENDORS if p != provider]
    for c in _candidates(model):
        hit = _pi_ai(c, first)
        if hit:
            p, (inp, out, cr, cw) = hit
            return (inp, out, cr, cw, _one_hour(c, inp, cw, 0), f"pi-ai {p}/{c}")
    lit = _TABLE["litellm"]
    for c in _candidates(model):
        for key in (c, f"{provider}/{c}" if provider else "", f"anthropic.{c}-v1:0", f"anthropic.{c}"):
            hit = lit.get(key) if key else None
            if hit:
                inp, out, cr, cw, cw1h = hit
                return (inp, out, cr, cw, _one_hour(c, inp, cw, cw1h), f"litellm {key}")
    routers = [p for p in _ROUTERS if p not in first]
    for c in _candidates(model):
        hit = _pi_ai(c, routers)
        if hit:
            p, (inp, out, cr, cw) = hit
            return (inp, out, cr, cw, _one_hour(c, inp, cw, 0), f"pi-ai {p}/{c}")
    return None


def _one_hour(model: str, inp: float, cw: float, listed: float) -> float:
    if listed:
        return listed
    standard_anthropic = model.lower().startswith("claude") and abs(cw - inp * 1.25) <= 1e-9 * max(1, cw)
    return inp * 2 if standard_anthropic else cw


def cost(model: str, provider: str, input_tokens: int, output_tokens: int, cache_read_tokens: int, cache_write_tokens: int, cache_write_1h_tokens: int = 0) -> dict:
    """The four cost columns and cost_source for one call; output_tokens includes reasoning."""
    price = lookup(model or "", provider or "")
    if price is None:
        return {"cost_input_usd": 0.0, "cost_output_usd": 0.0, "cost_cache_read_usd": 0.0, "cost_cache_write_usd": 0.0, "cost_source": UNPRICED}
    inp, out, cr, cw, cw1h, _ = price
    one_hour = min(max(cache_write_1h_tokens, 0), cache_write_tokens)
    return {
        "cost_input_usd": inp * input_tokens / 1e6,
        "cost_output_usd": out * output_tokens / 1e6,
        "cost_cache_read_usd": cr * cache_read_tokens / 1e6,
        "cost_cache_write_usd": (cw * (cache_write_tokens - one_hour) + cw1h * one_hour) / 1e6,
        "cost_source": SOURCE,
    }
