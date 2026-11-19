/**
 * The page's copy of the recent-message feed (GET /api/search/recent), which the Cmd K search matches at each keystroke (local-index.ts).
 * It loads once the page is idle and again at each opening, which asks only for the messages written since the newest one held.
 */
import { api } from "$lib/api";
import { LocalFeed } from "./local-index";

class RecentMessages {
  readonly feed = new LocalFeed();
  private reading: Promise<void> | undefined;

  /** Reads what the feed lacks; a read while one runs is that read, and a failed read leaves the feed as it is for the next one. */
  refresh(): void {
    this.reading ??= api.searchRecent(this.feed.newest === undefined ? {} : { after: this.feed.newest })
      .then(result => this.feed.add(result.hits), () => undefined)
      .finally(() => (this.reading = undefined));
  }
}

export const recentMessages = new RecentMessages();
