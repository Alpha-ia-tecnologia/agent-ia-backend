import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';
import { ChannelDeliveryService } from './channel-delivery.service';
import { EmailConfig, EmailService } from './email.service';
import { TelegramService } from './telegram.service';
import { WhatsAppService } from './whatsapp.service';

@Injectable()
export class ChannelsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly telegram: TelegramService,
    private readonly email: EmailService,
    private readonly whatsapp: WhatsAppService,
    private readonly delivery: ChannelDeliveryService,
  ) {}

  /** Contatos do inbox (área Canais), opcionalmente filtrados por tipo. */
  async inboxContacts(companyId: string, type?: string) {
    const contacts = await this.prisma.channelContact.findMany({
      where: {
        channel: { companyId, ...(type ? { type } : {}) },
      },
      include: {
        channel: {
          select: { id: true, type: true, name: true, autoRespond: true },
        },
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
      orderBy: [
        { lastMessageAt: { sort: 'desc', nulls: 'last' } },
        { createdAt: 'desc' },
      ],
      take: 200,
    });
    return contacts.map((c) => ({
      id: c.id,
      name: c.name || c.externalId,
      externalId: c.externalId,
      channel: c.channel,
      unreadCount: c.unreadCount,
      lastMessageAt: c.lastMessageAt,
      preview: c.messages[0]
        ? {
            direction: c.messages[0].direction,
            content: c.messages[0].content.slice(0, 120),
          }
        : null,
    }));
  }

  /** Thread de um contato; zera o contador de não lidas. */
  async inboxMessages(companyId: string, contactId: string) {
    const contact = await this.prisma.channelContact.findFirst({
      where: { id: contactId, channel: { companyId } },
      include: {
        channel: {
          select: { id: true, type: true, name: true, autoRespond: true },
        },
      },
    });
    if (!contact) throw new NotFoundException('Contato não encontrado');
    const messages = await this.prisma.channelMessage.findMany({
      where: { contactId },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    if (contact.unreadCount > 0) {
      await this.prisma.channelContact.update({
        where: { id: contactId },
        data: { unreadCount: 0 },
      });
    }
    return {
      contact: {
        id: contact.id,
        name: contact.name || contact.externalId,
        externalId: contact.externalId,
        channel: contact.channel,
        conversationId: contact.conversationId,
      },
      messages,
    };
  }

  /** Consulta de mensagens de canais para os agentes (tool canais_mensagens). */
  async mensagensParaAgente(
    companyId: string,
    f: { canal?: string; contato?: string; limite?: number; direcao?: string },
  ) {
    if (!companyId) return { erro: 'companyId ausente' };
    const tipo = f.canal?.toUpperCase();
    if (tipo && !['WHATSAPP', 'TELEGRAM', 'EMAIL'].includes(tipo)) {
      return {
        erro: `Canal desconhecido: ${f.canal}. Use whatsapp, telegram ou email.`,
      };
    }
    const messages = await this.prisma.channelMessage.findMany({
      where: {
        contact: {
          channel: { companyId, ...(tipo ? { type: tipo } : {}) },
          ...(f.contato
            ? {
                OR: [
                  { name: { contains: f.contato, mode: 'insensitive' } },
                  { externalId: { contains: f.contato, mode: 'insensitive' } },
                ],
              }
            : {}),
        },
        ...(f.direcao ? { direction: f.direcao.toUpperCase() } : {}),
      },
      include: {
        contact: {
          select: {
            name: true,
            externalId: true,
            channel: { select: { type: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(Math.max(f.limite ?? 50, 1), 200),
    });
    if (!messages.length) {
      return { erro: 'Nenhuma mensagem encontrada com esses filtros.' };
    }
    return {
      total: messages.length,
      mensagens: messages.map((m) => ({
        canal: m.contact.channel.type.toLowerCase(),
        contato: m.contact.name || m.contact.externalId,
        direcao: m.direction === 'IN' ? 'recebida' : 'enviada',
        autor: m.author || undefined,
        texto: m.content.slice(0, 500),
        quando: m.createdAt.toISOString(),
      })),
    };
  }

  /** Resposta manual pelo painel — sai pelo canal do contato. */
  async inboxReply(
    companyId: string,
    contactId: string,
    content: string,
    author: string,
  ) {
    const contact = await this.prisma.channelContact.findFirst({
      where: { id: contactId, channel: { companyId } },
      include: { channel: true },
    });
    if (!contact) throw new NotFoundException('Contato não encontrado');
    if (!contact.channel.isActive) {
      throw new BadRequestException('O canal deste contato está pausado');
    }
    await this.delivery.sendToContact(contact, content, author);
    return { sent: true };
  }

  async list(companyId: string) {
    const channels = await this.prisma.channel.findMany({
      where: { companyId, removedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { _count: { select: { contacts: true } } },
    });
    return channels.map((c) => ({
      id: c.id,
      type: c.type,
      name: c.name,
      agentId: c.agentId,
      isActive: c.isActive,
      autoRespond: c.autoRespond,
      contacts: c._count.contacts,
      createdAt: c.createdAt,
    }));
  }

  async createTelegram(companyId: string, token: string, agentId?: string) {
    let botUsername: string;
    try {
      botUsername = await this.telegram.validateToken(token);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const encrypted = this.crypto.encrypt(token);
    const channel = await this.prisma.channel.create({
      data: {
        companyId,
        type: 'TELEGRAM',
        name: `@${botUsername}`,
        agentId: agentId || null,
        encryptedToken: encrypted.encrypted,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        config: { botUsername },
      },
    });
    this.telegram.startPolling(channel.id);
    await this.audit(companyId, 'channel_connected', {
      type: 'TELEGRAM',
      name: channel.name,
    });
    return { id: channel.id, type: channel.type, name: channel.name };
  }

  async createEmail(
    companyId: string,
    dto: EmailConfig & { password: string; agentId?: string },
  ) {
    const config: EmailConfig = {
      address: dto.address.trim().toLowerCase(),
      imapHost: dto.imapHost.trim(),
      imapPort: Number(dto.imapPort) || 993,
      smtpHost: dto.smtpHost.trim(),
      smtpPort: Number(dto.smtpPort) || 587,
    };
    try {
      await this.email.validate(config, dto.password);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    const encrypted = this.crypto.encrypt(dto.password);
    const channel = await this.prisma.channel.create({
      data: {
        companyId,
        type: 'EMAIL',
        name: config.address,
        agentId: dto.agentId || null,
        // e-mail entra em modo INBOX (agente não responde sozinho). O usuário
        // ativa a resposta automática quando quiser. Os agentes ainda podem
        // consultar/relatar/responder perguntas sobre os e-mails via ferramenta.
        autoRespond: false,
        encryptedToken: encrypted.encrypted,
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        config: config as unknown as Prisma.InputJsonValue,
      },
    });
    this.email.startPolling(channel.id);
    await this.audit(companyId, 'channel_connected', {
      type: 'EMAIL',
      name: channel.name,
    });
    return { id: channel.id, type: channel.type, name: channel.name };
  }

  async createWhatsApp(companyId: string, agentId?: string) {
    // sem segredo externo: a "credencial" é a sessão em disco do bridge
    const placeholder = this.crypto.encrypt('whatsapp-session');
    const count = await this.prisma.channel.count({
      where: { companyId, type: 'WHATSAPP', removedAt: null },
    });
    const channel = await this.prisma.channel.create({
      data: {
        companyId,
        type: 'WHATSAPP',
        name: `WhatsApp ${count + 1}`,
        agentId: agentId || null,
        encryptedToken: placeholder.encrypted,
        iv: placeholder.iv,
        authTag: placeholder.authTag,
        config: {},
      },
    });
    this.whatsapp.startBridge(channel.id);
    await this.audit(companyId, 'channel_connected', {
      type: 'WHATSAPP',
      name: channel.name,
    });
    return { id: channel.id, type: channel.type, name: channel.name };
  }

  /** Estado do pareamento (QR) — proxy do bridge para a UI. */
  async whatsappStatus(companyId: string, id: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id, companyId, type: 'WHATSAPP' },
    });
    if (!channel) throw new NotFoundException('Canal não encontrado');
    return this.whatsapp.status(id);
  }

  async update(
    companyId: string,
    id: string,
    dto: { isActive?: boolean; agentId?: string | null; autoRespond?: boolean },
  ) {
    const channel = await this.prisma.channel.findFirst({
      where: { id, companyId },
    });
    if (!channel) throw new NotFoundException('Canal não encontrado');
    const updated = await this.prisma.channel.update({
      where: { id },
      data: {
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.agentId !== undefined ? { agentId: dto.agentId } : {}),
        ...(dto.autoRespond !== undefined
          ? { autoRespond: dto.autoRespond }
          : {}),
      },
    });
    if (channel.type === 'WHATSAPP') {
      if (dto.isActive === false) this.whatsapp.stopBridge(id);
      if (dto.isActive === true) this.whatsapp.startBridge(id);
    } else {
      const poller = channel.type === 'EMAIL' ? this.email : this.telegram;
      if (dto.isActive === false) poller.stopPolling(id);
      if (dto.isActive === true) poller.startPolling(id);
    }
    return {
      id: updated.id,
      isActive: updated.isActive,
      agentId: updated.agentId,
    };
  }

  async remove(companyId: string, id: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id, companyId, removedAt: null },
    });
    if (!channel) throw new NotFoundException('Canal não encontrado');
    if (channel.type === 'WHATSAPP') this.whatsapp.stopBridge(id);
    else
      (channel.type === 'EMAIL' ? this.email : this.telegram).stopPolling(id);
    // soft delete: para de receber e some da lista, mas preserva o histórico
    // (contatos/mensagens) no inbox — um hard delete cascatearia e apagaria tudo.
    await this.prisma.channel.update({
      where: { id },
      data: { isActive: false, removedAt: new Date() },
    });
    await this.audit(companyId, 'channel_removed', {
      type: channel.type,
      name: channel.name,
    });
    return { removed: true };
  }

  private audit(
    companyId: string,
    type: string,
    payload: Record<string, unknown>,
  ) {
    return this.prisma.orchestrationEvent
      .create({
        data: { companyId, type, payload: payload as Prisma.InputJsonValue },
      })
      .catch(() => undefined);
  }
}
