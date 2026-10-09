/** Unsent composer text, images and the quote a Reply started, by draft key; they live for the page, so a reload drops them. */
export interface DraftAttachment { id: number; name: string; mimeType: string; size: number; data: string; url: string }
export interface Draft { text: string; images: DraftAttachment[]; quote: string | null }
export const drafts = new Map<string, Draft>();

export function hasUnsentDrafts(): boolean { return [...drafts.values()].some(draft => draft.text.trim().length > 0 || draft.images.length > 0); }
