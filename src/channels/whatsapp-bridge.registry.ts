import { Injectable, Logger } from '@nestjs/common';
import { ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { PrismaService } from '../prisma/prisma.service';

const BASE_PORT = 42_100;
const MAX_TEXT = 8000;

interface BridgeRuntime {
  process: ChildProcess;
  port: number;
  token: string;
  stop: boolean;
}

/**
 * Processos do bridge Baileys (fork do Hermes): 1 por canal/número, sessão
 * isolada em disco, auth por token. Sem dependência de outros serviços —
 * usado tanto pelo poller quanto pela entrega de respostas.
 */
@Injectable()
export class WhatsAppBridgeRegistry {
  private readonly logger = new Logger(WhatsAppBridgeRegistry.name);
  private readonly bridges = new Map<string, BridgeRuntime>();
  private readonly bridgeDir = path.resolve(__dirname, '../../whatsapp-bridge');
  private readonly sessionsDir = path.resolve(__dirname, '../../data/whatsapp');
  private nextPort = BASE_PORT;

  constructor(private readonly prisma: PrismaService) {}

  isRunning(channelId: string): boolean {
    return this.bridges.has(channelId);
  }

  start(channelId: string) {
    if (this.bridges.has(channelId)) return;
    const port = this.nextPort++;
    const token = randomBytes(24).toString('hex');
    const sessionPath = path.join(this.sessionsDir, channelId);
    mkdirSync(sessionPath, { recursive: true, mode: 0o700 });

    const child = spawn(
      process.execPath,
      [
        path.join(this.bridgeDir, 'bridge.js'),
        '--port',
        String(port),
        '--session',
        sessionPath,
      ],
      {
        cwd: this.bridgeDir,
        env: {
          ...process.env,
          AAO_BRIDGE_TOKEN: token,
          // canal de atendimento: recebe de QUALQUER cliente. O default do fork
          // Hermes é 'self-chat' + allowlist vazia = rejeita todo mundo.
          WHATSAPP_MODE: 'bot',
          WHATSAPP_ALLOWED_USERS: '*',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const runtime: BridgeRuntime = { process: child, port, token, stop: false };
    this.bridges.set(channelId, runtime);

    child.stderr?.on('data', (d: Buffer) =>
      this.logger.warn(
        `[wa ${channelId.slice(-6)}] ${d.toString().trim().slice(0, 200)}`,
      ),
    );
    child.on('exit', (code) => {
      this.bridges.delete(channelId);
      if (!runtime.stop) {
        this.logger.warn(
          `bridge ${channelId} saiu (code ${code}) — reinicia em 10s`,
        );
        setTimeout(() => {
          void this.prisma.channel
            .findFirst({ where: { id: channelId, isActive: true } })
            .then((c) => c && this.start(channelId));
        }, 10_000);
      }
    });
    this.logger.log(`bridge do canal ${channelId} na porta ${port}`);
  }

  stop(channelId: string) {
    const runtime = this.bridges.get(channelId);
    if (!runtime) return;
    runtime.stop = true;
    runtime.process.kill('SIGTERM');
    this.bridges.delete(channelId);
  }

  stopAll() {
    for (const id of [...this.bridges.keys()]) this.stop(id);
  }

  async request(
    channelId: string,
    method: string,
    route: string,
    body?: unknown,
  ): Promise<Response | null> {
    const runtime = this.bridges.get(channelId);
    if (!runtime) return null;
    return fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: {
        'x-bridge-token': runtime.token,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
  }

  async status(
    channelId: string,
  ): Promise<{ state: string; qr: string | null }> {
    try {
      const res = await this.request(channelId, 'GET', '/qr');
      if (!res) return { state: 'stopped', qr: null };
      return (await res.json()) as { state: string; qr: string | null };
    } catch {
      return { state: 'starting', qr: null };
    }
  }

  async send(
    channelId: string,
    chatId: string,
    message: string,
  ): Promise<void> {
    for (let i = 0; i < message.length; i += MAX_TEXT) {
      const res = await this.request(channelId, 'POST', '/send', {
        chatId,
        message: message.slice(i, i + MAX_TEXT),
      });
      if (!res) throw new Error('bridge não está rodando');
      if (!res.ok) throw new Error(`bridge /send HTTP ${res.status}`);
    }
  }
}
