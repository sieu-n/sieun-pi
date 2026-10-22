import type { Reader } from "../otlp.ts";
import { read as tokens } from "./tokens.ts";
import { read as chat_health } from "./chat-health.ts";
import { read as delivery } from "./delivery.ts";
import { read as pool } from "./pool.ts";
import { read as duties } from "./duties.ts";
import { read as alerts_releases } from "./alerts-releases.ts";
import { read as memory_mac } from "./memory-mac.ts";
import { read as messaging } from "./messaging.ts";
import { read as jobs } from "./jobs.ts";
import { read as latency } from "./latency.ts";

/** Every reader, by signal group; a group's failure drops only its own samples that round. */
export const READERS: Record<string, Reader> = { "tokens": tokens, "chat-health": chat_health, "delivery": delivery, "pool": pool, "duties": duties, "alerts-releases": alerts_releases, "memory-mac": memory_mac, "messaging": messaging, "jobs": jobs, "latency": latency };
