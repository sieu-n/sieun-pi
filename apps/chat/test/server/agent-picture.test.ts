/**
 * Agent pictures (web/src/lib/ui/agent-picture.ts) are flat marks drawn from an agent's id and name, in one of three styles the owner picks
 * in Preferences. The owner asked on 11-25 (#sw-factory-build p218) to make the profile pictures more iconic than the old blob faces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PICTURE_STYLES, SWATCHES, assignPictures, pictureSvg } from "../../web/src/lib/ui/agent-picture.ts";

const AGENTS = [
  ["ag_devops-guy", "devops guy"],
  ["ag_crawler-guy", "Crawler guy"],
  ["ag_seo", "seo"],
  ["ag_agent-factory", "agent factory"],
  ["ag_knowledge-manager-make-llm-wiki-info-and", "knowledge manager (make llm-wiki info and, skills always up to date)"],
  ["ag_api-portal", "API portal"],
  ["ag_gpt-guy", "gpt guy"],
  ["ag_vent", "vent"],
] as const;

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

test("every swatch's ink has at least 4.5:1 contrast on its background", () => {
  for (const { bg, ink } of SWATCHES) {
    const [hi, lo] = [luminance(bg), luminance(ink)].sort((a, b) => b - a);
    assert.ok((hi! + 0.05) / (lo! + 0.05) >= 4.5, `${ink} on ${bg}`);
  }
});

test("each style draws a 32 by 32 picture on the agent's color, the same every time", () => {
  for (const { value: style } of PICTURE_STYLES) {
    for (const [id, name] of AGENTS) {
      const svg = pictureSvg(style, id, name);
      assert.match(svg, /^<svg [^>]*viewBox="0 0 32 32"[^>]*>.*<\/svg>$/s);
      assert.ok(svg.includes(`data-picture="${style}"`));
      assert.ok(svg.length > 120, `${style} draws a mark for ${name}`);
      assert.equal(pictureSvg(style, id, name), svg);
    }
  }
});

test("the three styles draw different pictures for one agent", () => {
  for (const [id, name] of AGENTS) {
    const drawn = new Set(PICTURE_STYLES.map(({ value }) => pictureSvg(value, id, name).replace(/data-picture="\w+"/, "")));
    assert.equal(drawn.size, PICTURE_STYLES.length, name);
  }
});

test("agents get different pictures in every style", () => {
  for (const { value: style } of PICTURE_STYLES) {
    const drawn = new Set(AGENTS.map(([id, name]) => pictureSvg(style, id, name)));
    assert.equal(drawn.size, AGENTS.length, style);
  }
});

/** The registered agents on 11-25, oldest first, from GET :5184/api/agents. */
const LIVE = [
  { id: "ag_vent", name: "vent", createdAt: 1793149210493 },
  { id: "ag_agent-factory", name: "agent factory", createdAt: 1793201124976 },
  { id: "ag_feature-probe", name: "feature probe", createdAt: 1793277669909 },
  { id: "ag_gpt-guy", name: "gpt guy", createdAt: 1793279904347 },
  { id: "ag_chrome-extension", name: "chrome extension", createdAt: 1793288872046 },
  { id: "ag_mcp", name: "mcp", createdAt: 1793288873681 },
  { id: "ag_seo", name: "seo", createdAt: 1793288874479 },
  { id: "ag_search-product-misc", name: "Search product, misc.", createdAt: 1793290499285 },
  { id: "ag_knowledge-manager-make-llm-wiki-info-and", name: "knowledge manager (make llm-wiki info and, skills always up to date)", createdAt: 1795157087065 },
  { id: "ag_api-portal", name: "API portal", createdAt: 1795289557572 },
  { id: "ag_fable-auditor", name: "fable auditor", createdAt: 1795299242161 },
  { id: "ag_contact-finder", name: "contact finder", createdAt: 1795303337684 },
  { id: "ag_crawler-guy", name: "Crawler guy", createdAt: 1795463138204 },
  { id: "ag_devops-guy", name: "devops guy", createdAt: 1795475262748 },
  { id: "ag_product-analytics-bot", name: "product analytics bot", createdAt: 1795475620675 },
  { id: "ag_5180-designer", name: "5180 designer", createdAt: 1795605425464 },
  { id: "ag_crm-developer-vp", name: "CRM developer VP", createdAt: 1795605761967 },
  { id: "ag_vp-of-gtm", name: "VP of GTM", createdAt: 1795605884180 },
];

test("every current agent gets its own color and its own symbol", () => {
  const assigned = assignPictures(LIVE);
  assert.equal(assigned.size, LIVE.length);
  const colors = new Set([...assigned.values()].map((a) => a.swatch.bg));
  const symbols = new Set([...assigned.values()].map((a) => a.symbol));
  assert.equal(colors.size, LIVE.length);
  assert.equal(symbols.size, LIVE.length);
  assert.equal(assigned.get("ag_vp-of-gtm")?.symbol, "megaphone");
  assert.equal(assigned.get("ag_crm-developer-vp")?.symbol, "database");
  assert.equal(assigned.get("ag_crawler-guy")?.symbol, "spider");
});

test("a new agent leaves every older agent's color and symbol as they were", () => {
  const before = assignPictures(LIVE);
  const after = assignPictures([...LIVE, { id: "ag_new-crawler", name: "crawler two", createdAt: Date.now() }]);
  for (const agent of LIVE) assert.deepEqual(after.get(agent.id), before.get(agent.id), agent.name);
  const added = after.get("ag_new-crawler")!;
  assert.ok(![...before.values()].some((a) => a.swatch.bg === added.swatch.bg || a.symbol === added.symbol));
});

test("the symbol style draws the assigned symbol and color", () => {
  const assigned = assignPictures(LIVE).get("ag_vp-of-gtm")!;
  const svg = pictureSvg("symbol", "ag_vp-of-gtm", "VP of GTM", assigned);
  assert.ok(svg.includes(`fill="${assigned.swatch.bg}"`));
  assert.notEqual(svg, pictureSvg("symbol", "ag_vp-of-gtm", "VP of GTM"));
});
