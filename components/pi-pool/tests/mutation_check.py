"""Take each scheduler rule out of a copy of components/pi-pool and list the
tests in tests/test_scheduler.py that then fail. Exits non-zero when a rule has
no failing test.

    /usr/bin/python3 -B components/pi-pool/tests/mutation_check.py
"""
import json, re, shutil, subprocess, sys, tempfile
from pathlib import Path

MUTATIONS = {
    "R1 stay": ("    if cur_why is None and cur is not None and not tree.wait and tree.leave != cur.id:",
                "    if cur_why is None and cur is not None and not tree.wait and tree.leave != cur.id and admit_reason(cur, cooldowns, cfg, now, p) is None:"),
    "R2 admit cap": ("    if a.session_pct >= admit_cap(cfg, priority) or week_pct(a) >= cfg[\"seven_day_max_pct\"]:\n        return \"depleted\"\n    if registry.usage_unsampled",
                     "    if False:\n        return \"depleted\"\n    if registry.usage_unsampled"),
    "R2 projection": ("        if why is None and projected_pct(a, book, cfg, now) >= admit_cap(cfg, p):",
                      "        if False:"),
    "R2 own rate": ("    rate = book.rates.get(a.id) or by_tier(a, cfg[\"tree_5h_pct_per_min\"], 0)",
                    "    rate = by_tier(a, cfg[\"tree_5h_pct_per_min\"], 0)"),
    "R3 score": ("    return pace * headroom * tier_units(a, cfg) / trees", "    return 1.0"),
    "R4 slots": ("        if not cell_taken(a, c, tree, rank, book, cfg):\n            return max(t0, c * sp)",
                 "        return max(t0, c * sp)"),
    "R5 wait, not a hop onto a depleted account": (
        "    candidates = [a for a in ranked if allowed(a)]",
        "    candidates = [a for a in ranked if allowed(a)] + sorted([a for a in accounts if allowed(a) and a not in ranked and serve_reason(a, cooldowns, now) is None], key=lambda a: a.session_pct)"),
    "R6 move budget": ("    stuck = own_ok and moved >= budget and (p != \"high\" or optional)", "    stuck = False"),
    "R6 wait cap": ("    if stuck and admissible_at(cur, cooldowns, cfg, now, p) - now > cfg[\"budget_wait_max_sec\"]:",
                    "    if False:"),
    "R7 low cap": ("    return cfg[\"low_admit_5h_max_pct\"] if priority == \"low\" else cfg[\"admit_5h_max_pct\"]",
                   "    return cfg[\"admit_5h_max_pct\"]"),
    "R7 high goes first": ("    return (PRIORITY_RANK.get(tree.priority, 1), tree.wait[2] if tree.wait else now, tree.key or \"\")",
                           "    return (1, tree.wait[2] if tree.wait else now, tree.key or \"\")"),
    "R7 last cell for high": ("        if sole and cap > 1 and tree.priority != \"high\" and c % cap == cap - 1:\n            continue\n", ""),
    "pin applies once": ("    pending = tree.pin and tree.pin != tree.current and tree.pin_at > tree.current_at",
                         "    pending = tree.pin and tree.pin != tree.current"),
    "jobs: a child session keys by its root": ("    key = uuid or active\n", "    key = active or uuid\n"),
    "stale pins dropped": ("                if (not pin or str(pin.get(\"by\") or \"\").startswith(\"recovery:\")\n                        or now - (pin.get(\"at\") or 0) > pin_ttl):",
                           "                if not pin:"),
}
# The file each rule lives in; every other rule is in pool/sched.py.
RULE_FILES = {"jobs: a child session keys by its root": "pool/registry.py", "stale pins dropped": "pool/registry.py"}


def main():
    component = Path(__file__).resolve().parent.parent
    out = {}
    for rule, (old, new) in {"none (must pass)": ("", ""), **MUTATIONS}.items():
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "pi-pool"
            shutil.copytree(component, copy, ignore=shutil.ignore_patterns("__pycache__"))
            target = copy / RULE_FILES.get(rule, "pool/sched.py")
            source = target.read_text()
            if old:
                assert source.count(old) == 1, rule
                target.write_text(source.replace(old, new))
            run = subprocess.run(["/usr/bin/python3", "-B", "-m", "unittest", "test_scheduler"], cwd=copy / "tests",
                                 capture_output=True, text=True, timeout=300)
            failed = sorted(set(re.findall(r"^(?:FAIL|ERROR): (\w+) \(test_scheduler\.(\w+)\)", run.stderr, re.M)))
            out[rule] = [f"{cls}.{name}" for name, cls in failed]
    print(json.dumps(out, indent=1))
    if out.pop("none (must pass)"):
        sys.exit("test_scheduler fails with no rule taken out")
    missing = [rule for rule, failed in out.items() if not failed]
    if missing:
        sys.exit(f"no test fails without: {missing}")


if __name__ == "__main__":
    main()
