import test from "node:test";
import assert from "node:assert/strict";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import { renderChatMessages } from "../src/page.ts";

type Node = DefaultTreeAdapterMap["node"];
function nodes(node: Node): Node[] {
  return [node, ...("childNodes" in node ? node.childNodes.flatMap(nodes) : [])];
}
function render(text: string, role: "user" | "assistant" = "assistant") {
  return renderChatMessages([{ id: "native-entry", role, text, streaming: false }]);
}

test("native assistant text renders without a final marker or question pairing", () => {
  const html = renderChatMessages([
    { id: "progress", role: "assistant", text: "Provider progress", streaming: false },
    { id: "reply", role: "assistant", text: "Provider reply", streaming: false },
    { id: "live", role: "assistant", text: "Live reply", streaming: true },
  ]);
  for (const text of ["Provider progress", "Provider reply", "Live reply"]) assert(html.includes(text));
  assert(!html.includes("No marked final"));
  assert(!html.includes("Responding..."));
  assert.equal(nodes(parse(html)).filter(n => "tagName" in n && n.tagName === "details").length, 0);
});

test("hostile Markdown, HTML and message metadata stay inert", () => {
  const attacks = [
    '<script>globalThis.PWNED=true</script><img src=x onerror="PWNED=1">',
    '<iframe srcdoc="<script>alert(1)</script>"></iframe><style>body{background:url(https://evil.invalid)}</style>',
    '[quote](<https://evil.invalid/"onclick="alert(1)> "title")',
    '[js](javascript:alert%281%29) [data](data:text/html,evil) [file](file:///etc/passwd)',
    '[entity](jav&#x61;script:alert%281%29)',
    '![remote](https://evil.invalid/image.png)',
    '<https://evil.invalid> <a href="https://evil.invalid">raw link</a>',
    '<svg><a xlink:href="javascript:alert(1)">x</a></svg>',
  ];
  const html = renderChatMessages([{ id: '"><script>ATTACK</script>', role: "assistant",
    text: attacks.join("\n\n"), streaming: false }]);
  const all = nodes(parse(html));
  const forbidden = new Set(["script", "iframe", "form", "base", "object", "embed", "img", "svg", "math", "link", "a", "input", "video", "audio", "source", "style"]);
  for (const el of all) {
    if (!("tagName" in el)) continue;
    assert(!forbidden.has(el.tagName), el.tagName);
    for (const attr of el.attrs) assert(!/^(on|href$|src$|srcdoc$|action$|formaction$|style$)/i.test(attr.name), attr.name);
  }
  assert(html.includes("https://evil.invalid/image.png"));
  assert(html.includes("&lt;script&gt;globalThis.PWNED=true&lt;/script&gt;"));
});

test("Markdown headings, code, tables and long content remain readable", () => {
  const long = "longword".repeat(16000);
  const html = render('# Heading\n\n```html\n<img src=x onerror=evil>\n```\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Done\n\n' + long);
  const elements = nodes(parse(html)).filter(n => "tagName" in n);
  for (const tag of ["h1", "pre", "code", "table", "ul"]) assert(elements.some(n => n.tagName === tag));
  assert(html.includes(long));
  assert(!elements.some(n => n.tagName === "img"));
});

test("native skill arguments stay visible and instructions start collapsed", () => {
  const text = '<skill name="example" location="/skills/example/SKILL.md">\n# Instructions\nSecret instructions\n</skill>\n\nVisible argument';
  const html = render(text, "user");
  const all = nodes(parse(html));
  const details = all.find(n => "tagName" in n && n.tagName === "details");
  assert(details && "attrs" in details);
  assert(!details.attrs.some(a => a.name === "open"));
  assert(html.includes("Visible argument"));
  assert(html.indexOf("Visible argument") < html.indexOf("<details>"));
  assert(html.includes("Secret instructions"));
});
