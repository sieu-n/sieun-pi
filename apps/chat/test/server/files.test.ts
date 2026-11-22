/**
 * Any file attaches, as in Slack: a PDF or zip uploads under its own name, the post shows it as a file card in a DM, a channel and a
 * thread, the agent reads a line with its path instead of an image block, and the file opens inline or downloads, never as a page.
 * Run: cd apps/chat && node --import tsx --test --test-force-exit --test-isolation=none test/server/files.test.ts
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, describe, test } from "node:test";
import type { ImageRef, Item, TimelinePage } from "../../web/src/lib/api/types.ts";
import type { FixtureHost } from "../../server/host/fixture.ts";
import { FIXTURE_AGENTS as agents, FIXTURE_IDS as ids } from "../../server/fixture/seed.ts";
import { withFileCards, withFileNotes } from "../../server/files.ts";
import { serve } from "../../server/http.ts";
import { start, until, type Running } from "./helpers.ts";

type Message = Extract<Item, { kind: "message" }>;
const owned = (page: TimelinePage, text: string): Message[] =>
  page.items.filter((i): i is Message => i.kind === "message" && !i.id.startsWith("r:") && i.author.id === "owner" && i.text === text);

let s: Running;
let host: FixtureHost;
before(async () => {
  s = await start({ wordMs: 2 });
  host = s.host as FixtureHost;
});
after(async () => {
  await s.close();
});

const upload = async (bytes: Buffer, type: string, name: string): Promise<ImageRef> => {
  const res = await fetch(`${s.base}/api/uploads?name=${encodeURIComponent(name)}`, { method: "POST", headers: { "content-type": type }, body: new Uint8Array(bytes) });
  assert.equal(res.status, 200);
  return await res.json() as ImageRef;
};

describe("attached files", () => {
  test("a PDF uploads under its name and size, opens inline, and downloads under its name", async () => {
    const pdf = Buffer.from("%PDF-1.4\n%%EOF\n");
    const ref = await upload(pdf, "application/pdf", "Q3 리포트.pdf");
    assert.match(ref.url, /^\/api\/uploads\/[\w-]+\.pdf$/);
    assert.deepEqual([ref.mimeType, ref.name, ref.size], ["application/pdf", "Q3 리포트.pdf", pdf.length]);
    const shown = await fetch(`${s.base}${ref.url}?name=${encodeURIComponent(ref.name!)}`);
    assert.equal(shown.headers.get("content-type"), "application/pdf");
    assert.match(shown.headers.get("content-disposition")!, /^inline; filename\*=UTF-8''Q3%20%EB%A6%AC/);
    assert.deepEqual(Buffer.from(await shown.arrayBuffer()), pdf);
    const saved = await fetch(`${s.base}${ref.url}?name=x.pdf&download=1`);
    assert.match(saved.headers.get("content-disposition")!, /^attachment; filename\*=UTF-8''x\.pdf$/);
  });

  test("a file far over the 40 MB JSON body limit streams to disk whole", async () => {
    const big = Buffer.alloc(120 * 1000 * 1000, 3);
    const ref = await upload(big, "video/quicktime", "screen.mov");
    assert.deepEqual([ref.name, ref.size], ["screen.mov", big.length]);
    const res = await fetch(`${s.base}${ref.url}`);
    assert.equal(res.headers.get("content-length"), String(big.length));
    assert.equal((await res.arrayBuffer()).byteLength, big.length);
  });

  test("the server sets no time limit on a whole request, so a slow upload of a big file ends", () => {
    const server = serve(s.app);
    assert.equal(server.requestTimeout, 0);
    assert.ok(server.headersTimeout > 0);
    server.close();
  });

  test("an HTML or unknown file downloads as bytes and never renders as a page of the app", async () => {
    for (const [type, name] of [["text/html", "page.html"], ["application/octet-stream", "blob"], ["application/zip", "a.zip"]]) {
      const ref = await upload(Buffer.from("<script>alert(1)</script>"), type!, name!);
      const res = await fetch(`${s.base}${ref.url}`);
      assert.equal(res.headers.get("content-type"), "application/octet-stream", name);
      assert.match(res.headers.get("content-disposition")!, /^attachment/, name);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff", name);
    }
  });

  test("a file shows as a card in a DM, a channel and a thread, and the agent reads its path instead of an image", async () => {
    const ref = await upload(Buffer.from("a,b\n1,2\n"), "text/csv", "numbers.csv");
    const inputs: { text: string; images: number }[] = [];
    host.beforeSubmit = async (_thread, input) => {
      inputs.push({ text: input.text ?? "", images: input.images?.length ?? 0 });
    };
    const channel = (await s.send("POST", "/api/rooms", { kind: "channel", name: `files-${Date.now()}`, members: [agents.vent] })).body.id as string;
    try {
      for (const conversation of ["dm_vent", channel, ids.frontend]) {
        const text = `file ${conversation} ${Date.now()}`;
        const sent = await s.send("POST", `/api/c/${conversation}/send`, { text, images: [ref], requestId: `file-${conversation}`, mentions: conversation === channel ? [agents.vent] : [] });
        assert.equal(sent.status, 200, sent.body.error);
        const page = await until(() => s.get<TimelinePage>(`/api/c/${conversation}/items`), p => owned(p, text).length > 0);
        const [card] = owned(page, text)[0]!.images;
        assert.deepEqual({ ...card }, { url: ref.url, mimeType: "text/csv", name: "numbers.csv", size: 8 }, conversation);
        const input = await until(async () => inputs.find(i => i.text.includes(text)), i => !!i);
        assert.equal(input!.images, 0, conversation);
        const path = /\[attached file "numbers\.csv" \(text\/csv, 8 bytes\), saved on \S+ at (\S+)\]/.exec(input!.text)?.[1];
        assert.ok(path, `${conversation}: ${input!.text}`);
        assert.equal(readFileSync(path, "utf8"), "a,b\n1,2\n", conversation);
      }
    } finally {
      host.beforeSubmit = undefined;
    }
  });

  test("a TIFF image reaches the agent as a file line with its path, while a PNG goes as an image block", async () => {
    const tiff = await upload(Buffer.from("MM\0*\0\0\0\x08tiff", "latin1"), "image/tiff", "paste.tiff");
    const png = await upload(Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex"), "image/png", "dot.png");
    const inputs: { text: string; images: string[] }[] = [];
    host.beforeSubmit = async (_thread, input) => {
      inputs.push({ text: input.text ?? "", images: (input.images ?? []).map(i => i.mimeType) });
    };
    const channel = (await s.send("POST", "/api/rooms", { kind: "channel", name: `tiff-${Date.now()}`, members: [agents.vent] })).body.id as string;
    try {
      for (const conversation of ["dm_vent", channel]) {
        const text = `tiff ${conversation} ${Date.now()}`;
        const sent = await s.send("POST", `/api/c/${conversation}/send`, { text, images: [tiff, png], requestId: `tiff-${conversation}`, mentions: conversation === channel ? [agents.vent] : [] });
        assert.equal(sent.status, 200, sent.body.error);
        const input = await until(async () => inputs.find(i => i.text.includes(text)), i => !!i);
        assert.deepEqual(input!.images, ["image/png"], conversation);
        const path = /\[attached file "image" \(image\/tiff, 12 bytes\), saved on \S+ at (\S+)\]/.exec(input!.text)?.[1];
        assert.ok(path, `${conversation}: ${input!.text}`);
        assert.equal(readFileSync(path, "latin1").slice(0, 4), "MM\0*", conversation);
      }
    } finally {
      host.beforeSubmit = undefined;
    }
  });

  test("a file line goes back into a card, and text around it stays as written", () => {
    const ref: ImageRef = { url: "/api/uploads/abc-1.pdf", mimeType: "application/pdf", name: 'a "b".pdf', size: 12 };
    const image: ImageRef = { url: "/api/images/t/1/0", mimeType: "image/png" };
    const text = withFileNotes("look at this\n\nthanks", [image, ref], "us-metal02", r => `/data/images/${r.url.split("/").pop()}`);
    assert.equal(text, 'look at this\n\nthanks\n\n[attached file "a \\"b\\".pdf" (application/pdf, 12 bytes), saved on us-metal02 at /data/images/abc-1.pdf]');
    assert.deepEqual(withFileCards(text, [image]), { text: "look at this\n\nthanks", images: [image, ref] });
    assert.deepEqual(withFileCards("no file here", []), { text: "no file here", images: [] });
  });
});
