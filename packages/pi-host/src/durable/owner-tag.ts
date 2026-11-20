/**
 * The owner tag every process of a durable thread carries, so the d2 orphan reaper (sieun-pi `legacy/prime/user-history/src/orphan-reaper.ts`)
 * can name the thread that started it.
 */
import { hostname } from "node:os";
import { fileURLToPath } from "node:url";

/** The folder of the tag-only systemd-run shim (`unit-tag/systemd-run`), first on the PATH of each kernel and each `bash` tool call. */
export const UNIT_TAG_DIR = fileURLToPath(new URL("./unit-tag", import.meta.url));

/**
 * The owner tag of a thread's processes, its kernels' and its `bash` tool calls': LC_PRIME_SESSION=<thread id>@<host>, as sieun-rules
 * kernel-own.py sets for a Prime kernel, and PATH with the shim that passes it to a systemd-run unit. ssh sends LC_* variables, so a command the thread runs on another box carries it too. The d2
 * orphan reaper stops a process once its thread is archived; on 10-31 the units vent-lat-cold and dmext-slow-b of pi threads named no owner.
 */
export function ownerTag(threadId: string, path: string, sep: string, host = hostname()): { LC_PRIME_SESSION: string; PATH: string } {
  return { LC_PRIME_SESSION: `${threadId}@${host.split(".")[0]}`, PATH: [UNIT_TAG_DIR, path].filter(Boolean).join(sep) };
}

