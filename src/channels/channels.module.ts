import { Module, forwardRef } from '@nestjs/common';
import { ConversationsModule } from '../conversations/conversations.module';
import { ChannelDeliveryService } from './channel-delivery.service';
import { ChannelInboundQueue } from './inbound-queue.service';
import {
  ChannelsController,
  InternalChannelsController,
} from './channels.controller';
import { ChannelsService } from './channels.service';
import { EmailService } from './email.service';
import { TelegramService } from './telegram.service';
import { WhatsAppBridgeRegistry } from './whatsapp-bridge.registry';
import { WhatsAppService } from './whatsapp.service';

@Module({
  imports: [forwardRef(() => ConversationsModule)],
  controllers: [ChannelsController, InternalChannelsController],
  providers: [
    ChannelsService,
    TelegramService,
    EmailService,
    WhatsAppService,
    WhatsAppBridgeRegistry,
    ChannelDeliveryService,
    ChannelInboundQueue,
  ],
  exports: [ChannelDeliveryService],
})
export class ChannelsModule {}
