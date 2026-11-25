/**
 * The two duties every sw factory agent has from its start (c249). The owner, #sw-factory-build p234 (msg mwwklmfk, 11-26): "ALL THREADS
 * SHOULD COMMONLY have 2 duties that - every 3 hour push completing tasks in the TODO board - every day checks their area of responsiblity
 * and proactively (as an actual person would) watch and maintain dashboards, identify issues, act on issues, clean up (so product and codebase
 * is always state-of-the-art) and self-improve: llm-wiki, agent file update & stale 쳐내고, common user frustration point들 반복하지 않도록".
 *
 * The 3-hourly board push is the check-in, which already pushes every open goal and step to done (boards.ts `DEFAULT_CHECK_IN_MS`), so it
 * is no second duty. The daily review is the stored duty "Area review", which `App.createAgent` sets on each new agent, paused on a walk's
 * test agent so no throwaway agent starts a daily job. Its precheck, scripts/duties/area-review.ts, runs with plain node from the agent's
 * own project folder, so the duty job works there.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export const AREA_REVIEW_NAME = "Area review";
export const BOARD_PUSH_EVERY_MS = 180 * 60_000;

export const COMMON_DUTIES_WORDS = "messy as fuck. 이걸 그냥 한번만 정리하라는게 아니라, ALL THREADS SHOULD COMMONLY have 2 duties that \n" +
  "- every 3 hour push completing tasks in the TODO board\n" +
  "- every day checks their area of responsiblity and proactively  (as an actual person would) watch and maintain dashboards, identify issues, act on issues, " +
  "clean up (so product and codebase is always state-of-the-art) and self-improve: llm-wiki, agent file update & stale 쳐내고, common user frustration point들 반복하지 않도록\n" +
  "(#sw-factory-build p234, 11-26, msg mwwklmfk, c249)";

/** The apps/chat folder through the release's `current` link, so a stored precheck path outlives the release folder a later release prunes. */
export function liveAppDir(dir = resolve(import.meta.dirname, "..")): string {
  const match = /^(.*\/sieun-pi-apps-chat)\/release-[^/]+(\/.*)?$/.exec(dir);
  if (!match) return dir;
  const live = `${match[1]}/current${match[2] ?? ""}`;
  return existsSync(live) ? live : dir;
}

/**
 * The "Area review" duty of agent `agentId`, whose project folder is `cwd`. A folder this box lacks, such as a Mac agent's, runs the precheck
 * from the apps/chat folder instead, since a precheck always runs on the chat host.
 */
export function areaReviewDuty(agentId: string, cwd: string | undefined, appDir = liveAppDir()): Record<string, unknown> {
  return {
    name: AREA_REVIEW_NAME,
    ownerWords: COMMON_DUTIES_WORDS,
    goal: "Each day the agent reviews its whole area the way the person who owns it would: it opens the dashboards and the live product its brief and memory name, " +
      "finds issues and acts on them (a fix it lands, or a board step with a job), cleans up the product and code it owns, and improves itself: " +
      "it updates its llm-wiki pages, agent files and memory, prunes what is stale, and saves each owner correction and frustration so it never repeats.",
    metrics: [
      { key: "corrections_unsaved", label: "Owner corrections in force from this agent's rooms that its memory names nowhere", op: "<=", target: 0, unit: " corrections", headline: true },
    ],
    readings: [
      { key: "owner_posts_24h", label: "Owner posts to this agent in the last 24 h", unit: " posts" },
      { key: "wiki_pages_touched_24h", label: "Pages in the agent's folder changed in the last 24 h", unit: " pages" },
      { key: "memory_changed_24h", label: "Memory entries changed in the last 24 h", unit: " entries" },
    ],
    precheck: {
      command: ["node", join(appDir, "scripts/duties/area-review.ts"), "--agent", agentId],
      cwd: cwd && existsSync(cwd) ? cwd : appDir,
      timeoutMs: 60_000,
    },
    onMiss: "Do the review in the area_review item first, in this order: read the brief, memory and working memory for the area, open its dashboards and live product, " +
      "fix or file each issue you find, and clean up stale code, pages and memory. For each correction_unsaved, save the rule to memory with its id and change what let it happen. " +
      "Read each owner_post for a frustration or an ask that is still open, and act on it.",
  };
}
