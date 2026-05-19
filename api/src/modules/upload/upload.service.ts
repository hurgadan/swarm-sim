import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

// pdf-parse@2.x is a rewrite on top of pdfjs-dist; the legacy 1.x default
// export and its ENOENT-on-import bug are gone — now it's a class.
import { PDFParse } from 'pdf-parse';

import { UploadResponseDto } from './dtos/upload-response.dto';

const UPLOADS_DIR = resolve(process.cwd(), 'uploads');

@Injectable()
export class UploadService {
  private readonly logger = new Logger(UploadService.name);

  async handleUpload(
    file: Express.Multer.File,
    extension: string,
  ): Promise<UploadResponseDto> {
    const id = randomUUID();
    await this.saveOriginal(file.buffer, id, file.originalname);

    // TODO: persist the extracted text once we have a database. For now
    // we just compute and log it — the extraction logic is exercised on
    // every upload and any breakage shows up immediately.
    const text = await this.extractText(file.buffer, extension);

    this.logger.log(
      `Accepted "${file.originalname}" → id=${id}, ` +
        `size=${file.size}B, textLength=${text.length}`,
    );

    return {
      id,
      originalName: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      extension,
    };
  }

  private async saveOriginal(
    buffer: Buffer,
    id: string,
    originalName: string,
  ): Promise<void> {
    await mkdir(UPLOADS_DIR, { recursive: true });
    const safeName = originalName.replace(/[/\\?%*:|"<>]/g, '_');
    await writeFile(join(UPLOADS_DIR, `${id}-${safeName}`), buffer);
  }

  private async extractText(
    buffer: Buffer,
    extension: string,
  ): Promise<string> {
    switch (extension) {
      case '.txt':
      case '.md':
      case '.markdown':
        return buffer.toString('utf-8');

      case '.pdf': {
        // Wrap Buffer in a fresh Uint8Array without copying — pdf-parse v2
        // types reject the implicit Buffer cast.
        const parser = new PDFParse({
          data: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length),
        });
        try {
          const result = await parser.getText();
          // For a scanned PDF without OCR `result.text` is an empty string —
          // we treat that as "no text extracted", not as an error.
          return this.normalize(result.text ?? '');
        } catch (err) {
          this.logger.warn(
            `pdf-parse failed: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          return '';
        } finally {
          await parser.destroy().catch(() => undefined);
        }
      }

      default:
        return '';
    }
  }

  private normalize(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
  }
}
