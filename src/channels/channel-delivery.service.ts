import { Injectable, Logger } from '@nestjs/common';
import { createTransport } from 'nodemailer';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { mdToPlain, mdToWhatsApp } from './format';
import { WhatsAppBridgeRegistry } from './whatsapp-bridge.registry';

const MAX_TEXT = 4000;

/**
 * Entrega respostas de agentes aos canais de origem (chamado pelo
 * consumeBridge). Sem dependência do ConversationsService de propósito —
 * evita ciclo de módulos.
 */
@Injectable()
export class ChannelDeliveryService {
  private readonly logger = new Logger(ChannelDeliveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly whatsappBridges: WhatsAppBridgeRegistry,
  ) {}

  /** No-op para conversas que não são de canal. */
  async deliver(conversationId: string, text: string): Promise<void> {
    if (!text.trim()) return;
    const contact = await this.prisma.channelContact.findUnique({
      where: { conversationId },
      include: { channel: true },
    });
    if (!contact || !contact.channel.isActive) return;
    try {
      await this.sendToContact(contact, text, 'Agente');
    } catch (err) {
      this.logger.warn(
        `entrega no canal falhou (${contact.channel.type}): ${(err as Error).message}`,
      );
    }
  }

  /** Envia pelo canal do contato e registra a saída no inbox. */
  async sendToContact(
    contact: {
      id: string;
      externalId: string;
      channelId: string;
      metadata: unknown;
      channel: {
        type: string;
        encryptedToken: string;
        iv: string;
        authTag: string;
        config: unknown;
      };
    },
    text: string,
    author: string,
  ): Promise<void> {
    if (contact.channel.type === 'TELEGRAM') {
      await this.sendTelegram(
        contact.channel,
        contact.externalId,
        mdToPlain(text),
      );
    } else if (contact.channel.type === 'EMAIL') {
      await this.sendEmail(contact, mdToPlain(text));
    } else if (contact.channel.type === 'WHATSAPP') {
      await this.whatsappBridges.send(
        contact.channelId,
        contact.externalId,
        mdToWhatsApp(text),
      );
    } else {
      throw new Error(`tipo de canal desconhecido: ${contact.channel.type}`);
    }
    await this.prisma.channelMessage
      .create({
        data: {
          contactId: contact.id,
          direction: 'OUT',
          author,
          content: text,
        },
      })
      .catch(() => undefined);
    await this.prisma.channelContact
      .update({
        where: { id: contact.id },
        data: { lastMessageAt: new Date() },
      })
      .catch(() => undefined);
  }

  private async sendEmail(
    contact: {
      externalId: string;
      metadata: unknown;
      channel: {
        encryptedToken: string;
        iv: string;
        authTag: string;
        config: unknown;
      };
    },
    text: string,
  ) {
    const config = contact.channel.config as {
      address: string;
      smtpHost: string;
      smtpPort: number;
    };
    const meta = (contact.metadata ?? {}) as {
      lastMessageId?: string;
      subject?: string;
    };
    const password = this.crypto.decrypt({
      encrypted: contact.channel.encryptedToken,
      iv: contact.channel.iv,
      authTag: contact.channel.authTag,
    });
    const transporter = createTransport({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.smtpPort === 465,
      auth: { user: config.address, pass: password },
    });
    const subject = meta.subject
      ? meta.subject.startsWith('Re:')
        ? meta.subject
        : `Re: ${meta.subject}`
      : 'Resposta do escritório';
    await transporter.sendMail({
      from: config.address,
      to: contact.externalId,
      subject,
      text,
      ...(meta.lastMessageId
        ? { inReplyTo: meta.lastMessageId, references: meta.lastMessageId }
        : {}),
    });
  }

  private async sendTelegram(
    channel: { encryptedToken: string; iv: string; authTag: string },
    chatId: string,
    text: string,
  ) {
    const token = this.crypto.decrypt({
      encrypted: channel.encryptedToken,
      iv: channel.iv,
      authTag: channel.authTag,
    });
    for (let i = 0; i < text.length; i += MAX_TEXT) {
      const res = await fetch(
        `https://api.telegram.org/bot${token}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text: text.slice(i, i + MAX_TEXT),
          }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    }
  }
}
