import { FileValidator } from '@nestjs/common';
import { extname } from 'node:path';

interface FileExtensionValidatorOptions {
  allowedExtensions: readonly string[];
}

// We don't use the built-in FileTypeValidator: it checks `file.mimetype`,
// which browsers fill in inconsistently (e.g. `.md` may arrive as
// `text/markdown`, `application/octet-stream`, or blank).
export class FileExtensionValidator extends FileValidator<
  FileExtensionValidatorOptions,
  Express.Multer.File
> {
  isValid(file?: Express.Multer.File): boolean {
    if (!file) return false;
    const ext = extname(file.originalname).toLowerCase();
    return this.validationOptions.allowedExtensions.includes(ext);
  }

  buildErrorMessage(file?: Express.Multer.File): string {
    const ext = file ? extname(file.originalname).toLowerCase() : '';
    return (
      `Unsupported extension "${ext || 'unknown'}". ` +
      `Allowed: ${this.validationOptions.allowedExtensions.join(', ')}`
    );
  }
}
