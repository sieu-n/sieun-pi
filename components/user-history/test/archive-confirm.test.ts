import assert from "node:assert/strict";
import { test } from "node:test";
import { archivePrompt } from "../src/client/archive-confirm.ts";

test("the archive confirm names the chat, its running turn and its Slack channel", () => {
  assert.deepEqual(archivePrompt({ name: "VP of CI", busy: false, slackChannel: null }),
    { title: "Archive VP of CI?", body: "Undo from the toast, or unarchive it later from the sidebar.", label: "Archive" });
  assert.deepEqual(archivePrompt({ name: "  ", busy: true, slackChannel: "vp-ops" }),
    { title: "Archive this chat?", body: "Its running turn stops. Its Slack channel #vp-ops is archived too. Undo from the toast, or unarchive it later from the sidebar.", label: "Stop and archive" });
});
