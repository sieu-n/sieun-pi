/** The composer's editable box holds text nodes, <br> line breaks and chip spans; these helpers read and change it. */

export type ChipTarget = { id: string; name: string; kind: string; self?: boolean };
export type Draft = { text: string; mentions: string[]; channels: string[] };

const CHIP = "data-chip-id";

/** The draft as plain text, with each chip written as @name or #name, plus the ids the chips name. */
export function readDraft(root: HTMLElement): Draft {
  const mentions: string[] = [];
  const channels: string[] = [];
  let text = "";
  const walk = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) { text += node.textContent ?? ""; return; }
    if (!(node instanceof HTMLElement)) return;
    const id = node.getAttribute(CHIP);
    if (id) {
      const isChannel = node.dataset.chipKind === "channel";
      (isChannel ? channels : mentions).push(id);
      text += `${isChannel ? "#" : "@"}${node.dataset.chipName ?? ""}`;
      return;
    }
    if (node.tagName === "BR") { text += "\n"; return; }
    const block = node !== root && (node.tagName === "DIV" || node.tagName === "P");
    if (block && text && !text.endsWith("\n")) text += "\n";
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
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
  return { text: readDraft(holder).text + trailingSpace(before.toString()), range };
}

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
  const chip = chipElement(doc, target);
  const space = doc.createTextNode("\u00a0");
  range.insertNode(space);
  range.insertNode(chip);
  const after = doc.createRange();
  after.setStartAfter(space);
  after.collapse(true);
  selection.removeAllRanges();
  selection.addRange(after);
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
