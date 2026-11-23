/**
 * The images a post draws (`<img data-src>`: markdown.ts `imageTag` and MessageRow's attached images) load once the calls he waits on
 * answered (client.ts `afterOwnCalls`), so their bytes never share his link with a room's or thread's open. On 11-23 at 14:12:25Z his
 * open of a reply thread drew its kept page with three screenshots and an upload at once, about 0.8 MB, and his reply open (a 2 ms handler)
 * and read mark (7 ms) waited 1,843 and 1,591 ms (work/p231-slow-calls/summary.md). An image this page showed before shows at once, from
 * the browser's cache or after a 304 with no bytes (server/local-image.ts).
 */
import { afterOwnCalls } from "$lib/api/client";

const shown = new Set<string>();

function show(img: HTMLImageElement): void {
  const src = img.dataset.src;
  if (!src || !img.isConnected || img.getAttribute("src") === src) return;
  img.src = src;
  shown.add(src);
}

function hold(img: HTMLImageElement): void {
  const src = img.dataset.src;
  if (!src || img.getAttribute("src") === src) return;
  // A blob or data URL, such as his own attached image while it sends, moves no bytes.
  if (shown.has(src) || /^(?:blob|data):/.test(src)) show(img);
  else afterOwnCalls(() => show(img));
}

function holdWithin(node: Node): void {
  if (node instanceof HTMLImageElement) hold(node);
  else if (node instanceof Element) for (const img of node.querySelectorAll<HTMLImageElement>("img[data-src]")) hold(img);
}

/** Holds every `img[data-src]` under `root` now and as it is added or its `data-src` changes. */
export function holdImages(root: Element): void {
  holdWithin(root);
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === "attributes") holdWithin(record.target);
      else for (const node of record.addedNodes) holdWithin(node);
    }
  }).observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-src"] });
}
