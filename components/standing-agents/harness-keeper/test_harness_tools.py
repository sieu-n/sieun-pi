"""Fixtures for harness_check.py and harness_edit.py against Prime's own harness module.

Run: python3 test_harness_tools.py [<prime-agent-runtime/src>]. Nothing touches the real store:
both checks run on a temp store and a temp git repo.
"""
import glob
import json
import os
import subprocess
import sys
import tempfile
import types

HERE = os.path.dirname(os.path.abspath(__file__))
RUNTIME = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.dirname(os.path.realpath(
    glob.glob(os.path.expanduser("~/.local/share/prime-agent/releases/*/prime-agent-runtime/src/rlm/harness.py"))[-1])))
work = tempfile.mkdtemp()
os.environ["RLM_GLOBAL_HARNESS_STATE_DIR"] = f"{work}/global"
os.environ["RLM_HARNESS_STATE_DIR"] = f"{work}/local"
sys.path[:0] = [RUNTIME, HERE]
from rlm.harness import get_harness_state  # noqa: E402
import harness_edit as he  # noqa: E402

he.UNDO_LOG = f"{work}/undo.jsonl"
he.CHECK = f"{work}/check.json"
fails = 0


def check(name, ok):
    global fails
    print(("ok: " if ok else "FAIL: ") + name)
    fails += 0 if ok else 1


rlm = types.SimpleNamespace(harness=get_harness_state(state_dir=f"{work}/local"))
H = rlm.harness
H.create("memory", "Aside 5180 tabs stall when ten tabs are open", "Chrome allows six connections per host, so open the tab on [::1]:5180. Seen 10-18.", id="aside_a", global_=True)
H.create("memory", "Aside tabs on localhost:5180 stall", "Chrome allows six connections per host, so about ten 5180 tabs stall; open the tab on [::1]:5180. Seen 10-27.", id="aside_b", global_=True)
H.create("memory", "pi-pool tests run with python3 -m unittest", "Run tests in components/pi-pool/tests with /usr/bin/python3.", id="pool_old", global_=True)
H.create("memory", "seo agent keeps its GSC key in the vault", "The seo agent reads GSC through its own key.", id="seo_only", path="seo", global_=True)
H.create("memory", "Unrelated note about ClickHouse", "ClickHouse merges parts in the background on metal.", id="other", global_=True)

repo = f"{work}/repo"
os.makedirs(f"{repo}/components/pi-pool/tests")
open(f"{repo}/components/pi-pool/tests/t.py", "w").write("x\n")
git = lambda *a: subprocess.run(["git", "-C", repo, *a], capture_output=True, check=True)  # noqa: E731
git("init", "-q")
git("-c", "user.email=t@t", "-c", "user.name=t", "add", ".")
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "add")
git("mv", "components/pi-pool", "packages-pi-pool")
git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "move")
json.dump({"agents": [{"slug": "seo", "agent": "ag_seo"}]}, open(f"{work}/ideal.json", "w"))

out = subprocess.run([sys.executable, f"{HERE}/harness_check.py", he.CHECK, "--store", f"{work}/global/harness_state.json",
                      "--repo", repo, "--agents", f"{work}/ideal.json"], capture_output=True, text=True)
res = json.load(open(he.CHECK))
dup_ids = [sorted(e["id"] for e in g["entries"]) for g in res["duplicates"]]
check("check: the two Aside notes form one duplicate group", ["aside_a", "aside_b"] in dup_ids)
check("check: the unrelated note is no duplicate", not any("other" in g for g in dup_ids))
check("check: the moved pi-pool path is dead", [d["id"] for d in res["dead_paths"]] == ["pool_old"])
check("check: the seo note is agent_scoped and skipped", res["agent_scoped"] == [{"kind": "memory", "id": "seo_only", "agent": "seo"}])

he.merge(rlm, "memory", keep="aside_a", drop=["aside_b"], title="Aside 5180 tabs stall at about ten tabs",
         content="Chrome allows six connections per host, so open 5180 on [::1]:5180. Seen 10-18 and 10-27.", why="fixture")
check("merge: keep rewritten, drop deleted", H.get("memory", "aside_b", global_=True) is None and "10-27" in H.get("memory", "aside_a", global_=True).content)
he.delete(rlm, "memory", "pool_old", why="fixture")
check("delete: entry gone", H.get("memory", "pool_old", global_=True) is None)
try:
    he.delete(rlm, "memory", "seo_only", why="fixture")
    check("guard: agent_scoped entry refused", False)
except ValueError:
    check("guard: agent_scoped entry refused", H.get("memory", "seo_only", global_=True) is not None)
log = [json.loads(line) for line in open(he.UNDO_LOG)]
check("log: one line per change with the full before", [r["action"] for r in log] == ["update", "delete", "delete"] and log[1]["before"]["id"] == "aside_b")

he.undo(rlm, n=3)
check("undo: all three changes reverted", H.get("memory", "pool_old", global_=True) is not None and H.get("memory", "aside_b", global_=True) is not None
      and "10-27" not in H.get("memory", "aside_a", global_=True).content)
check("undo: a second undo finds nothing left", he.undo(rlm, n=3) == [])

print("all passed" if not fails else f"{fails} failed")
sys.exit(1 if fails else 0)
