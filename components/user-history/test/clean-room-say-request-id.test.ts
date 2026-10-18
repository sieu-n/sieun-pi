// A delivered clean-room message omitted the request id needed to match its send.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

test("clean-room say logs the same request id on its sending and sent lines", async () => {
  const prompts: { method: string; route: string; requestId: unknown }[] = [];
  const srv = createServer((request, response) => {
    let body = "";
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      if (request.method === "GET") { response.end('<html data-chat-token="abc123"></html>'); return; }
      const parsed: unknown = JSON.parse(body);
      prompts.push({ method: request.method ?? "", route: request.url ?? "",
        requestId: typeof parsed === "object" && parsed !== null && "requestId" in parsed ? parsed.requestId : undefined });
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
  });
  await new Promise<void>(resolve => srv.listen(0, "127.0.0.1", resolve));
  const root = mkdtempSync(join(tmpdir(), "clean-room-say-"));
  try {
    const data = join(root, "data"), run = join(root, "run");
    mkdirSync(data); mkdirSync(run);
    writeFileSync(join(data, "instance.json"), JSON.stringify({ url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/base/` }));
    writeFileSync(join(run, "run.json"), JSON.stringify({ chat: { id: "chat-1", name: "a chat" }, seeds: [] }));
    await promisify(execFile)(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../scripts/clean-room/clean-room.ts"), "say", "--run", run, "--message", "thanks, do the next one"],
      { env: { ...process.env, AGENT_CHAT_DATA_DIR: data, CLEAN_ROOM_SESSION: "" }, timeout: 60_000 });
    assert.equal(prompts.length, 1);
    const prompt = prompts[0]!;
    assert.equal(prompt.method, "POST");
    assert.equal(prompt.route, "/base/api/threads/chat-1/prompt");
    assert.equal(typeof prompt.requestId, "string");
    const id = prompt.requestId as string;
    const lines = readFileSync(join(run, "clean-room.log"), "utf8").trim().split("\n");
    const sending = lines.filter(line => line.includes("sending the owner's message"));
    const sent = lines.filter(line => line.includes("sent the owner's message"));
    assert.equal(sending.length, 1);
    assert.equal(sent.length, 1);
    assert.ok(sending[0]!.endsWith(`sending the owner's message (request ${id})`), sending[0]);
    assert.ok(sent[0]!.endsWith(`sent the owner's message (request ${id}): thanks, do the next one`), sent[0]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    await new Promise<void>((resolve, reject) => srv.close(error => error ? reject(error) : resolve()));
  }
});
