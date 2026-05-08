import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ClearinghouseCredentialController } from './clearinghouse.controller';
import { ClearinghouseCredentialService } from './credential.service';

@Module({
  imports: [AuthModule],
  providers: [ClearinghouseCredentialService],
  controllers: [ClearinghouseCredentialController],
  exports: [ClearinghouseCredentialService],
})
export class ClearinghouseModule {}
