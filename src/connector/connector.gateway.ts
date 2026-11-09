import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { WebSocket } from 'ws';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from '../subscriptions/subscriptions.service';
import {
  ConnectorFolder,
  ConnectorRegistryService,
} from './connector-registry.service';

const PING_INTERVAL_MS = 30_000;
const LAST_SEEN_THROTTLE_MS = 60_000;

interface SocketState {
  companyId: string;
  connectorId: string;
  alive: boolean;
  lastSeenWrite: number;
  pingTimer: NodeJS.Timeout;
}

/** Túnel dos conectores locais. Path fora do prefixo /api (upgrade HTTP). */
@WebSocketGateway({ path: '/connector', maxPayload: 1024 * 1024 })
export class ConnectorGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(ConnectorGateway.name);
  private readonly states = new WeakMap<WebSocket, SocketState>();

  private readonly bridgeUrl: string;
  private readonly bridgeKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectorRegistryService,
    private readonly subscriptions: SubscriptionsService,
    config: ConfigService,
  ) {
    this.bridgeUrl =
      config.get<string>('BRIDGE_URL') ?? 'http://localhost:8100';
    this.bridgeKey = (config.get<string>('BRIDGE_API_KEY') ?? '').trim();
  }

  async handleConnection(client: WebSocket, req: IncomingMessage) {
    const token = this.extractToken(req);
    if (!token) return client.close(4003, 'token ausente');

    const tokenHash = createHash('sha256').update(token).digest('hex');
    const connector = await this.prisma.connector.findFirst({
      where: { tokenHash, revokedAt: null },
    });
    if (!connector) return client.close(4003, 'token inválido ou revogado');

    this.registry.register(
      connector.companyId,
      connector.id,
      connector.name,
      client,
    );
    const state: SocketState = {
      companyId: connector.companyId,
      connectorId: connector.id,
      alive: true,
      lastSeenWrite: Date.now(),
      pingTimer: setInterval(() => {
        if (!state.alive) {
          this.logger.warn(`conector ${connector.id} sem pong — encerrando`);
          client.terminate();
          return;
        }
        state.alive = false;
        client.ping();
      }, PING_INTERVAL_MS),
    };
    this.states.set(client, state);

    client.on('pong', () => {
      state.alive = true;
      void this.touch(state);
    });
    client.on(
      'message',
      (raw: Buffer) => void this.onMessage(client, state, raw),
    );

    await this.prisma.connector.update({
      where: { id: connector.id },
      data: { lastSeenAt: new Date() },
    });
    client.send(
      JSON.stringify({ type: 'hello_ok', connectorId: connector.id }),
    );
    void this.sendCredentialState(client, connector.companyId);
    this.logger.log(
      `conector ${connector.name} online (tenant ${connector.companyId})`,
    );
  }

  handleDisconnect(client: WebSocket) {
    const state = this.states.get(client);
    if (!state) return;
    clearInterval(state.pingTimer);
    this.registry.unregister(state.companyId, state.connectorId, client);
    this.logger.log(`conector ${state.connectorId} offline`);
  }

  private async onMessage(client: WebSocket, state: SocketState, raw: Buffer) {
    state.alive = true;
    let msg: { type?: string } & Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString()) as typeof msg;
    } catch {
      return;
    }
    if (msg.type === 'rpc_response') {
      this.registry.handleRpcResponse(
        msg as unknown as {
          id: string;
          ok: boolean;
          result?: unknown;
          error?: string;
        },
      );
    } else if (msg.type === 'credentials_sync') {
      await this.handleCredentialsSync(client, state, msg);
    } else if (msg.type === 'credentials_revoke') {
      await this.handleCredentialsRevoke(client, state, msg);
    } else if (msg.type === 'credentials_status_request') {
      await this.sendCredentialState(client, state.companyId);
    } else if (msg.type === 'folders_report') {
      const folders = this.sanitizeFolders(msg.folders);
      this.registry.setFolders(state.companyId, state.connectorId, folders);
      await this.prisma.connector
        .update({
          where: { id: state.connectorId },
          data: { folders: folders as unknown as Prisma.InputJsonValue },
        })
        .catch(() => undefined);
    }
    void this.touch(state);
  }

  /** Importa credenciais de assinatura vindas da máquina do cliente (opt-in).
   *  Repassa direto ao bridge (HERMES_HOME do tenant) — nunca toca o banco. */
  private async handleCredentialsSync(
    client: WebSocket,
    state: SocketState,
    msg: Record<string, unknown>,
  ) {
    const source = typeof msg.source === 'string' ? msg.source : '';
    const allowed = new Set(['claude-code', 'codex-cli', 'gh-token']);
    const reply = (ok: boolean, error?: string) =>
      client.send(
        JSON.stringify({ type: 'credentials_sync_result', source, ok, error }),
      );
    if (
      !allowed.has(source) ||
      typeof msg.payload !== 'object' ||
      msg.payload === null
    ) {
      return reply(false, 'origem ou payload inválido');
    }
    try {
      const res = await fetch(
        `${this.bridgeUrl}/tenants/${state.companyId}/auth/import`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-bridge-key': this.bridgeKey,
          },
          body: JSON.stringify({ source, payload: msg.payload }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        detail?: string;
        provider?: string;
      };
      if (!res.ok) return reply(false, data.detail ?? `HTTP ${res.status}`);
      await this.prisma.orchestrationEvent
        .create({
          data: {
            companyId: state.companyId,
            type: 'subscription_credentials_synced',
            payload: { source, connectorId: state.connectorId },
          },
        })
        .catch(() => undefined);
      // "conectar = pronto": se a empresa ainda não tem provider ativo, a
      // assinatura recém-sincronizada (ex.: Claude Code) vira o provider ativo.
      if (data.provider) {
        await this.subscriptions
          .autoActivateIfIdle(
            state.companyId,
            SubscriptionsService.bridgeToAaoProvider(data.provider),
          )
          .catch((err) =>
            this.logger.warn(`auto-ativação falhou: ${(err as Error).message}`),
          );
      }
      reply(true);
      // reflete o novo estado no checkbox do app (e de outros dispositivos)
      void this.sendCredentialState(client, state.companyId);
    } catch {
      reply(false, 'bridge indisponível');
    }
  }

  // fonte do conector (checkbox do app) -> provider AAO (formato do /activate)
  private static readonly SOURCE_TO_AAO: Record<string, string> = {
    'claude-code': 'anthropic-oauth',
    'codex-cli': 'openai-codex',
    'gh-token': 'copilot',
  };

  /** Usuário desmarcou a credencial no app → desconecta a assinatura no bridge. */
  private async handleCredentialsRevoke(
    client: WebSocket,
    state: SocketState,
    msg: Record<string, unknown>,
  ) {
    const source = typeof msg.source === 'string' ? msg.source : '';
    const provider = ConnectorGateway.SOURCE_TO_AAO[source];
    if (provider) {
      await this.subscriptions
        .disconnectProvider(state.companyId, provider)
        .catch((err) =>
          this.logger.warn(
            `revogação de ${source} falhou: ${(err as Error).message}`,
          ),
        );
    }
    void this.sendCredentialState(client, state.companyId);
  }

  /** Envia ao app a lista de fontes atualmente conectadas (espelho do checkbox). */
  private async sendCredentialState(client: WebSocket, companyId: string) {
    const connected = await this.subscriptions
      .connectedSources(companyId)
      .catch(() => [] as string[]);
    client.send(JSON.stringify({ type: 'credential_state', connected }));
  }

  private async touch(state: SocketState) {
    if (Date.now() - state.lastSeenWrite < LAST_SEEN_THROTTLE_MS) return;
    state.lastSeenWrite = Date.now();
    await this.prisma.connector
      .update({
        where: { id: state.connectorId },
        data: { lastSeenAt: new Date() },
      })
      .catch(() => undefined);
  }

  private sanitizeFolders(value: unknown): ConnectorFolder[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (f): f is { path: string; readOnly?: boolean } =>
          typeof f === 'object' &&
          f !== null &&
          typeof (f as { path?: unknown }).path === 'string',
      )
      .slice(0, 20)
      .map((f) => ({
        path: f.path.slice(0, 500),
        readOnly: Boolean(f.readOnly),
      }));
  }

  private extractToken(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice(7);
    const url = new URL(req.url ?? '/', 'http://localhost');
    return url.searchParams.get('token');
  }
}
