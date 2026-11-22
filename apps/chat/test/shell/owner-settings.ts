import type { APIRequestContext } from "@playwright/test";

/**
 * The owner's status, notification setting and recent searches live on the one fixture server (server/owner-settings.ts), so a spec that
 * changes them puts the defaults back before and after it, as never set.
 */
export const resetOwnerSettings = (request: APIRequestContext) => request.put("/api/owner-settings", { data: {} });

export const ownerSettings = async (request: APIRequestContext) => (await request.get("/api/owner-settings")).json();
