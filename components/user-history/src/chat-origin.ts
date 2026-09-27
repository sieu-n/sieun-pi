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
