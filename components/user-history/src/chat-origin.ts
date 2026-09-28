export function parsePublicOrigin(value: unknown): string | null {
  if (value === null || value === "none") return null;
  const message = "Use an HTTPS origin without a path, query, fragment or credentials, or none.";
  if (typeof value !== "string") throw new Error(message);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message); }
  if (url.protocol !== "https:" || url.hostname.includes("*") || url.username || url.password ||
    (value !== url.origin && value !== url.origin + "/")) throw new Error(message);
  return url.origin;
}

export type RemoteSetting = { mode: "tailscale" | "custom" | "off"; origin: string | null };

/** `--public-origin tailscale` follows this Mac's tailnet name, `none` turns remote access off, an HTTPS origin is fixed. */
export function parseRemoteFlag(value: string): RemoteSetting {
  if (value === "tailscale") return { mode: "tailscale", origin: null };
  const origin = parsePublicOrigin(value);
  return origin === null ? { mode: "off", origin: null } : { mode: "custom", origin };
}
