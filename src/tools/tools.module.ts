import { Module } from '@nestjs/common';
import { BridgeKeyGuard } from './guards/bridge-key.guard';
import { InternalToolsController } from './internal-tools.controller';
import { ToolExecutorService } from './tool-executor.service';
import { AgentToolsController, ToolsController } from './tools.controller';
import { ToolsService } from './tools.service';

@Module({
  controllers: [ToolsController, AgentToolsController, InternalToolsController],
  providers: [ToolsService, ToolExecutorService, BridgeKeyGuard],
  exports: [ToolsService, BridgeKeyGuard],
})
export class ToolsModule {}
