import {
  Controller,
  MaxFileSizeValidator,
  ParseFilePipe,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConsumes,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiTags,
} from '@nestjs/swagger';
import { extname } from 'node:path';

import {
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
} from './const/upload.constants';
import { UploadResponseDto } from './dtos/upload-response.dto';
import { UploadService } from './upload.service';
import { FileExtensionValidator } from './validators/file-extension.validator';

@ApiTags('upload')
@Controller('upload')
export class UploadController {
  constructor(private readonly uploadService: UploadService) {}

  @Post()
  @ApiOperation({ summary: 'Upload a document' })
  @ApiConsumes('multipart/form-data')
  // OpenAPI cannot describe a multipart body via a DTO — the `binary`
  // format must be written by hand so Swagger UI renders a file input.
  @ApiBody({
    required: true,
    schema: {
      type: 'object',
      required: ['file'],
      properties: {
        file: {
          type: 'string',
          format: 'binary',
          description: `Document: ${ALLOWED_EXTENSIONS.join(', ')}`,
        },
      },
    },
  })
  @ApiOkResponse({ type: UploadResponseDto })
  @ApiBadRequestResponse({
    description: 'File is missing or has an unsupported extension',
  })
  @ApiPayloadTooLargeResponse({
    description: `File size exceeds ${MAX_FILE_SIZE_BYTES} bytes`,
  })
  @UseInterceptors(
    FileInterceptor('file', {
      // Same limit duplicated in the pipe — multer rejects huge payloads
      // before they reach the validator chain and pollute memory.
      limits: { fileSize: MAX_FILE_SIZE_BYTES },
    }),
  )
  async upload(
    @UploadedFile(
      new ParseFilePipe({
        fileIsRequired: true,
        validators: [
          new MaxFileSizeValidator({ maxSize: MAX_FILE_SIZE_BYTES }),
          new FileExtensionValidator({
            allowedExtensions: ALLOWED_EXTENSIONS,
          }),
        ],
      }),
    )
    file: Express.Multer.File,
  ): Promise<UploadResponseDto> {
    const ext = extname(file.originalname).toLowerCase();
    return this.uploadService.handleUpload(file, ext);
  }
}
