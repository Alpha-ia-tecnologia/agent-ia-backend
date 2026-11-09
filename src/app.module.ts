import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/guards/jwt-auth.guard';
import { RolesGuard } from './auth/guards/roles.guard';
import { OrgGuard } from './auth/guards/org.guard';
import { OrgsModule } from './orgs/orgs.module';
import { InvitesModule } from './invites/invites.module';
import { CryptoModule } from './crypto/crypto.module';
import { DepartmentsModule } from './departments/departments.module';
import { AgentsModule } from './agents/agents.module';
import { ProviderKeysModule } from './provider-keys/provider-keys.module';
import { UsersModule } from './users/users.module';
import { OnboardingModule } from './onboarding/onboarding.module';
import { ConversationsModule } from './conversations/conversations.module';
import { StorageModule } from './storage/storage.module';
import { ToolsModule } from './tools/tools.module';
import { CompanyModule } from './company/company.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { ConnectorModule } from './connector/connector.module';
import { ProjectsModule } from './projects/projects.module';
import { AuditModule } from './audit/audit.module';
import { UsageModule } from './usage/usage.module';
import { DatasetsModule } from './datasets/datasets.module';
import { LearningModule } from './learning/learning.module';
import { SubscriptionsModule } from './subscriptions/subscriptions.module';
import { ChannelsModule } from './channels/channels.module';
import { MeetingsModule } from './meetings/meetings.module';
import { TrailModule } from './trail/trail.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    CryptoModule,
    AuthModule,
    DepartmentsModule,
    AgentsModule,
    ProviderKeysModule,
    UsersModule,
    OnboardingModule,
    ConversationsModule,
    StorageModule,
    ToolsModule,
    CompanyModule,
    KnowledgeModule,
    ConnectorModule,
    ProjectsModule,
    AuditModule,
    UsageModule,
    DatasetsModule,
    LearningModule,
    SubscriptionsModule,
    ChannelsModule,
    MeetingsModule,
    OrgsModule,
    InvitesModule,
    TrailModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    // organização ativa + papel atual do vínculo (antes do RolesGuard)
    { provide: APP_GUARD, useClass: OrgGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
