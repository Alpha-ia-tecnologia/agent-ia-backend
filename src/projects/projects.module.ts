import { Module } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';
import { OnboardingModule } from '../onboarding/onboarding.module';
import { ProviderKeysModule } from '../provider-keys/provider-keys.module';
import { InternalProjectsController } from './internal-projects.controller';
import { ProjectAnalysisService } from './project-analysis.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { TaskListsController, TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [
    ConversationsModule,
    KnowledgeModule,
    OnboardingModule,
    ProviderKeysModule,
  ],
  controllers: [
    ProjectsController,
    TaskListsController,
    TasksController,
    InternalProjectsController,
  ],
  providers: [ProjectsService, TasksService, ProjectAnalysisService],
  exports: [ProjectsService, TasksService],
})
export class ProjectsModule {}
