import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

/**
 * The lines of a text file, read as the loop asks for them. Leaving the loop early, by a return, a break or a throw, closes the file: readline's
 * close leaves its input stream open, and on 10-19 the box chat service held 564 session files open that way (137 Mac copies and 427 local
 * files, 376 MB for the Mac copies alone), from reads that stopped at a file's head.
 */
export async function* fileLines(file: string): AsyncGenerator<string, void, undefined> {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try { yield* lines; }
  finally { lines.close(); input.destroy(); }
}
