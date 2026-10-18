// Guards program/brief.md rules 4 and 5: articles say 180M+ creators, never 200M+ or 12M, and never promise "no credit card" or free search.
// The risk page sessions/2026/10/18/2008-seo-risks found that no duty metric read article copy for them, so a page that broke the rule stayed up.
import assert from "node:assert/strict";
import { test } from "node:test";
import { bannedCopy, readCopy, visitsOutput } from "../scripts/duties/seo-search-visits.ts";

const pages: Record<string, string> = {
  "apps/blog/content/fitness-influencers/en.md": "Virev covers 200M+ Instagram, TikTok and YouTube creators. Start a free search, no credit card required.",
  "apps/blog/content/fitness-influencers/ko.md": "Virev에서 2억 명의 크리에이터를 무료로 검색하세요. 신용카드 없이 시작합니다.",
  "apps/blog/content/fitness-influencers/ja.md": "12M creators を2億人のクリエイターから無料で検索。クレジットカード不要。",
  // Allowed: the right count, a 12M follower row, a 2億 like total, a customer's free trial and a free calculator link.
  "apps/blog/content/influencers-in-india/en.md": "Virev covers 180M+ creators.\n| Adnaan Shaikh | 12M | 0.46% |\nNo credit for a free trial. Try the free [engagement rate calculator](/tools).",
  "apps/blog/content/do-hashtags-still-work/ja.md": "いいねの合計は2億910万件でした。無料の[計算ツール](/ja/tools)。",
};

test("banned_copy counts each blog page that carries a creator count other than 180M+, \"no credit card\" or free search, and names the phrases", async () => {
  const found = bannedCopy(Object.entries(pages).map(([path, text]) => ({ path, text })));
  assert.deepEqual(found, [
    { path: "apps/blog/content/fitness-influencers/en.md", phrases: ["200M+ creators", "no credit card", "free search"] },
    { path: "apps/blog/content/fitness-influencers/ja.md", phrases: ["12M creators", "2億 クリエイター", "クレジットカード不要", "無料検索"] },
    { path: "apps/blog/content/fitness-influencers/ko.md", phrases: ["2억 크리에이터", "신용카드 없이", "무료 검색"] },
  ]);
  const read = await readCopy(async args => args[0] === "ls-tree" ? [...Object.keys(pages), "apps/blog/content/x/cover.svg"].join("\n") + "\n" : pages[args[1]!.split(":")[1]!]!);
  assert.equal(read.pages, 5);
  const output = visitsOutput({ copy: read }, 0);
  assert.equal(output.metrics.banned_copy, 3);
  assert.match(output.flagged!.find(slice => slice.kind === "banned_copy")!.excerpt, /^3 of 5 apps\/blog\/content pages .*fitness-influencers\/en\.md \(200M\+ creators, no credit card, free search\)/);
  assert.equal(visitsOutput({ copy: { error: "git ls-tree: bad ref" } }, 0).metrics.banned_copy, 999_999);
});
