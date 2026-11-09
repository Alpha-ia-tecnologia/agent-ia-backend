import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { ImapFlow } from 'imapflow';
import { simpleParser, type HeaderValue } from 'mailparser';
import { ConversationsService } from '../conversations/conversations.service';
import { ChannelInboundQueue } from './inbound-queue.service';
import { CryptoService } from '../crypto/crypto.service';
import { PrismaService } from '../prisma/prisma.service';

const POLL_INTERVAL_MS = 30_000;
const ERROR_BACKOFF_MS = 60_000;
const MAX_TEXT = 8000;

export interface EmailConfig {
  address: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
}

/** Remetentes automáticos/de sistema — nunca viram conversa nem resposta. */
const BLOCKED_SENDER =
  /no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce|notification|newsletter|marketing|mailing|comunicad|@(?:e|email|mail|news|info|updates|reply)\./i;

/** Precedências que indicam envio em massa/automático. */
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk', 'auto_reply']);

/** Texto de um cabeçalho: o mailparser devolve alguns como objeto estruturado
 *  ({ value, params }) — String() viraria "[object Object]". */
function headerText(value: HeaderValue | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((v) => (typeof v === 'string' ? v : '')).join(', ');
  }
  if (value && typeof value === 'object' && 'value' in value) {
    return typeof value.value === 'string' ? value.value : '';
  }
  return '';
}

/**
 * Canal de e-mail: poll IMAP (não-lidos) por canal ativo; cada remetente
 * vira uma conversa contínua; a resposta sai por SMTP como reply do thread.
 * Multi-conta por empresa: um Channel por caixa de e-mail.
 */
