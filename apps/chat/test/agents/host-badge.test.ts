import assert from "node:assert/strict";
import { test } from "node:test";
import { boxLabel, defaultHost, hostBadge, hostOptions, hostProjects, offlineText } from "../../web/src/pages/agents/host-badge.ts";
import { deliveryText } from "../../web/src/pages/channel/present.ts";

const metal = { box: "us-metal02", label: "us-metal02", self: true, state: "up" as const, home: "/home/sieun" };
const mac = { box: "mac", label: "Mac", self: false, state: "up" as const, home: "/Users/sieun", projects: ["/Users/sieun/src/sieun-pi", "/Users/sieun/src/auto-sns-agent"] };

test("the owner's Mac shows as Mac and every other box by its name", () => {
  assert.equal(boxLabel("mac"), "Mac");
  assert.equal(boxLabel("us-metal03"), "us-metal03");
});

test("an agent on the chat's own box gets no badge, and one on another box gets that box", () => {
  assert.equal(hostBadge({ host: "us-metal02" }, "us-metal02"), null);
  assert.equal(hostBadge({ host: "mac" }, null), null);
  assert.deepEqual(hostBadge({ host: "mac", hostState: "up" }, "us-metal02"), { label: "Mac", away: false, title: "Runs on Mac" });
  assert.equal(hostBadge({ host: "us-metal03" }, "us-metal02")?.label, "us-metal03");
});

test("the badge dims and says away while the chat server has no link to the box", () => {
  const badge = hostBadge({ host: "mac", hostState: "away" }, "us-metal02");
  assert.equal(badge?.away, true);
  assert.match(badge?.title ?? "", /offline/);
});

test("a delivery queued on an away box reads as queued, never as a failure", () => {
  assert.equal(offlineText("queued, mac is offline"), "Queued, Mac is offline");
  assert.equal(offlineText("queued, us-metal03 is offline"), "Queued, us-metal03 is offline");
  assert.equal(offlineText("pi-host refused the input"), null);
  assert.equal(offlineText(undefined), null);
  assert.equal(deliveryText({ target: "ag_scout", name: "Scout", state: "queued", at: 0, error: "queued, mac is offline" }), "Scout was mentioned. Queued, Mac is offline.");
  assert.equal(deliveryText({ target: "ag_scout", name: "Scout", state: "queued", at: 0 }), "Scout was mentioned and waits for a working slot.");
});

test("the host picker lists the chat's own box first and marks an away box", () => {
  const away = { ...mac, state: "away" as const };
  assert.deepEqual(hostOptions([away, metal]), [
    { value: "us-metal02", label: "us-metal02 (this box)", disabled: false },
    { value: "mac", label: "Mac · away", disabled: true },
  ]);
  assert.equal(defaultHost([mac, metal]), "us-metal02");
  assert.equal(defaultHost([]), "");
});

test("another box offers the project folders its host row names", () => {
  assert.deepEqual(hostProjects(mac), {
    projects: [{ path: "/Users/sieun/src/sieun-pi", name: "sieun-pi" }, { path: "/Users/sieun/src/auto-sns-agent", name: "auto-sns-agent" }],
    default: "/Users/sieun/src/sieun-pi",
    home: "/Users/sieun",
  });
  assert.deepEqual(hostProjects({ ...mac, projects: undefined }), { projects: [], default: "/Users/sieun", home: "/Users/sieun" });
});
