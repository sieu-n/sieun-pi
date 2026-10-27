import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Points the built-in anthropic provider at FAKE_ANTHROPIC_URL, for rigs that drive the real `pi` CLI. */
export default function (pi: ExtensionAPI): void {
  const url = process.env.FAKE_ANTHROPIC_URL;
  if (url) pi.registerProvider("anthropic", { baseUrl: url });
}
