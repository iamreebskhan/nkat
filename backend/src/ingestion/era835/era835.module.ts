import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { Era835Controller } from './era835.controller';
import { Era835Ingestor } from './ingestor';

@Module({
  imports: [AuthModule],
  providers: [Era835Ingestor],
  controllers: [Era835Controller],
  exports: [Era835Ingestor],
})
export class Era835Module {}
