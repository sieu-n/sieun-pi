/** The composer's editable box holds text nodes, line breaks, chip spans and Slack's formatting; these helpers read and change it. */
import { writeMarkdown } from "./composer-format";

export type ChipTarget = { id: string; name: string; kind: string; self?: boolean };
export type Draft = { text: string; mentions: string[]; channels: string[] };

const CHIP = "data-chip-id";

/**
 * The draft as text, with each chip written as @name or #name, plus the ids the chips name. With `markup` the text carries the box's
 * formatting as the markdown the post renders (composer-format.ts); without it the text is bare, as the typeahead reads it.
 */
export function readDraft(root: HTMLElement, markup = true): Draft {
  const mentions: string[] = [];
  const channels: string[] = [];
  const text = writeMarkdown(root, {
    markup,
    chip: (node) => {
      const id = node.getAttribute(CHIP);
      if (!id) return null;
      const isChannel = node.dataset.chipKind === "channel";
      (isChannel ? channels : mentions).push(id);
      return `${isChannel ? "#" : "@"}${node.dataset.chipName ?? ""}`;
    },
  });
  return { text: text.replace(/\u00a0/g, " ").replace(/\s+$/, ""), mentions: [...new Set(mentions)], channels: [...new Set(channels)] };
}

/** Text from the start of the box to the caret, so the typeahead can find an open @ or # query. */
export function textBeforeCaret(root: HTMLElement): { text: string; range: Range } | null {
  const selection = root.ownerDocument.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed || !root.contains(range.startContainer)) return null;
  const before = root.ownerDocument.createRange();
  before.selectNodeContents(root);
  before.setEnd(range.startContainer, range.startOffset);
  const holder = root.ownerDocument.createElement("div");
  holder.append(before.cloneContents());
  for (const chip of holder.querySelectorAll(`[${CHIP}]`)) chip.replaceWith(CHIP_MARK);
  return { text: readDraft(holder, false).text + trailingSpace(before.toString()), range };
}

/** Stands in for a chip in the text before the caret, so the @name inside a chip never reads as an open query. */
export const CHIP_MARK = "\ufffc";

const trailingSpace = (text: string) => (/\s$/.test(text) ? " " : "");

export function chipElement(doc: Document, target: ChipTarget): HTMLElement {
  const chip = doc.createElement("span");
  chip.setAttribute(CHIP, target.id);
  chip.dataset.chipName = target.name;
  chip.dataset.chipKind = target.kind;
  chip.dataset.mentionKind = target.kind;
  chip.contentEditable = "false";
  chip.className = target.self ? "inline-chip mention self" : "inline-chip mention";
  chip.textContent = `${target.kind === "channel" ? "#" : "@"}${target.name}`;
  return chip;
}

/** Replaces the typed query (from its trigger to the caret) with a chip and a space, and puts the caret after them. */
export function insertChip(root: HTMLElement, queryLength: number, target: ChipTarget): void {
  replaceQuery(root, queryLength, [chipElement(root.ownerDocument, target), root.ownerDocument.createTextNode("\u00a0")]);
}

/** Replaces the typed query (from its trigger to the caret) with text, such as an emoji or a `/command `, and puts the caret after it. */
export function insertQueryText(root: HTMLElement, queryLength: number, text: string): void {
  replaceQuery(root, queryLength, [root.ownerDocument.createTextNode(text)]);
}

function replaceQuery(root: HTMLElement, queryLength: number, nodes: Node[]): void {
  const doc = root.ownerDocument;
  const selection = doc.getSelection();
  if (!selection || !selection.rangeCount) return;
  const caret = selection.getRangeAt(0);
  const node = caret.startContainer;
  const range = doc.createRange();
  if (node.nodeType === Node.TEXT_NODE && caret.startOffset >= queryLength + 1) {
    range.setStart(node, caret.startOffset - queryLength - 1);
    range.setEnd(node, caret.startOffset);
  } else {
    range.setStart(caret.startContainer, caret.startOffset);
    range.collapse(true);
  }
  range.deleteContents();
  for (const added of [...nodes].reverse()) range.insertNode(added);
  const after = doc.createRange();
  after.setStartAfter(nodes[nodes.length - 1]!);
  after.collapse(true);
  selection.removeAllRanges();
  selection.addRange(after);
}

/** Puts text at a range kept while focus was elsewhere, such as the emoji picker's search field, and returns the range just after it. */
export function insertTextAt(root: HTMLElement, at: Range | null, text: string): Range {
  const doc = root.ownerDocument;
  const range = at && root.contains(at.startContainer) ? at.cloneRange() : endOf(root);
  range.deleteContents();
  const node = doc.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  return range;
}

function endOf(root: HTMLElement): Range {
  const range = root.ownerDocument.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  return range;
}

/** Pastes plain text only, so styles from other pages never land in the draft. */
export function insertPlainText(root: HTMLElement, text: string): void {
  const doc = root.ownerDocument;
  const selection = doc.getSelection();
  if (!selection || !selection.rangeCount) return;
  const range = selection.getRangeAt(0);
  range.deleteContents();
  const node = doc.createTextNode(text);
  range.insertNode(node);
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