@Injectable()
export class EmailService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EmailService.name);
  private readonly loops = new Map<string, { stop: boolean }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly conversations: ConversationsService,
    private readonly queue: ChannelInboundQueue,
  ) {}

  async onModuleInit() {
    const channels = await this.prisma.channel.findMany({
      where: { type: 'EMAIL', isActive: true },
    });
    for (const channel of channels) this.startPolling(channel.id);
    if (channels.length)
      this.logger.log(`email: ${channels.length} caixa(s) em polling`);
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

  /** Valida credenciais conectando no IMAP uma vez. */
  async validate(config: EmailConfig, password: string): Promise<void> {
    const client = this.imapClient(config, password);
    try {
      await client.connect();
    } catch (err) {
      throw new Error(this.describeImapError((err as Error).message));
    } finally {
      await client.logout().catch(() => undefined);
    }
  }

  /** Traduz o erro cru do IMAP em uma orientação acionável para o usuário. */
  private describeImapError(raw: string): string {
    const m = raw || '';
    if (
      /authenticationfailed|invalid credentials|auth\w* fail|login failed|application-specific password|username and password not accepted|\[AUTHENTICATIONFAILED\]/i.test(
        m,
      )
    ) {
      return 'Falha de autenticação. Use uma senha de aplicativo (não a senha normal da conta) e confirme que o acesso IMAP está habilitado no provedor.';
    }
    if (/enotfound|getaddrinfo|eai_again|dns/i.test(m)) {
      return 'Servidor IMAP não encontrado. Confira o endereço do servidor de entrada (ex.: imap.gmail.com).';
    }
    if (
      /etimedout|timed? ?out|econnrefused|econnreset|ehostunreach|enetunreach/i.test(
        m,
      )
    ) {
      return 'Não foi possível alcançar o servidor IMAP. Verifique o servidor, a porta (993 para SSL) e a conexão de rede.';
    }
    if (/certificate|self.?signed|tls|ssl|wrong version number/i.test(m)) {
      return 'Erro de TLS/SSL no servidor IMAP. Verifique a porta (993 para conexão segura).';
    }
    return `Não foi possível conectar no IMAP: ${m.slice(0, 150)}`;
  }

  private imapClient(config: EmailConfig, password: string): ImapFlow {
    return new ImapFlow({
      host: config.imapHost,
      port: config.imapPort,
      secure: config.imapPort === 993,
      auth: { user: config.address, pass: password },
      logger: false,
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
    });
  }

  private async pollLoop(channelId: string, control: { stop: boolean }) {
    while (!control.stop) {
      try {
        const channel = await this.prisma.channel.findUnique({
          where: { id: channelId },
        });
        if (!channel || !channel.isActive) break;
        const config = channel.config as unknown as EmailConfig;
        const password = this.crypto.decrypt({
          encrypted: channel.encryptedToken,
          iv: channel.iv,
          authTag: channel.authTag,
        });

        const client = this.imapClient(config, password);
        await client.connect();
        try {
          const lock = await client.getMailboxLock('INBOX');
          try {
            const unseen = await client.search({ seen: false });
            // primeiro sync: e-mails ANTERIORES à conexão não viram conversa —
            // marca tudo como lido e só processa o que chegar daqui em diante
            const cfg = channel.config as Record<string, unknown>;
            if (!cfg.initialSyncDone) {
              // uma chamada só: caixas com milhares de não-lidos travariam
              // o primeiro sync por horas se marcados um a um
              if (Array.isArray(unseen) && unseen.length) {
                await client
                  .messageFlagsAdd({ seen: false }, ['\\Seen'])
                  .catch(() => undefined);
              }
              await this.prisma.channel.update({
                where: { id: channel.id },
                data: { config: { ...cfg, initialSyncDone: true } as never },
              });
              this.logger.log(
                `email ${channel.name}: primeiro sync — ${(unseen || []).length} antigos ignorados`,
              );
              lock.release();
              await client.logout().catch(() => undefined);
              await this.sleep(POLL_INTERVAL_MS, control);
              continue;
            }
            for (const uid of (unseen || []).slice(0, 20)) {
              if (control.stop) break;
              const raw = await client.download(String(uid), undefined, {
                uid: false,
              });
              const parsed = await simpleParser(raw.content);
              // marca como lida ANTES de processar: falha no agente não pode
              // virar loop de reprocessamento infinito
              await client.messageFlagsAdd(String(uid), ['\\Seen']);
              const h = parsed.headers;
              await this.handleInbound(
                channel.id,
                channel.companyId,
                channel.agentId,
                config,
                {
                  from: parsed.from?.value?.[0]?.address ?? '',
                  fromName: parsed.from?.value?.[0]?.name ?? '',
                  subject: parsed.subject ?? '(sem assunto)',
                  text: (parsed.text ?? '').trim(),
                  messageId: parsed.messageId ?? '',
                  autoSubmitted: headerText(h.get('auto-submitted')),
                  // sinais fortes de e-mail em massa/marketing/automático
                  listUnsubscribe: h.has('list-unsubscribe'),
                  listId: h.has('list-id'),
                  autoRespSuppress: h.has('x-auto-response-suppress'),
                  precedence: headerText(h.get('precedence'))
                    .toLowerCase()
                    .trim(),
                },
              ).catch((err) =>
                this.logger.error(
                  `email inbound falhou: ${(err as Error).message}`,
                ),
              );
            }
          } finally {
            lock.release();
          }
        } finally {
          await client.logout().catch(() => undefined);
        }
        await this.sleep(POLL_INTERVAL_MS, control);
      } catch (err) {
        if (control.stop) break;
        this.logger.warn(
          `email poll (${channelId}): ${(err as Error).message.slice(0, 150)} — retry em ${ERROR_BACKOFF_MS / 1000}s`,
        );
        await this.sleep(ERROR_BACKOFF_MS, control);
      }
    }
    this.loops.delete(channelId);
  }

  private sleep(ms: number, control: { stop: boolean }) {
    return new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (control.stop) {
          clearInterval(timer);
          resolve();
        }
      }, 500);
      setTimeout(() => {
        clearInterval(timer);
        resolve();
      }, ms);
    });
  }

  private async handleInbound(
    channelId: string,
    companyId: string,
    agentId: string | null,
    config: EmailConfig,
    mail: {
      from: string;
      fromName: string;
      subject: string;
      text: string;
      messageId: string;
      autoSubmitted: string;
      listUnsubscribe: boolean;
      listId: boolean;
      autoRespSuppress: boolean;
      precedence: string;
    },
  ) {
    const sender = mail.from.toLowerCase();
    if (!sender || !mail.text) return;
    if (sender === config.address.toLowerCase()) return; // a própria caixa
    // Bulk/marketing/no-reply: NUNCA vira conversa nem resposta. Os cabeçalhos
    // são o sinal confiável (promoção de endereço "normal" não casaria o regex).
    if (
      mail.listUnsubscribe ||
      mail.listId ||
      mail.autoRespSuppress ||
      BULK_PRECEDENCE.has(mail.precedence) ||
      (mail.autoSubmitted && mail.autoSubmitted.toLowerCase() !== 'no') ||
      BLOCKED_SENDER.test(sender)
    ) {
      return;
    }

    let contact = await this.prisma.channelContact.findUnique({
      where: { channelId_externalId: { channelId, externalId: sender } },
    });
    if (!contact) {
      const owner = (
        await this.prisma.membership.findFirst({
          where: { companyId, role: UserRole.OWNER },
          select: { user: true },
        })
      )?.user;
      if (!owner) return;
      const conversation = await this.prisma.conversation.create({
        data: {
          companyId,
          userId: owner.id,
          title: `E-mail · ${mail.fromName || sender}`,
          metadata: { channel: 'email', externalId: sender },
        },
      });
      contact = await this.prisma.channelContact.create({
        data: {
          channelId,
          externalId: sender,
          name: mail.fromName || sender,
          conversationId: conversation.id,
        },
      });
    }
    // guarda o thread p/ a resposta sair como reply
    await this.prisma.channelContact.update({
      where: { id: contact.id },
      data: {
        metadata: {
          lastMessageId: mail.messageId,
          subject: mail.subject,
        },
      },
    });

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: contact.conversationId },
      select: { userId: true },
    });
    if (!conversation) return;

    const content = `Assunto: ${mail.subject}\n\n${mail.text}`.slice(
      0,
      MAX_TEXT,
    );
    // registro do inbox (área Canais)
    await this.prisma.channelMessage.create({
      data: { contactId: contact.id, direction: 'IN', content },
    });
    await this.prisma.channelContact.update({
      where: { id: contact.id },
      data: { unreadCount: { increment: 1 }, lastMessageAt: new Date() },
    });

    const channelRow = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channelRow?.autoRespond) return; // modo caixa de entrada: sem agente

    const conversationId = contact.conversationId;
    await this.queue.run(companyId, async () => {
      await this.conversations.sendMessage(
        companyId,
        conversation.userId,
        conversationId,
        {
          content,
          agentId: agentId ?? undefined,
        },
      );
    });
  }
}
