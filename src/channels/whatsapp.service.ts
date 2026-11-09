import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ConversationsService } from '../conversations/conversations.service';
import { ChannelInboundQueue } from './inbound-queue.service';
import { PrismaService } from '../prisma/prisma.service';
import { WhatsAppBridgeRegistry } from './whatsapp-bridge.registry';

const POLL_INTERVAL_MS = 2_000;
const MAX_TEXT = 8000;

interface BridgeMessage {
  chatId?: string;
  senderName?: string;
  body?: string;
  fromMe?: boolean;
  isGroup?: boolean;
}

/**
 * WhatsApp não-oficial via bridge Baileys (fork do Hermes em
 * aao-api/whatsapp-bridge). Multitenant por PROCESSO: um bridge por canal
 * (número), com sessão isolada em disco e token de auth próprio.
 */
@Injectable()
export class WhatsAppService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly polling = new Set<string>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly registry: WhatsAppBridgeRegistry,
    private readonly queue: ChannelInboundQueue,
  ) {}

  async onModuleInit() {
    const channels = await this.prisma.channel.findMany({
      where: { type: 'WHATSAPP', isActive: true },
    });
    for (const channel of channels) this.startBridge(channel.id);
    if (channels.length)
      this.logger.log(`whatsapp: ${channels.length} bridge(s) iniciados`);
  }

  onModuleDestroy() {
    this.polling.clear();
    this.registry.stopAll();
  }

  startBridge(channelId: string) {
    this.registry.start(channelId);
    if (!this.polling.has(channelId)) {
      this.polling.add(channelId);
      void this.pollLoop(channelId);
    }
  }

  stopBridge(channelId: string) {
    this.polling.delete(channelId);
    this.registry.stop(channelId);
  }

  status(channelId: string) {
    return this.registry.status(channelId);
  }

  private async pollLoop(channelId: string) {
    // espera o bridge subir
    await new Promise((r) => setTimeout(r, 3_000));
    while (this.polling.has(channelId)) {
      try {
        const res = await this.registry.request(channelId, 'GET', '/messages');
        if (res?.ok) {
          const data = (await res.json()) as
            { messages?: BridgeMessage[] } | BridgeMessage[];
          const messages = Array.isArray(data) ? data : (data.messages ?? []);
          for (const msg of messages) {
            await this.handleInbound(channelId, msg).catch((err) =>
              this.logger.error(
                `whatsapp inbound falhou: ${(err as Error).message}`,
              ),
            );
          }
        }
      } catch {
        // bridge reiniciando/pareando — segue tentando
      }
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }

  private async handleInbound(channelId: string, msg: BridgeMessage) {
    const chatId = msg.chatId;
    const text = (msg.body ?? '').trim();
    if (!chatId || !text || msg.fromMe) return;
    if (msg.isGroup || chatId.endsWith('@g.us')) return; // MVP: só conversas diretas

    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel || !channel.isActive) return;

    const displayName = msg.senderName || chatId.split('@')[0];
    let contact = await this.prisma.channelContact.findUnique({
      where: { channelId_externalId: { channelId, externalId: chatId } },
    });
    if (!contact) {
      const owner = (
        await this.prisma.membership.findFirst({
          where: { companyId: channel.companyId, role: UserRole.OWNER },
          select: { user: true },
        })
      )?.user;
      if (!owner) return;
      const conversation = await this.prisma.conversation.create({
        data: {
          companyId: channel.companyId,
          userId: owner.id,
          title: `WhatsApp · ${displayName}`,
          metadata: { channel: 'whatsapp', externalId: chatId },
        },
      });
      contact = await this.prisma.channelContact.create({
        data: {
          channelId,
          externalId: chatId,
          name: displayName,
          conversationId: conversation.id,
        },
      });
    }

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: contact.conversationId },
      select: { userId: true },
    });
    if (!conversation) return;

    await this.prisma.channelMessage.create({
      data: {
        contactId: contact.id,
        direction: 'IN',
        content: text.slice(0, MAX_TEXT),
      },
    });
    await this.prisma.channelContact.update({
      where: { id: contact.id },
      data: { unreadCount: { increment: 1 }, lastMessageAt: new Date() },
    });
    if (!channel.autoRespond) return;

    const conversationId = contact.conversationId;
    await this.queue.run(channel.companyId, async () => {
      await this.conversations.sendMessage(
        channel.companyId,
        conversation.userId,
        conversationId,
        {
          content: text.slice(0, MAX_TEXT),
          agentId: channel.agentId ?? undefined,
        },
      );
    });
  }
}
