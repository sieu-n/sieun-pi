/**
 * The process rlm.test.ts kills: it opens a thread with Prime's ipython, sets `x` in one cell and starts a second cell that writes a marker
 * file and sleeps, so the test can SIGKILL it mid-cell.
 *
 *   node --import tsx pi-host/test/durable/rlm-worker.ts <dir> <thread file> <marker>
 */
import { DurableRlm } from "../../src/durable/rlm.ts";
import { cell, context, lastText, openThread, rlmOptions, say } from "./rlm-rig.ts";

const [dir, file, marker] = process.argv.slice(2);
if (!dir || !file || !marker) throw new Error("usage: rlm-worker.ts <dir> <thread file> <marker>");
const rlm = await DurableRlm.load(rlmOptions(dir));
const { root } = await openThread(file, "restart", rlm, ({ messages }) => {
  const last = lastText(messages);
  if (last === "set x then sleep") return cell("x = 41\nprint('x set')");
  if (last.includes("x set")) return cell(`import asyncio, os\nopen(${JSON.stringify(marker)}, "w").write(str(os.getpid()))\nawait asyncio.sleep(600)`);
  return say("unexpected");
}, dir);
await root.submit({ type: "input", content: "set x then sleep", requestId: "restart-1" }, context);
process.stdout.write("submitted\n");
await new Promise(() => {});
