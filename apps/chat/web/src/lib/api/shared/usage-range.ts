/** The Usage page's ranges and buckets, read by the server to bucket a report and by the page to offer them, as Prime's chat Usage page does. */
import type { UsageBucket, UsageRange } from "../types.ts";

export const USAGE_RANGES: readonly UsageRange[] = ["1h", "24h", "7d", "30d", "90d"];
export const RANGE_MS: Readonly<Record<UsageRange, number>> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000, "90d": 90 * 86_400_000 };
export const BUCKET_MS: Readonly<Record<UsageBucket, number>> = { minute: 60_000, hour: 3_600_000, day: 86_400_000 };
/** The buckets each range offers, its default first, as Prime's `bucketsFor`: no choice draws more than 1,440 bars. */
export const RANGE_BUCKETS: Readonly<Record<UsageRange, readonly UsageBucket[]>> = {
  "1h": ["minute"], "24h": ["hour", "minute"], "7d": ["hour", "day"], "30d": ["day", "hour"], "90d": ["day"],
};

export const isRange = (value: unknown): value is UsageRange => USAGE_RANGES.includes(value as UsageRange);
/** The bucket asked for when the range offers it, else the range's default. */
export const bucketFor = (range: UsageRange, asked: unknown): UsageBucket =>
  RANGE_BUCKETS[range].includes(asked as UsageBucket) ? (asked as UsageBucket) : RANGE_BUCKETS[range][0]!;
