import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClientsController } from './clients.controller';

@Module({
  imports: [AuthModule],
  controllers: [ClientsController],
})
export class ClientsModule {}
