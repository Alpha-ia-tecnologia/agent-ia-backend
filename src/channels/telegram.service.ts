import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ConversationsService } from '../conversations/conversations.service';
import { ChannelInboundQueue } from './inbound-queue.service';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

const POLL_TIMEOUT_S = 25;
const ERROR_BACKOFF_MS = 10_000;
const MAX_TEXT = 4000;

interface TelegramUpdate {
  update_id: number;
  message?: {
    chat: { id: number; first_name?: string; username?: string; type: string };
    text?: string;
  };
}

/**
 * Canal Telegram por long-polling (getUpdates): funciona sem URL pública.
 * Cada chat externo vira uma ChannelContact→Conversation persistente; a
 * mensagem entra pelo MESMO pipeline do chat web (tools, auditoria, consumo)
 * e a resposta volta pelo bot.
 */
@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelegramService.name);
  // channelId -> controle do loop de polling
  private readonly loops = new Map<string, { stop: boolean }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly conversations: ConversationsService,
    private readonly queue: ChannelInboundQueue,
  ) {}

  async onModuleInit() {
    const channels = await this.prisma.channel.findMany({
      where: { type: 'TELEGRAM', isActive: true },
    });
    for (const channel of channels) this.startPolling(channel.id);
    if (channels.length) {
      this.logger.log(`telegram: ${channels.length} canal(is) em polling`);
    }
  }

  onModuleDestroy() {
    for (const loop of this.loops.values()) loop.stop = true;
  }

  startPolling(channelId: string) {
    if (this.loops.has(channelId)) return;
    const control = { stop: false };
    this.loops.set(channelId, control);
    void this.pollLoop(channelId, control);
  }

  stopPolling(channelId: string) {
    const loop = this.loops.get(channelId);
    if (loop) loop.stop = true;
    this.loops.delete(channelId);
  }

  /** Valida o token com getMe; retorna o username do bot. */
  async validateToken(token: string): Promise<string> {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as {
      ok: boolean;
      result?: { username?: string };
    };
    if (!data.ok || !data.result?.username) {
      throw new Error('Token inválido — confira com o @BotFather');
    }
    return data.result.username;
  }

  private async token(channelId: string): Promise<string | null> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel || !channel.isActive) return null;
    return this.crypto.decrypt({
      encrypted: channel.encryptedToken,
      iv: channel.iv,
      authTag: channel.authTag,
    });
  }

  private async pollLoop(channelId: string, control: { stop: boolean }) {
    let offset = 0;
    let firstBatch = true; // mensagens acumuladas antes do start não viram conversa
    while (!control.stop) {
      try {
        const token = await this.token(channelId);
        if (!token) break; // canal removido/desativado
        const res = await fetch(
          `https://api.telegram.org/bot${token}/getUpdates?timeout=${POLL_TIMEOUT_S}&offset=${offset}&allowed_updates=["message"]`,
          { signal: AbortSignal.timeout((POLL_TIMEOUT_S + 10) * 1000) },
        );
        const data = (await res.json()) as {
          ok: boolean;
          result?: TelegramUpdate[];
        };
        if (!data.ok) throw new Error('getUpdates retornou ok=false');
        for (const update of data.result ?? []) {
          offset = Math.max(offset, update.update_id + 1);
          if (firstBatch) continue; // só confirma o offset do backlog
          if (update.message?.text) {
            await this.handleInbound(channelId, update).catch((err) =>
              this.logger.error(
                `telegram inbound falhou: ${(err as Error).message}`,
              ),
            );
          }
        }
        if (firstBatch && (data.result?.length ?? 0) > 0) {
          this.logger.log(
            `telegram ${channelId}: ${data.result!.length} update(s) antigos ignorados no primeiro sync`,
          );
        }
        firstBatch = false;
      } catch (err) {
        if (control.stop) break;
        this.logger.warn(
          `telegram poll (${channelId}): ${(err as Error).message} — retry em ${ERROR_BACKOFF_MS / 1000}s`,
        );
        await new Promise((r) => setTimeout(r, ERROR_BACKOFF_MS));
      }
    }
    this.loops.delete(channelId);
  }

  private async handleInbound(channelId: string, update: TelegramUpdate) {
    const message = update.message!;
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel) return;
    const externalId = String(message.chat.id);
    const displayName =
      message.chat.first_name || message.chat.username || `chat ${externalId}`;

    let contact = await this.prisma.channelContact.findUnique({
      where: { channelId_externalId: { channelId, externalId } },
    });
    if (!contact) {
      // conversas de canal pertencem ao OWNER da empresa (aparece no painel dele)
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
          title: `Telegram · ${displayName}`,
          metadata: { channel: 'telegram', externalId },
        },
      });
      contact = await this.prisma.channelContact.create({
        data: {
          channelId,
          externalId,
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
        content: message.text!.slice(0, MAX_TEXT),
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
          content: message.text!.slice(0, MAX_TEXT),
          agentId: channel.agentId ?? undefined,
        },
      );
    });
  }
}
