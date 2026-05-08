import { Module } from '@nestjs/common';
import { AuthModule } from '../../auth/auth.module';
import { Edi271Controller } from './edi271.controller';

@Module({
  imports: [AuthModule],
  controllers: [Edi271Controller],
})
export class Edi271Module {}
