import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeArtifactTarget, parseArtifactTarget } from "../src/shared/artifact-link.ts";

const SESSION = "01a112e2-f720-75db-b51a-84cfbdbcffa0";

test("artifact link: each target form parses; malformed ones are null", () => {
  assert.deepEqual(parseArtifactTarget("job:w6-report"), { kind: "job", name: "w6-report" });
  assert.deepEqual(parseArtifactTarget(`thread:${SESSION}`), { kind: "thread", sessionId: SESSION });
  assert.deepEqual(parseArtifactTarget(`thread:${SESSION}@1759800000000`), { kind: "thread", sessionId: SESSION, at: 1759800000000 });
  assert.deepEqual(parseArtifactTarget("wiki:sessions/2026/10/05/a.md"), { kind: "wiki", path: "sessions/2026/10/05/a.md" });
  assert.deepEqual(parseArtifactTarget("file:/Users/me/report.md"), { kind: "file", path: "/Users/me/report.md" });
  assert.deepEqual(parseArtifactTarget("https://example.com/a?b=1"), { kind: "url", url: "https://example.com/a?b=1" });
  for (const bad of ["", " job:a", "job:", "job:a b", "job:a/b", "thread:", "thread:a@b", "thread:a@", "thread:a b", "wiki:", "wiki:/abs", "wiki:a/../b",
    "file:relative.md", "ftp://x", "javascript:alert(1)", "mailto:a@b.c", "plain words"]) {
    assert.equal(parseArtifactTarget(bad), null, bad);
  }
});

test("artifact link: normalize keeps targets, turns pasted chat, wiki and path text into targets", () => {
  assert.equal(normalizeArtifactTarget("  job:w6 "), "job:w6");
  assert.equal(normalizeArtifactTarget(`http://127.0.0.1:5182/cap/#${SESSION}@1759800000000`), `thread:${SESSION}@1759800000000`);
  assert.equal(normalizeArtifactTarget(`https://chat.example.ts.net/cap/#${SESSION}`), `thread:${SESSION}`, "a UUID hash on any host is a chat link");
  assert.equal(normalizeArtifactTarget("http://127.0.0.1:5182/cap/#s-1@5"), "thread:s-1@5", "any session id on the chat port");
  assert.equal(normalizeArtifactTarget("https://github.com/x/y#readme"), "https://github.com/x/y#readme", "an ordinary anchor stays a URL");
  assert.equal(normalizeArtifactTarget("http://localhost:5176/page/a%20b.md"), "http://localhost:5176/page/a%20b.md", "a wiki path with a space stays a URL");
  assert.equal(normalizeArtifactTarget("http://localhost:5176/page/sessions/2026/a.md"), "wiki:sessions/2026/a.md");
  assert.equal(normalizeArtifactTarget("http://localhost:5176/search?q=x"), "http://localhost:5176/search?q=x", "other wiki routes stay URLs");
  assert.equal(normalizeArtifactTarget("/Users/me/w8-report.md"), "file:/Users/me/w8-report.md");
  assert.equal(normalizeArtifactTarget("http://127.0.0.1:5182/cap/#%E0%A4%A"), "http://127.0.0.1:5182/cap/#%E0%A4%A", "a bad escape is not a crash");
  assert.equal(normalizeArtifactTarget("see the report"), null);
  assert.equal(normalizeArtifactTarget(""), null);
});
