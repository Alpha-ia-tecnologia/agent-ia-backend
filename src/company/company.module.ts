import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { ConversationsModule } from '../conversations/conversations.module';
import { UsersModule } from '../users/users.module';
import { CompanyController } from './company.controller';
import { InternalAdminController } from './internal-admin.controller';
import { InternalCompanyController } from './internal-company.controller';
import { CompanyService } from './company.service';

@Module({
  imports: [ConversationsModule, AgentsModule, UsersModule],
  controllers: [
    CompanyController,
    InternalCompanyController,
    InternalAdminController,
  ],
  providers: [CompanyService],
})
export class CompanyModule {}
