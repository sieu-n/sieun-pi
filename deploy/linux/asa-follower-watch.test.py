#!/usr/bin/python3
"""Tests decide() in asa-follower-watch.py. Run: python3 -B deploy/linux/asa-follower-watch.test.py"""
import importlib.util, os

spec = importlib.util.spec_from_file_location("afw", os.path.join(os.path.dirname(os.path.abspath(__file__)), "asa-follower-watch.py"))
afw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(afw)
afw.git = lambda *a: type("P", (), {"stdout": "7\n"})()

T, A = "a" * 40, "b" * 40
ok = {"head": A, "loaded": True, "plist": True, "script": True, "last_line": "", "runs": []}
cases = 0


def check(name, got, want):
    global cases
    cases += 1
    assert got == want, f"{name}: got {got!r}, want {want!r}"


s, acts = afw.decide({}, dict(ok, head=T), T, 1000)
check("at the tip", (s, acts), ({}, []))

s, acts = afw.decide({}, ok, T, 1000)
check("first behind run records since", (s, acts), ({"head": A, "since": 1000}, []))

s, acts = afw.decide({"head": A, "since": 1000}, ok, T, 1000 + afw.HEAL_S)
check("still at the same HEAD after HEAL_S starts a run", [a[0] for a in acts], ["run"])

s2, acts = afw.decide(s, ok, T, 1000 + afw.HEAL_S + 60)
check("no second run within HEAL_S of the last", acts, [])

s, acts = afw.decide({"head": A, "since": 1000}, dict(ok, runs=["12:30"]), T, 1000 + afw.ALERT_S)
check("a run in progress gets no second run, and the alert fires", [a[0] for a in acts], ["alert"])
check("the alert names the long run", "A sync run has been going for 12:30" in acts[0][1], True)
check("alert recorded", s.get("alerted"), True)

s, acts = afw.decide(s, dict(ok, runs=["20:00"]), T, 1000 + afw.ALERT_S + 300)
check("one alert per episode", acts, [])

s, acts = afw.decide({"head": "c" * 40, "since": 0}, ok, T, 5000)
check("a moved HEAD resets since", (s["since"], acts), (5000, []))

s, acts = afw.decide({}, dict(ok, loaded=False), T, 1000)
check("a missing launchd job is loaded at once", [a[0] for a in acts], ["load"])

s, acts = afw.decide({"head": A, "since": 1000}, dict(ok, loaded=False, plist=False), T, 1000 + afw.ALERT_S)
check("no plist: alert only", [a[0] for a in acts], ["run", "alert"])
check("alert says the plist is missing", "plist is missing" in acts[1][1], True)

s, acts = afw.decide({"head": A, "since": 1000}, dict(ok, last_line="fatal: Operation not permitted"), T, 1000 + afw.ALERT_S)
check("privacy refusal is named and healed", ([a[0] for a in acts], "refuses the launchd run" in acts[1][1], "started a sync run over ssh" in acts[1][1]), (["run", "alert"], True, True))

s, acts = afw.decide({"head": A, "since": 1000}, {"error": "ssh exit 255"}, T, 1000 + afw.ALERT_S)
check("ssh failure alerts and keeps since", ([a[0] for a in acts], s["since"], s["head"]), (["alert"], 1000, A))

s, acts = afw.decide({"head": A, "since": 1000, "alerted": True}, dict(ok, head=T), T, 9000)
check("recovery clears state and says so", (s, [a[0] for a in acts]), ({}, ["recovered"]))

print(f"PASS {cases} of {cases}")
