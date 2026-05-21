export const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

export const ALLOWED_EXTENSIONS = ['.txt', '.md', '.markdown', '.pdf'] as const;

export type AllowedExtension = (typeof ALLOWED_EXTENSIONS)[number];
