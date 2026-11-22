/**
 * The owner's status, notification setting and recent searches, kept in state.json under `ownerSettings` so every browser and the Mac app
 * show the same ones (web/src/lib/api/shared/owner-settings.ts). Each save adds 1 to `rev` and goes to every open page as `owner_settings`.
 */
import { mergeOld, parseParts, parseSaved, type SavedSettings, type SettingsPart } from "../web/src/lib/api/shared/owner-settings.ts";
import type { Store } from "./store.ts";

export class OwnerSettingsStore {
  constructor(private readonly store: Store, private readonly sent: (settings: SavedSettings) => void) {}

  get(now = Date.now()): SavedSettings {
    return parseSaved(this.store.state.ownerSettings, now);
  }

  /** Replaces each part the body names, as the owner set it in one browser. */
  patch(body: unknown, now = Date.now()): SavedSettings {
    const parts = parseParts(body, now);
    const current = this.get(now);
    const edited = { ...current.edited };
    for (const part of Object.keys(parts) as SettingsPart[]) edited[part] = now;
    return this.save({ ...current, ...parts, rev: current.rev + 1, edited });
  }

  /**
   * Puts back a whole copy from GET, its `edited` stamps included, so a walk that changes a setting and restores it leaves each part as
   * never set when it was, and a device that has not loaded since still moves its old copy up.
   */
  replace(body: unknown, now = Date.now()): SavedSettings {
    const { presence, notify, recentSearches, edited } = parseSaved(body, now);
    return this.save({ presence, notify, recentSearches, edited, rev: this.get(now).rev + 1 });
  }

  /** Merges one browser's old localStorage copies (`mergeOld`), which it sends once on its first load after the move. */
  importOld(body: unknown, now = Date.now()): SavedSettings {
    const current = this.get(now);
    return this.save({ ...current, ...mergeOld(current, parseParts(body, now)), rev: current.rev + 1 });
  }

  private save(next: SavedSettings): SavedSettings {
    this.store.state.ownerSettings = next;
    this.store.saveState();
    this.sent(next);
    return next;
  }
}
