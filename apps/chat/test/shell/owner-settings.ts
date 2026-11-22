import type { APIRequestContext } from "@playwright/test";

/**
 * The owner's status, notification setting and recent searches live on the one fixture server (server/owner-settings.ts), so a spec that
 * changes them puts the defaults back before and after it.
 */
export const resetOwnerSettings = (request: APIRequestContext) =>
  request.patch("/api/owner-settings", { data: { presence: { away: false }, notify: { level: "direct", badge: true }, recentSearches: [] } });

export const ownerSettings = async (request: APIRequestContext) => (await request.get("/api/owner-settings")).json();
