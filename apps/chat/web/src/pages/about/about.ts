/** Pure helpers for the About page: the commit link of a sha, whether npm holds a newer Pi than a box loads, and when an away box was read. */

export const REPO_URL = "https://github.com/sieu-n/sieun-pi";

export const commitUrl = (sha: string): string => `${REPO_URL}/commit/${sha}`;

export const short = (sha: string): string => sha.slice(0, 7);

/** Whether `latest` is a higher x.y.z than `used`, so "1.6.1" is newer than "1.4.0"; a pre-release tag after the numbers is ignored. */
export function newer(latest: string, used: string): boolean {
  const parts = (version: string): number[] => version.split(/[-+]/)[0]!.split(".").map(part => Number(part) || 0);
  const [a, b] = [parts(latest), parts(used)];
  for (let at = 0; at < Math.max(a.length, b.length); at += 1) {
    const diff = (a[at] ?? 0) - (b[at] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

const two = (n: number): string => String(n).padStart(2, "0");

/**
 * When a box was last read, in the viewer's time: "06:00" when the read is from today, else "11-26 06:00", so a read from an earlier day
 * never looks like today's (the Mac's 11-25 read showed as "last read 06:00" on 11-27).
 */
export function readAtLabel(at: number, now: number = Date.now()): string {
  const read = new Date(at);
  const time = `${two(read.getHours())}:${two(read.getMinutes())}`;
  return read.toDateString() === new Date(now).toDateString() ? time : `${two(read.getMonth() + 1)}-${two(read.getDate())} ${time}`;
}
