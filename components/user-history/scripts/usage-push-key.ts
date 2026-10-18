import { defaultConfigPath, rotateKey } from "../src/usage/publish.ts";

/**
 * Rotate the /sieun usage push key for one target and print the hash to store in that tier's Convex.
 *   node --import tsx scripts/usage-push-key.ts <name> <siteUrl> [--disabled]
 * Then, for the same tier:
 *   npx convex run research/sieunUsage:setPushKey '{"slug":"sieun","sha256":"<printed hash>"}'
 * The key itself is written only to the 0600 config file; it is never printed.
 */
const [name, siteUrl, flag] = process.argv.slice(2);
if (!name || !siteUrl) {
  process.stderr.write("usage: node --import tsx scripts/usage-push-key.ts <name> <siteUrl> [--disabled]\n");
  process.exit(2);
}
const { sha256 } = await rotateKey({ name, siteUrl, enabled: flag !== "--disabled" });
process.stdout.write(`${defaultConfigPath()}: target ${name} has a new key\nsha256 ${sha256}\n`);
