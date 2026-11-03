import { connect } from "node:net";

/**
 * The network (AS) behind each IP, from Team Cymru's bulk whois (whois.cymru.com port 43), and whether that network is a hosting or cloud
 * provider. A browser UA from a hosting network is no person at a browser: on 11-03 a plain Safari 26.0.1 UA pulled 425 /profile pages in an hour
 * from 264 IPs, most of them DigitalOcean (AS14061), and classify() in public-page-scrapers.ts read it as human.
 */
export interface Asn { asn: number; name: string; cc: string }

/**
 * Cloud and hosting networks by their AS name, the providers whose IPs the 10-29 and 11-03 scrapers came from plus the other large clouds.
 * Cloudflare, Akamai and Fastly stay out: iCloud Private Relay and Cloudflare WARP send people's browsers out through them.
 */
export const HOSTING = new RegExp([
  "DIGITALOCEAN", "AMAZON", "\\bAWS\\b", "GOOGLE-CLOUD", "MICROSOFT", "AZURE", "OVH", "HETZNER", "LINODE", "VULTR", "CHOOPA", "TENCENT",
  "ALIBABA", "ALIYUN", "ORACLE", "CONTABO", "M247", "LEASEWEB", "DATACAMP", "CDN77", "IONOS", "SCALEWAY", "HOSTINGER", "HUAWEI-CLOUD", "HWCLOUDS",
  "ZENLAYER", "CHERRY ?SERVERS", "HOSTWINDS", "COLOCROSSING", "QUADRANET", "PSYCHZ", "SERVERS\\.COM", "G-CORE", "GCORE",
  "STARK INDUSTRIES", "PQ HOSTING", "AEZA", "IP VOLUME", "\\bHOSTING\\b", "DATA ?CENT(?:ER|RE)", "\\bVPS\\b", "\\bSERVER",
].join("|"), "i");
export const isHosting = (name: string): boolean => HOSTING.test(name);

/** Rows of a verbose bulk answer, "AS | IP | prefix | CC | registry | allocated | AS name"; an NA row maps to no entry. */
export function parseCymru(text: string): Map<string, Asn> {
  const found = new Map<string, Asn>();
  for (const line of text.split("\n")) {
    const cells = line.split("|").map(cell => cell.trim());
    if (cells.length < 7 || !/^\d+$/.test(cells[0]!)) continue;
    found.set(cells[1]!, { asn: Number(cells[0]), name: cells.slice(6).join("|"), cc: cells[3]! });
  }
  return found;
}

/**
 * measured: on 11-03 a session of 10,000 IPs answered in full in 4.3 to 5.1 s, while one session of 100,655 IPs answered once in 58 s and was
 * reset (ECONNRESET) the next time, so the lookup runs one session per this many IPs, one after another.
 */
export const WHOIS_BATCH = 10_000;

/** Looks up every IP, one bulk whois session per WHOIS_BATCH IPs. Throws on a socket error or when the signal aborts. */
export async function asnOf(ips: Iterable<string>, signal: AbortSignal): Promise<Map<string, Asn>> {
  const list = [...new Set(ips)];
  const found = new Map<string, Asn>();
  for (let start = 0; start < list.length; start += WHOIS_BATCH) for (const [ip, asn] of await whoisSession(list.slice(start, start + WHOIS_BATCH), signal)) found.set(ip, asn);
  return found;
}

function whoisSession(list: readonly string[], signal: AbortSignal): Promise<Map<string, Asn>> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "whois.cymru.com", port: 43, signal });
    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("end", () => { socket.destroy(); resolve(parseCymru(Buffer.concat(chunks).toString("utf8"))); });
    // The server stops answering at the client's FIN, so the query is written without end() and the server closes after its "end" line:
    // on 11-03 an end() after 100,655 IPs got 23,118 answers, and a plain write got them all.
    socket.write(`begin\nverbose\n${list.join("\n")}\nend\n`);
  });
}
