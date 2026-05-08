import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DatabaseModule } from '../database/database.module';
import { ScimAuthGuard } from './scim-auth.guard';
import { ScimDiscoveryController } from './scim-discovery.controller';
import { ScimGroupsController } from './scim-groups.controller';
import { ScimTokenController } from './scim-token.controller';
import { ScimUsersController } from './scim-users.controller';

@Module({
  imports: [AuthModule, DatabaseModule],
  providers: [ScimAuthGuard],
  controllers: [
    ScimDiscoveryController,
    ScimUsersController,
    ScimGroupsController,
    ScimTokenController,
  ],
})
export class ScimModule {}
