import json
import sqlite3
import tempfile
import time
import unittest
from pathlib import Path

from rlm.harness import HarnessState
from rlm.memory_store import MEMORY_DB, memory_terms

FIXTURE = Path(__file__).resolve().parents[3] / "pi-harness" / "test" / "fixtures" / "memory-terms.json"


class MemoryStoreTest(unittest.TestCase):
    def test_terms_match_the_typescript_tokenizer(self) -> None:
        for case in json.loads(FIXTURE.read_text()):
            self.assertEqual(memory_terms(case["text"]), case["terms"], case["text"])

    def test_local_memory_lives_in_sqlite_and_the_file_holds_none(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "harness_state.json"
            state = HarnessState(path)
            state.create_memory("Release command", "Release apps/chat with node scripts/release-apps-chat.mjs <sha>.", id="release")
            state.create_prompt_note("Note", "Stays in the file.", id="note")
            data = json.loads(path.read_text())
            self.assertEqual(data["entries"]["memory"], {})
            self.assertIn("note", data["entries"]["prompt"])
            rows = sqlite3.connect(Path(temp_dir) / MEMORY_DB).execute("SELECT id, title FROM memory").fetchall()
            self.assertEqual(rows, [("release", "Release command")])

            updated = HarnessState(path).update_memory("release", "Release command", "Use release-apps-chat.mjs under systemd-run.")
            self.assertEqual(updated.version, 2)
            self.assertEqual(HarnessState(path).get("memory", "release").content, "Use release-apps-chat.mjs under systemd-run.")
            self.assertTrue(HarnessState(path).delete_memory("release"))
            self.assertIsNone(HarnessState(path).get("memory", "release"))

    def test_file_entries_from_an_older_writer_move_into_the_store(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "harness_state.json"
            entry = {"id": "old", "kind": "memory", "title": "Old fact", "content": "Written by an older kernel.", "scope": "local", "updated_at": "2026-11-01T00:00:00Z"}
            path.write_text(json.dumps({"schema": 1, "entries": {"prompt": {}, "memory": {"old": entry}, "skill": {}, "subagent": {}}, "refinements": []}))
            state = HarnessState(path)
            self.assertEqual(state.get("memory", "old").title, "Old fact")
            state.create_memory("New fact", "Saved after the move.", id="new")
            self.assertEqual(json.loads(path.read_text())["entries"]["memory"], {})
            self.assertEqual(sorted(e.id for e in HarnessState(path).list("memory")), ["new", "old"])

    def test_search_ranks_ten_thousand_entries_quickly(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "harness_state.json"
            state = HarnessState(path)
            store = state.entries["memory"].store  # type: ignore[attr-defined]
            store.put([
                {"id": f"filler_{n}", "title": f"Filler fact {n}", "content": f"Port {7000 + n} serves service number {n} on box {n % 7}."}
                for n in range(10_000)
            ])
            state.create_memory("Wiki pages lead with diagrams", "Owner c247: 위키 페이지는 다이어그램과 표가 먼저, short prose lines.", id="c247_wiki")
            started = time.perf_counter()
            hits = state.search("위키 페이지 다이어그램 먼저 해", "memory", 5)
            took = time.perf_counter() - started
            self.assertEqual(hits[0].id, "c247_wiki")
            self.assertLess(took, 0.5)
            start = time.perf_counter()
            state.create_memory("One more", "A single write touches one row.", id="one_more")
            self.assertLess(time.perf_counter() - start, 0.5)


if __name__ == "__main__":
    unittest.main()
