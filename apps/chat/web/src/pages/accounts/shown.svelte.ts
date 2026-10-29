import type { AccountsView } from "$lib/api/shared/types.ts";
import type { ProviderId } from "./model";

/** What the Accounts page last read and which provider it shows, so the Accounts sidebar draws the same providers and counts without a second read. */
export const accountsShown = $state<{ view: AccountsView | null; provider: ProviderId | null }>({ view: null, provider: null });
