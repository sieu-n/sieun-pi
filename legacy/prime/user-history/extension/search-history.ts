/** search_history for every Prime session, answered by pi-history's socket (packages/pi-history). */
import type { ExtensionAPI } from "prime-agent";
import { searchHistoryTool } from "../../../../packages/pi-history/src/pi/index.ts";

export function registerSearchHistory(pi: ExtensionAPI): void {
  pi.registerTool(searchHistoryTool());
}
