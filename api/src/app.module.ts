import { Module } from '@nestjs/common';
import { UploadModule } from './modules/upload/upload.module';

@Module({
  imports: [UploadModule],
})
export class AppModule {}
