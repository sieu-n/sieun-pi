import assert from "node:assert/strict";
import { test } from "node:test";
import { childTitle, firstLineName, jobTitle } from "../../src/durable/job-title.ts";

test("a brief's first line never names a job; the gist after its label does", () => {
  assert.equal(jobTitle('You are subagent A on the "sw factory" chat app. Your job: make sending a message work exactly like Slack. A message must render.'), "make sending a message work exactly like Slack");
  assert.equal(jobTitle("[task from parent]\n\nOwner's words (verbatim):\n1. \"fix it\"\n\nMy read: the server lists every thread.\n\nTask:\n1. x"), "the server lists every thread");
  assert.equal(jobTitle("Trace one refused call on prod Vent. At 01:28 prod Vent got a call."), "Trace one refused call on prod Vent");
  assert.equal(jobTitle("Goal: make AI agents on pi-host durable threads behave 1:1 like Prime chat agents by running Prime's own extensions."), "make AI agents on pi-host durable threads behave 1:1");
  assert.equal(jobTitle(""), "");
});

test("a spawn name stays; a name that is only the task's first line gives way to the gist", () => {
  const task = "Owner's words (verbatim):\n1. hi\n\nMy read: jobs need short titles.";
  assert.equal(childTitle("phase 2 dm rooms", task), "phase 2 dm rooms");
  assert.equal(childTitle(firstLineName(task), task), "jobs need short titles");
  assert.equal(childTitle("", task), "jobs need short titles");
});
