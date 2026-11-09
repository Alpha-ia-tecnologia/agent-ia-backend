import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface BridgeEvent {
  type:
    | 'session_started'
    | 'agent_status'
    | 'agent_delegation'
    | 'tool_call'
    | 'tool_call_update'
    | 'token_chunk'
    | 'thought_chunk'
    | 'usage'
    | 'final_message'
    | 'error'
    /** só no SSE: mantém a conexão viva e prova à web que o turno segue */
    | 'ping';
  session_id?: string;
  agent_id?: string;
  text?: string;
  data?: Record<string, unknown>;
}

export interface BridgeToolDefinition {
  name: string;
  description: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  params_schema: Record<string, unknown>;
  timeout_ms: number;
}

export interface BridgeSandbox {
  mode: 'workspace' | 'custom' | 'free';
  path?: string;
}

export interface BridgeChatRequest {
  tenant_id: string;
  session_id?: string;
  message: string;
  file_paths: string[];
  tools: BridgeToolDefinition[];
  sandbox: BridgeSandbox;
  agent: { agent_id: string; name: string; system_prompt: string };
  provider: BridgeProvider;
  /**
   * Provedor padrão da empresa (vai no config do processo Hermes). Quando
   * `provider` difere (agente com provedor próprio, chave reserva), o bridge
   * aplica `provider` só na sessão, sem reiniciar o processo.
   */
  tenant_provider?: BridgeProvider;
}

export interface BridgeProvider {
  provider: string;
  model: string;
  api_key: string;
  base_url?: string;
  temperature?: number;
}

@Injectable()
export class BridgeService {
  private readonly logger = new Logger(BridgeService.name);
  private readonly url: string;
  private readonly apiKey: string;

  constructor(config: ConfigService) {
    this.url = config.get<string>('BRIDGE_URL') ?? 'http://localhost:8100';
    this.apiKey = (config.get<string>('BRIDGE_API_KEY') ?? '').trim();
  }

  /** Pré-aquece a instância Hermes do tenant (fire-and-forget). */
  async warmup(
    tenantId: string,
    provider: BridgeChatRequest['provider'],
    systemPrompt: string,
    sandbox: BridgeSandbox,
  ): Promise<void> {
    try {
      await fetch(`${this.url}/tenants/${tenantId}/warmup`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-bridge-key': this.apiKey,
        },
        body: JSON.stringify({
          provider,
          system_prompt: systemPrompt,
          sandbox,
        }),
      });
    } catch (err) {
      this.logger.warn(`warmup falhou: ${(err as Error).message}`);
    }
  }

  /** Derruba a instância Hermes do tenant (re-provisiona no próximo uso). */
  async stopTenant(tenantId: string): Promise<void> {
    try {
      await fetch(`${this.url}/tenants/${tenantId}/stop`, {
        method: 'POST',
        headers: { 'x-bridge-key': this.apiKey },
      });
    } catch (err) {
      this.logger.warn(`stopTenant falhou: ${(err as Error).message}`);
    }
  }

  /** Lista as habilidades aprendidas pelos agentes do tenant. */
  async listSkills(tenantId: string): Promise<{
    skills: {
      name: string;
      description: string;
      version: string;
      archived: boolean;
      updatedAt: number;
      content: string;
    }[];
  }> {
    const res = await fetch(`${this.url}/tenants/${tenantId}/skills`, {
      headers: { 'x-bridge-key': this.apiKey },
    });
    if (!res.ok) throw new Error(`bridge skills: HTTP ${res.status}`);
    return (await res.json()) as Awaited<
      ReturnType<BridgeService['listSkills']>
    >;
  }

  /** Arquiva uma habilidade (recuperável no disco; nunca exclui). */
  async archiveSkill(tenantId: string, name: string): Promise<void> {
    const res = await fetch(
      `${this.url}/tenants/${tenantId}/skills/${encodeURIComponent(name)}/archive`,
      { method: 'POST', headers: { 'x-bridge-key': this.apiKey } },
    );
    if (!res.ok) {
      throw new Error(
        res.status === 404 ? 'Habilidade não encontrada' : `HTTP ${res.status}`,
      );
    }
  }

  /**
   * Streams NDJSON events from the Hermes bridge. Sem nenhum byte por
   * `idleMs`, aborta: um turno travado no Hermes vira erro visível em vez de
   * deixar a tela em "pensando" para sempre.
   */
  async *chat(
    request: BridgeChatRequest,
    idleMs = BridgeService.IDLE_MS,
  ): AsyncGenerator<BridgeEvent> {
    const ctrl = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), idleMs);
    };
    arm();
    let res: Response;
    try {
      res = await fetch(`${this.url}/chat`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-bridge-key': this.apiKey,
        },
        body: JSON.stringify(request),
        signal: ctrl.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      throw new BadGatewayException(
        ctrl.signal.aborted
          ? 'O agente não respondeu a tempo.'
          : `Bridge inacessível: ${(err as Error).message}`,
      );
    }
    if (!res.ok || !res.body) {
      throw new BadGatewayException(`Bridge retornou HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch (err) {
          if (ctrl.signal.aborted) {
            throw new BadGatewayException('O agente não respondeu a tempo.');
          }
          throw err;
        }
        const { done, value } = chunk;
        if (done) break;
        arm();
        buffer += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line) continue;
          try {
            yield JSON.parse(line) as BridgeEvent;
          } catch {
            this.logger.warn(`Linha NDJSON inválida do bridge: ${line}`);
          }
        }
      }
      const tail = buffer.trim();
      if (tail) {
        try {
          yield JSON.parse(tail) as BridgeEvent;
        } catch {
          this.logger.warn(`Linha NDJSON final inválida: ${tail}`);
        }
      }
    } finally {
      clearTimeout(timer);
      reader.releaseLock();
    }
  }

  /** Turno sem nenhum evento por este tempo é dado como travado. */
  static readonly IDLE_MS = 180_000;
}
