import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { TrailModule } from '../trail/trail.module';
import { InvitesController, OrgInvitesController } from './invites.controller';
import { InvitesService } from './invites.service';

@Module({
  imports: [AuthModule, TrailModule],
  controllers: [OrgInvitesController, InvitesController],
  providers: [InvitesService],
})
export class InvitesModule {}
