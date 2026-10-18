/** Anthropic's API refuses an image over 5 MiB of base64; 3 MiB of bytes is 4 MiB of base64. */
export const MAX_CHAT_IMAGE_BYTES = 3 * 1024 * 1024;
/** 8 MiB of image bytes is about 10.7 MiB of base64, which keeps the send under the chat server's 12 MiB request body cap. */
export const MAX_CHAT_TOTAL_IMAGE_BYTES = 8 * 1024 * 1024;
export const IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;
