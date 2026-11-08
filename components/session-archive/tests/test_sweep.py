import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import sweep  # noqa: E402

NOW = 2_000_000_000.0
OLD = "2033-05-16T00:00:00Z"  # 2 days before NOW
NEW = "2033-05-18T02:00:00Z"  # 1 h before NOW
ART = str(sweep.ARTIFACTS)


def row(sid, depth=1, at=OLD, file=None, **extra):
    base = {"sessionId": sid, "lifecycle": "live", "activity": "idle", "rlmDepth": depth, "lastActivityAt": at, "modified": at,
            "runtimeKind": "subagent" if depth else None, "sessionFile": file or f"{ART}/root/sub-{sid}/{sid}.jsonl"}
    return {**base, **extra}


class PlanTest(unittest.TestCase):
    def plan(self, rows, **ctx):
        chosen, kept = sweep.plan(rows, sweep.Context(**ctx), NOW)
        return [r["sessionId"] for r in chosen], dict(kept)

    def test_idle_job_is_archived_and_each_kept_reason_counts(self):
        rows = [row("idle"), row("chat", depth=0, file="/s/chat.jsonl"), row("other-root", depth=0, file="/s/o.jsonl"),
                row("job-root", depth=0, file="/s/j.jsonl"), row("named-root", depth=0, file="/s/n.jsonl", sessionName="fix x"),
                row("working", activity="working"), row("bash", isBashRunning=True), row("asks", taskState="needs_input"),
                row("woken"), row("listed"), row("stepped"), row("named", sessionName="crawl job"), row("fresh", at=NEW),
                row("gone", lifecycle="archived")]
        chosen, kept = self.plan(rows, chat_ids={"chat"}, job_ids={"job-root"}, job_names={"fix x"}, wake_ids={"woken"},
                                 chat_live={"listed"}, open_ids={"stepped"}, open_names={"crawl job"})
        self.assertEqual(sorted(chosen), ["idle", "job-root", "named-root"])
        self.assertEqual(kept, {"chat_thread": 1, "top_level_not_a_job": 1, "live_job": 3, "pending_wake": 1, "chat_lists_live": 1,
                                "open_step": 2, "idle_under_24h": 1})

    def test_a_kept_child_keeps_every_session_above_it(self):
        parent = row("p", file=f"{ART}/r/sub-a/p.jsonl")
        child = row("c", depth=2, file=f"{ART}/r/sub-a/sub-b/c.jsonl")
        grandchild = row("g", depth=3, at=NEW, file=f"{ART}/r/sub-a/sub-b/sub-c/g.jsonl")
        root = row("r", depth=0, file="/s/r.jsonl")
        chosen, kept = self.plan([root, parent, child, grandchild], job_ids={"r"})
        self.assertEqual(chosen, [])
        self.assertEqual(kept, {"idle_under_24h": 1, "live_descendant": 3})

    def test_the_daemon_parent_field_links_a_tree_too(self):
        chosen, kept = self.plan([row("p"), row("c", depth=2, parentSessionId="p", file="/elsewhere/c.jsonl", activity="working")])
        self.assertEqual((chosen, kept), ([], {"live_job": 1, "live_descendant": 1}))

    def test_deepest_first_and_a_second_run_picks_nothing(self):
        rows = [row("a", depth=1, file=f"{ART}/r/sub-a/a.jsonl"), row("b", depth=2, file=f"{ART}/r/sub-a/sub-b/b.jsonl")]
        chosen, _ = self.plan(rows)
        self.assertEqual(chosen, ["b", "a"])
        for each in rows:
            each["lifecycle"] = "archived"
        self.assertEqual(self.plan(rows), ([], {}))


if __name__ == "__main__":
    unittest.main()
