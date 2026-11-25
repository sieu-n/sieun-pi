/**
 * Agent pictures (web/src/lib/ui/agent-picture.ts) are flat marks drawn from an agent's id and name, in one of three styles the owner picks
 * in Preferences. The owner asked on 11-25 (#sw-factory-build p218) to make the profile pictures more iconic than the old blob faces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { PICTURE_STYLES, SWATCHES, pictureSvg } from "../../web/src/lib/ui/agent-picture.ts";

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
