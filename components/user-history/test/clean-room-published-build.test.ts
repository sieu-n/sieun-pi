import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { whole } from "../scripts/clean-room/published-build-keep.ts";

const sum = (text: string): string => createHash("sha256").update(text).digest("hex");

test("a published tree reads whole only with a read-only feed, a tarball, latest.json, verified sums and a build log", () => {
  const root = mkdtempSync(join(tmpdir(), "published-build-keep-"));
  try {
    mkdirSync(join(root, "feed"));
    writeFileSync(join(root, "feed", "unslop.tar.gz"), "tar");
    writeFileSync(join(root, "feed", "latest.json"), "{}");
    writeFileSync(join(root, "SHA256SUMS"), `${sum("tar")}  feed/unslop.tar.gz\n${sum("{}")}  feed/latest.json\n`);
    writeFileSync(join(root, "build.log"), "built\n");
    assert.equal(whole(root).ok, false, "feed/ is still writable");
    chmodSync(join(root, "feed"), 0o555);
    assert.equal(whole(root).ok, true, whole(root).detail);
    writeFileSync(join(root, "SHA256SUMS"), `${sum("other")}  feed/unslop.tar.gz\n`);
    assert.match(whole(root).detail, /does not match/);
    assert.equal(whole(root).ok, false);
  } finally {
    chmodSync(join(root, "feed"), 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
