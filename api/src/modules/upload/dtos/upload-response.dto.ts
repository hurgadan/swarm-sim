import { ApiProperty } from '@nestjs/swagger';

import type { IUploadResponse } from '../../../_contracts/upload';

export class UploadResponseDto implements IUploadResponse {
  @ApiProperty({ example: 'b5bf5189-44b3-4b36-87ae-4069847f547d' })
  id!: string;

  @ApiProperty({ example: 'scenario.pdf' })
  originalName!: string;

  @ApiProperty({ example: 245678, description: 'Size in bytes' })
  size!: number;

  @ApiProperty({ example: 'application/pdf' })
  mimetype!: string;

  @ApiProperty({ example: '.pdf', description: 'Lowercased, includes the dot' })
  extension!: string;
}
