"""Take each scheduler rule out of a copy of packages/pi-pool and list the
tests in test/test_scheduler.py that then fail. Exits non-zero when a rule has
no failing test.

    /usr/bin/python3 -B packages/pi-pool/test/mutation_check.py
"""
import json, re, shutil, subprocess, sys, tempfile
from pathlib import Path

MUTATIONS = {
    "R1 stay": ("    if cur_why is None and cur is not None and not tree.wait and (manual or tree.leave != cur.id):",
                "    if cur_why is None and cur is not None and not tree.wait and (manual or tree.leave != cur.id) and admit_reason(cur, cooldowns, cfg, now, p) is None:"),
    "R2 admit cap": ("    if a.session_pct >= admit_cap(cfg, priority) or week_pct(a) >= cfg[\"seven_day_max_pct\"]:\n        return \"depleted\"\n    if registry.usage_unsampled",
                     "    if False:\n        return \"depleted\"\n    if registry.usage_unsampled"),
    "R3 score": ("    return pace * headroom * tier_units(a, cfg) / trees", "    return 1.0"),
    "R4 slots": ("        if not cell_taken(a, c, tree, rank, book, cfg):\n            return max(t0, c * sp)",
                 "        return max(t0, c * sp)"),
    "R5 wait, not a hop onto a depleted account": (
        "    candidates = [a for a in ranked if allowed(a)]",
        "    candidates = [a for a in ranked if allowed(a)] + sorted([a for a in accounts if allowed(a) and a not in ranked and serve_reason(a, cooldowns, now) is None], key=lambda a: a.session_pct)"),
    "R5 wait ends at the real reset": (
        "            at = max(at, window_reset_at(w))",
        "            at = max(at, window_reset_at(w) + 3600)"),
    "R5 own account wins a tie": (
        "        options.append((t, a.id != tree.current, -score(a, cfg, t, p, load), a.label, a))",
        "        options.append((t, False, -score(a, cfg, t, p, load), a.label, a))"),
    "R6 move budget": ("    stuck = own_ok and moved >= budget and (p != \"high\" or optional)", "    stuck = False"),
    "R6 wait cap": ("    if stuck and (now >= deadline or admissible_at(cur, cooldowns, cfg, now, p) > deadline):",
                    "    if False:"),
    "R7 low cap": ("    return cfg[\"low_admit_5h_max_pct\"] if priority == \"low\" else cfg[\"admit_5h_max_pct\"]",
                   "    return cfg[\"admit_5h_max_pct\"]"),
    "R7 high goes first": ("    return (PRIORITY_RANK.get(tree.priority, 1), tree.wait[2] if tree.wait else now, tree.key or \"\")",
                           "    return (1, tree.wait[2] if tree.wait else now, tree.key or \"\")"),
    "R7 last cell for high": ("        if sole and cap > 1 and tree.priority != \"high\" and c % cap == cap - 1:\n            continue\n", ""),
    "session pin is strict": ("    manual = tree.pin or tree.pool_pin",
                               "    manual = tree.pool_pin"),
    "jobs: a child session keys by its root": ("    key = uuid or active\n", "    key = active or uuid\n"),
    "old pins retained": ('    raw.setdefault("sessions", {})',
                          '    for rec in raw.setdefault("sessions", {}).values():\n        rec["pins"] = {}'),
}
# The file each rule lives in; every other rule is in pool/sched.py.
RULE_FILES = {"jobs: a child session keys by its root": "pool/registry.py", "old pins retained": "pool/registry.py"}


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
            run = subprocess.run(["/usr/bin/python3", "-B", "-m", "unittest", "test_scheduler"], cwd=copy / "test",
                                 capture_output=True, text=True, timeout=300)
            failed = sorted(set(re.findall(r"^(?:FAIL|ERROR): (\w+) \(test_scheduler\.(\w+)(?:\.\w+)?\)", run.stderr, re.M)))
            out[rule] = [f"{cls}.{name}" for name, cls in failed]
    print(json.dumps(out, indent=1))
    if out.pop("none (must pass)"):
        sys.exit("test_scheduler fails with no rule taken out")
    missing = [rule for rule, failed in out.items() if not failed]
    if missing:
        sys.exit(f"no test fails without: {missing}")


if __name__ == "__main__":
    main()
