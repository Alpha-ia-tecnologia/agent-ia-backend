import { Module } from '@nestjs/common';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module';
import { ConnectorGateway } from './connector.gateway';
import { ConnectorRegistryService } from './connector-registry.service';
import { ConnectorsController } from './connectors.controller';
import { ConnectorsService } from './connectors.service';
import { InternalConnectorController } from './internal-connector.controller';

@Module({
  imports: [SubscriptionsModule],
  controllers: [ConnectorsController, InternalConnectorController],
  providers: [ConnectorGateway, ConnectorRegistryService, ConnectorsService],
  exports: [ConnectorRegistryService],
})
export class ConnectorModule {}
