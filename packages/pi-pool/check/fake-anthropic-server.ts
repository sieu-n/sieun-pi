/**
 * The fake Anthropic server as its own process, for rigs that drive the real `pi` CLI.
 *   FAKE_ANSWERS='[{"status":200,"text":"hi"}]' FAKE_LOG=<file> node --import tsx pi-pool/check/fake-anthropic-server.ts <port file>
 * Writes its URL to the port file and one JSON line per request to FAKE_LOG.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { fakeAnthropic, type Answer } from "./rig.ts";

const answers = JSON.parse(process.env.FAKE_ANSWERS ?? "[]") as Answer[];
const server = await fakeAnthropic(answers);
const log = process.env.FAKE_LOG;
server.server.on("request", req => req.on("end", () => {
  const seen = server.seen.at(-1);
  if (log && seen) appendFileSync(log, JSON.stringify({ ...seen, authorization: seen.authorization?.slice(0, 24), system: seen.system.slice(0, 200) }) + "\n");
}));
writeFileSync(process.argv[2], server.url);
