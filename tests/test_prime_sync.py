import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

REPO = Path(__file__).resolve().parents[1]
SYNC = REPO / "components/prime-sync/sync.py"
ENV = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}


def git(*args, cwd=None):
    return subprocess.run(["git", *args], cwd=cwd, env=ENV, check=True, capture_output=True, text=True).stdout.strip()


def entry(entry_id, content, updated="2026-10-18T00:00:00+00:00", kind="memory"):
    return {"id": entry_id, "kind": kind, "title": entry_id, "content": content, "path": "general", "scope": "global",
            "reference": {}, "arguments": {}, "metadata": {}, "source": "agent",
            "created_at": "2026-10-01T00:00:00+00:00", "updated_at": updated, "version": 1}


def correction(number, rule):
    return {"id": f"c{number}", "at": f"2026-10-{number:02d}T00:00:00.000Z", "chat": {"id": "x", "name": "x"}, "words": rule,
            "rule": rule, "enforcedBy": "brief", "ref": "", "status": "active", "theme": [], "repeats": []}


class PrimeSyncTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        git("init", "-q", "--bare", "-b", "main", str(self.root / "state.git"))
        git("init", "-q", "--bare", "-b", "main", str(self.root / "code.git"))
        seed = self.root / "seed"
        git("clone", "-q", str(self.root / "code.git"), str(seed))
        (seed / "skills/unslop").mkdir(parents=True)
        (seed / "skills/unslop/SKILL.md").write_text("v1\n")
        (seed / "config").mkdir()
        (seed / "config/AGENTS.md").write_text("rules\n")
        (seed / "config/settings.shared.json").write_text(json.dumps({"defaultThinkingLevel": "high"}))
        (seed / "install-manifest.json").write_text(json.dumps({"version": 1, "entries": [
            {"id": "skill:unslop", "kind": "link", "source": "skills/unslop", "scope": "home", "target": ".prime/agent/skills/unslop"},
            {"id": "agent-rules", "kind": "link", "source": "config/AGENTS.md", "scope": "home", "target": ".prime/agent/AGENTS.md"}]}))
        self.commit(seed, "seed")
        self.seed = seed

    def commit(self, checkout, message):
        git("-c", "user.name=t", "-c", "user.email=t@t", "-C", str(checkout), "add", "-A")
        git("-c", "user.name=t", "-c", "user.email=t@t", "-C", str(checkout), "commit", "-q", "-m", message)
        git("-C", str(checkout), "push", "-q", "origin", "main")

    def box(self, name, memories, corrections):
        home = self.root / name
        agent = home / ".prime/agent"
        (agent / "harness").mkdir(parents=True)
        (agent / "browser-chat").mkdir()
        (agent / "skills/unslop").mkdir(parents=True)
        (agent / "skills/unslop/SKILL.md").write_text("stale copy\n")
        self.write_harness(home, memories)
        (agent / "browser-chat/corrections.json").write_text(json.dumps({"corrections": corrections}))
        git("clone", "-q", str(self.root / "code.git"), str(home / "src/sieun-pi"))
        git("clone", "-q", str(self.root / "state.git"), str(home / "state"))
        (home / ".config/prime-sync").mkdir(parents=True)
        (home / ".config/prime-sync/sync.json").write_text(json.dumps({
            "host": name, "checkout": str(home / "src/sieun-pi"), "stateDir": str(home / "state"), "agentDir": str(agent)}))
        return home

    def write_harness(self, home, memories, refinements=()):
        state = {"schema": 1, "entries": {"prompt": {}, "memory": {m["id"]: m for m in memories}, "skill": {}, "subagent": {}},
                 "refinements": list(refinements)}
        (home / ".prime/agent/harness/harness_state.json").write_text(json.dumps(state, indent=2))

    def memories(self, home):
        return json.loads((home / ".prime/agent/harness/harness_state.json").read_text())["entries"]["memory"]

    def ledger(self, home):
        return [c["id"] for c in json.loads((home / ".prime/agent/browser-chat/corrections.json").read_text())["corrections"]]

    def sync(self, home, code=0, env=None):
        env = {**ENV, "HOME": str(home), "PRIME_SYNC_SETTLE": "0", **(env or {})}
        result = subprocess.run(["python3", "-B", str(SYNC)], env=env, capture_output=True, text=True)
        self.assertEqual(result.returncode, code, result.stdout + result.stderr)
        return json.loads(result.stdout)

    def test_two_boxes_converge_and_edits_and_deletes_travel(self):
        mac = self.box("mac", [entry("a", "mac a"), entry("b", "b")], [correction(1, "one"), correction(2, "two")])
        box = self.box("box", [entry("a", "old a", "2026-09-01T00:00:00+00:00"), entry("boxonly", "box fact")], [correction(1, "one")])
        self.sync(mac)
        self.sync(box)
        self.assertEqual(sorted(self.memories(box)), ["a", "b", "boxonly"])
        self.assertEqual(self.memories(box)["a"]["content"], "mac a")
        self.assertEqual(self.ledger(box), ["c1", "c2"])
        self.sync(mac)
        self.assertEqual(sorted(self.memories(mac)), ["a", "b", "boxonly"])

        memories = self.memories(mac)
        memories["a"] = entry("a", "mac a v2", "2026-10-18T01:00:00+00:00")
        del memories["b"]
        self.write_harness(mac, memories.values())
        ledger = json.loads((mac / ".prime/agent/browser-chat/corrections.json").read_text())
        ledger["corrections"].append(correction(3, "three"))
        (mac / ".prime/agent/browser-chat/corrections.json").write_text(json.dumps(ledger))
        self.sync(mac)
        self.sync(box)
        self.assertEqual(sorted(self.memories(box)), ["a", "boxonly"])
        self.assertEqual(self.memories(box)["a"]["content"], "mac a v2")
        self.assertEqual(self.ledger(box), ["c1", "c2", "c3"])

    def test_a_clash_goes_to_the_newer_entry(self):
        mac = self.box("mac", [entry("a", "base")], [])
        box = self.box("box", [], [])
        self.sync(mac)
        self.sync(box)
        self.write_harness(mac, [entry("a", "mac edit", "2026-10-18T02:00:00+00:00")])
        self.write_harness(box, [entry("a", "box edit", "2026-10-18T03:00:00+00:00")])
        self.sync(mac)
        self.sync(box)
        self.sync(mac)
        self.assertEqual(self.memories(mac)["a"]["content"], "box edit")
        self.assertEqual(self.memories(box)["a"]["content"], "box edit")

    def test_links_replace_copies_and_follow_main(self):
        box = self.box("box", [], [])
        report = self.sync(box)
        skill = box / ".prime/agent/skills/unslop"
        self.assertTrue(skill.is_symlink())
        self.assertEqual((skill / "SKILL.md").read_text(), "v1\n")
        self.assertEqual(os.readlink(box / ".prime/agent/AGENTS.md"), str(box / "src/sieun-pi/config/AGENTS.md"))
        self.assertIn("set defaultThinkingLevel", report["settings"])
        (self.seed / "skills/unslop/SKILL.md").write_text("v2\n")
        self.commit(self.seed, "edit")
        self.assertIn("pulled", self.sync(box)["code"])
        self.assertEqual((skill / "SKILL.md").read_text(), "v2\n")

    def test_an_emptied_file_never_deletes_the_shared_entries(self):
        mac = self.box("mac", [entry("a", "a"), entry("b", "b")], [])
        self.sync(mac)
        self.write_harness(mac, [])
        self.assertIn("skipped", self.sync(mac)["state"])
        box = self.box("box", [], [])
        self.sync(box)
        self.assertEqual(sorted(self.memories(box)), ["a", "b"])

    def local_commit(self, checkout, path, text):
        (checkout / path).write_text(text)
        git("-c", "user.name=t", "-c", "user.email=t@t", "-C", str(checkout), "commit", "-q", "-am", f"local {path}")

    def test_local_commits_rebase_onto_main_and_keep_dirty_and_untracked_files(self):
        box = self.box("box", [], [])
        checkout = box / "src/sieun-pi"
        self.local_commit(checkout, "config/AGENTS.md", "rules\nlocal rule\n")
        (self.seed / "skills/unslop/SKILL.md").write_text("v2\nmore\n")
        self.commit(self.seed, "upstream")
        (checkout / "skills/unslop/SKILL.md").write_text("v1 dirty\n")
        (checkout / "config/settings.shared.json").write_text(json.dumps({"defaultThinkingLevel": "high", "x": 1}))
        git("-C", str(checkout), "add", "config/settings.shared.json")
        (checkout / "notes.txt").write_text("untracked\n")
        report = self.sync(box)
        self.assertTrue(report["code"].startswith("rebased 1 local commits"), report["code"])
        self.assertIn("carried skills/unslop/SKILL.md", report["code"])
        self.assertEqual(git("-C", str(checkout), "rev-parse", "HEAD^"), git("-C", str(self.seed), "rev-parse", "HEAD"))
        self.assertEqual((checkout / "config/AGENTS.md").read_text(), "rules\nlocal rule\n")
        self.assertEqual((checkout / "skills/unslop/SKILL.md").read_text(), "v1 dirty\n")
        self.assertEqual(git("-C", str(checkout), "show", "HEAD:skills/unslop/SKILL.md"), "v2\nmore")
        self.assertEqual(self.saved(box, "skills/unslop/SKILL.md"), "v1 dirty\n")
        self.assertEqual((checkout / "notes.txt").read_text(), "untracked\n")
        self.assertEqual(git("-C", str(checkout), "status", "--porcelain"), "M  config/settings.shared.json\n M skills/unslop/SKILL.md\n?? notes.txt")
        self.assertEqual(git("-C", str(checkout), "stash", "list"), "")
        self.assertTrue(git("-C", str(checkout), "status", "-sb").startswith("## main...origin/main [ahead 1]"))
        self.assertIn("rebased", (box / ".local/share/prime-sync/sync.log").read_text())

    def saved(self, box, rel):
        found = list((box / ".local/share/prime-sync/carried").glob(f"*/{rel}"))
        self.assertEqual(len(found), 1, found)
        return found[0].read_text()

    def test_a_draft_older_than_the_commit_that_landed_it_takes_the_tip(self):
        # 10-18: drafts written before their own commits landed held asa-mac-sync's box checkout from 08:13Z.
        box = self.box("box", [], [])
        checkout = box / "src/sieun-pi"
        (checkout / "skills/unslop/SKILL.md").write_text("draft\n")
        old = time.time() - 600
        os.utime(checkout / "skills/unslop/SKILL.md", (old, old))
        (self.seed / "skills/unslop/SKILL.md").write_text("landed\n")
        self.commit(self.seed, "land the draft")
        report = self.sync(box)
        self.assertIn("took the tip for superseded skills/unslop/SKILL.md", report["code"])
        self.assertEqual((checkout / "skills/unslop/SKILL.md").read_text(), "landed\n")
        self.assertEqual(self.saved(box, "skills/unslop/SKILL.md"), "draft\n")
        self.assertEqual(git("-C", str(checkout), "status", "--porcelain"), "")

    def test_a_dirty_file_the_pull_changes_rides_along(self):
        box = self.box("box", [], [])
        checkout = box / "src/sieun-pi"
        (self.seed / "config/AGENTS.md").write_text("rules\nupstream\n")
        self.commit(self.seed, "upstream")
        (checkout / "config/AGENTS.md").write_text("local\nrules\n")
        self.assertIn("pulled", self.sync(box)["code"])
        self.assertEqual((checkout / "config/AGENTS.md").read_text(), "local\nrules\nupstream\n")
        self.assertEqual(git("-C", str(checkout), "stash", "list"), "")

    def test_a_conflicting_local_commit_is_left_alone_and_logged(self):
        box = self.box("box", [], [])
        checkout = box / "src/sieun-pi"
        self.local_commit(checkout, "config/AGENTS.md", "box rules\n")
        head = git("-C", str(checkout), "rev-parse", "HEAD")
        (self.seed / "config/AGENTS.md").write_text("mac rules\n")
        self.commit(self.seed, "upstream")
        report = self.sync(box)
        self.assertIn("skipped: diverged", report["code"])
        self.assertEqual(git("-C", str(checkout), "rev-parse", "HEAD"), head)
        self.assertEqual(git("-C", str(checkout), "status", "--porcelain"), "")
        self.assertIn("conflicts", (box / ".local/share/prime-sync/sync.log").read_text())

    def test_an_untracked_file_in_the_way_stays_as_a_local_edit(self):
        box = self.box("box", [], [])
        checkout = box / "src/sieun-pi"
        (self.seed / "new.txt").write_text("upstream\n")
        self.commit(self.seed, "upstream")
        (checkout / "new.txt").write_text("mine\n")
        report = self.sync(box)
        self.assertIn("kept local new.txt", report["code"])
        self.assertEqual(git("-C", str(checkout), "rev-parse", "HEAD"), git("-C", str(self.seed), "rev-parse", "HEAD"))
        self.assertEqual((checkout / "new.txt").read_text(), "mine\n")
        self.assertEqual(git("-C", str(checkout), "status", "--porcelain"), "M new.txt")

    def test_a_blocked_checkout_tells_its_writer_and_then_the_chat(self):
        # 10-18: the Mac's checkout sat at 461986e from 08:26Z to 10:45Z with nobody told.
        box = self.box("box", [], [])
        checkout = box / "src/sieun-pi"
        head = git("-C", str(checkout), "rev-parse", "HEAD")
        (self.seed / "config/AGENTS.md").write_text("rules\nupstream\n")
        self.commit(self.seed, "upstream")
        (checkout / "config/AGENTS.md").write_text("rules\nstaged\n")
        git("-C", str(checkout), "add", "config/AGENTS.md")
        (checkout / "config/AGENTS.md").write_text("rules\nstaged then edited\n")
        session = "01a1aaaa-bbbb-7ccc-8ddd-eeeeeeeeeeee"
        transcript = box / ".prime/agent/sessions/x" / f"{session}.jsonl"
        transcript.parent.mkdir(parents=True)
        call = {"type": "toolCall", "name": "ipython", "arguments": {"code": f"open('{checkout}/config/AGENTS.md', 'w').write('x')"}}
        transcript.write_text(json.dumps({"timestamp": "2026-10-18T00:00:00Z", "message": {"content": [call]}}) + "\n")
        calls = self.root / "calls.txt"
        stub = self.root / "stub.sh"
        stub.write_text(f"#!/bin/sh\necho \"$@\" >> {calls}\necho 'Added a todo t7'\n")
        stub.chmod(0o755)
        env = {"PRIME_SYNC_BLOCK_ALERT_S": "0", "PRIME_SYNC_FORYOU_S": "0", "PRIME_SYNC_PRIME_BIN": str(stub), "PRIME_SYNC_BOARD_APPLY": str(stub)}
        report = self.sync(box, env=env)
        self.assertIn("staged changes or folders on config/AGENTS.md", report["code"])
        self.assertEqual(git("-C", str(checkout), "rev-parse", "HEAD"), head)
        self.assertEqual((checkout / "config/AGENTS.md").read_text(), "rules\nstaged then edited\n")
        sent = calls.read_text()
        self.assertIn(f"send {session} [prime-sync] box's sieun-pi checkout", sent)
        self.assertIn("todo_add", sent)
        self.assertEqual(json.loads((box / ".local/share/prime-sync/blocked.json").read_text())["todo"], "t7")
        self.sync(box, env=env)
        self.assertEqual(calls.read_text(), sent)

        git("-C", str(checkout), "reset", "-q", "--", "config/AGENTS.md")
        self.assertIn("carried config/AGENTS.md", self.sync(box, env=env)["code"])
        self.assertIn('"todo_update", "id": "t7", "done": true', calls.read_text())
        self.assertEqual(json.loads((box / ".local/share/prime-sync/blocked.json").read_text()), {})

    def test_a_main_that_drops_the_tree_is_refused_with_an_alert(self):
        # 5557c587a on 10-18: a private index built from an empty tree kept one new file and deleted the other 712.
        box = self.box("box", [], [])
        checkout = box / "src/sieun-pi"
        self.sync(box)
        head = git("-C", str(checkout), "rev-parse", "HEAD")
        index = {**ENV, "GIT_INDEX_FILE": str(self.root / "private-index")}
        subprocess.run(["git", "-C", str(self.seed), "read-tree", "--empty"], env=index, check=True)
        (self.seed / "duty.ts").write_text("duty\n")
        subprocess.run(["git", "-C", str(self.seed), "add", "duty.ts"], env=index, check=True)
        subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-C", str(self.seed), "commit", "-q", "-m", "fix: a duty"], env=index, check=True)
        git("-C", str(self.seed), "push", "-q", "origin", "main")
        report = self.sync(box, code=1)
        self.assertTrue(report["code"].startswith("alert: origin/main"), report["code"])
        self.assertIn("drops 4 of 4 tracked files", report["code"])
        self.assertEqual(git("-C", str(checkout), "rev-parse", "HEAD"), head)
        self.assertEqual((box / ".prime/agent/skills/unslop/SKILL.md").read_text(), "v1\n")
        self.assertIn("alert: origin/main", (box / ".local/share/prime-sync/sync.log").read_text())

        git("-C", str(self.seed), "checkout", "HEAD^", "--", ".")
        self.commit(self.seed, "fix(repo): restore every file the duty commit deleted")
        self.assertTrue(self.sync(box)["code"].startswith("pulled"))
        self.assertTrue((checkout / "duty.ts").exists())

        git("-C", str(self.seed), "rm", "-q", "-r", "skills")
        (self.seed / "install-manifest.json").write_text(json.dumps({"version": 1, "entries": []}))
        self.commit(self.seed, "chore: drop the unslop skill\n\nDeletes: 1 files on purpose")
        self.assertTrue(self.sync(box)["code"].startswith("pulled"))
        self.assertFalse((checkout / "skills/unslop").exists())

    def private_commit(self, checkout, files):
        """Commit through a private index and move main with update-ref, as faa58cd5 did on 10-18, leaving the shared index behind."""
        index = {**ENV, "GIT_INDEX_FILE": str(self.root / "private-index")}
        subprocess.run(["git", "-C", str(checkout), "read-tree", "HEAD"], env=index, check=True)
        for rel, text in files.items():
            (checkout / rel).parent.mkdir(parents=True, exist_ok=True)
            (checkout / rel).write_text(text)
            subprocess.run(["git", "-C", str(checkout), "add", rel], env=index, check=True)
        tree = subprocess.run(["git", "-C", str(checkout), "write-tree"], env=index, check=True, capture_output=True, text=True).stdout.strip()
        head = git("-C", str(checkout), "rev-parse", "HEAD")
        commit = git("-c", "user.name=t", "-c", "user.email=t@t", "-C", str(checkout), "commit-tree", tree, "-p", head, "-m", "perf: private")
        git("-C", str(checkout), "update-ref", "refs/heads/main", commit, head)

    def test_a_private_index_commit_leaves_no_older_version_for_git_to_write_back(self):
        # 10-18: faa58cd5's paths sat at faa58cd5^ in the shared index from 08:26Z, and a copy of the index into the worktree put the
        # old bytes of four client files back and deleted chat-idle-motion.test.ts until 12:45Z.
        box = self.box("box", [], [])
        checkout = box / "src/sieun-pi"
        self.private_commit(checkout, {"skills/unslop/SKILL.md": "v2 fix\n", "tests/motion.test.ts": "test\n"})
        self.assertEqual(git("-C", str(checkout), "status", "--porcelain"), "MM skills/unslop/SKILL.md\nD  tests/motion.test.ts\n?? tests/")
        (checkout / "config/AGENTS.md").write_text("rules\nlive edit\n")
        report = self.sync(box)
        git("-C", str(checkout), "stash", "-q", "--keep-index")
        git("-C", str(checkout), "stash", "pop", "-q")
        self.assertEqual((checkout / "skills/unslop/SKILL.md").read_text(), "v2 fix\n")
        self.assertEqual((checkout / "tests/motion.test.ts").read_text(), "test\n")
        self.assertEqual(git("-C", str(checkout), "status", "--porcelain"), "M config/AGENTS.md")
        self.assertEqual(report["index"], ["reset to HEAD from an older commit: skills/unslop/SKILL.md, tests/motion.test.ts"])

    def test_an_older_version_already_written_back_takes_heads_bytes(self):
        box = self.box("box", [], [])
        checkout = box / "src/sieun-pi"
        self.private_commit(checkout, {"skills/unslop/SKILL.md": "v2 fix\n", "tests/motion.test.ts": "test\n"})
        git("-C", str(checkout), "stash", "-q", "--keep-index")
        git("-C", str(checkout), "stash", "pop", "-q")
        self.assertEqual((checkout / "skills/unslop/SKILL.md").read_text(), "v1\n")
        self.assertFalse((checkout / "tests/motion.test.ts").exists())
        (checkout / "config/AGENTS.md").write_text("rules\nstaged live edit\n")
        git("-C", str(checkout), "add", "config/AGENTS.md")
        report = self.sync(box)
        self.assertEqual((checkout / "skills/unslop/SKILL.md").read_text(), "v2 fix\n")
        self.assertEqual((checkout / "tests/motion.test.ts").read_text(), "test\n")
        self.assertEqual(git("-C", str(checkout), "status", "--porcelain"), "M  config/AGENTS.md")
        self.assertEqual(report["index"], ["reset to HEAD from an older commit: skills/unslop/SKILL.md and its file, tests/motion.test.ts and its file"])
        self.assertIn("reset to HEAD from an older commit", (box / ".local/share/prime-sync/sync.log").read_text())


if __name__ == "__main__":
    unittest.main()
