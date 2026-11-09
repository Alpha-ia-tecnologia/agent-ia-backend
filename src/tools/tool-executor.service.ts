import { Injectable, Logger } from '@nestjs/common';
import { CustomTool } from '@prisma/client';
import { CryptoService } from '../crypto/crypto.service';

export interface ToolExecutionResult {
  ok: boolean;
  status?: number;
  body?: string;
  error?: string;
}

const MAX_BODY_CHARS = 4000;

@Injectable()
export class ToolExecutorService {
  private readonly logger = new Logger(ToolExecutorService.name);

  constructor(private readonly crypto: CryptoService) {}

  decryptHeaders(tool: CustomTool): Record<string, string> {
    if (!tool.encryptedHeaders || !tool.headersIv || !tool.headersAuthTag) {
      return {};
    }
    try {
      return JSON.parse(
        this.crypto.decrypt({
          encrypted: tool.encryptedHeaders,
          iv: tool.headersIv,
          authTag: tool.headersAuthTag,
        }),
      ) as Record<string, string>;
    } catch (err) {
      this.logger.error(
        `Falha ao descriptografar headers da tool ${tool.name}: ${(err as Error).message}`,
      );
      return {};
    }
  }

  /** Executa a ferramenta HTTP. Nunca lança — todo erro vira texto descritivo. */
  async execute(
    tool: CustomTool,
    args: Record<string, unknown> = {},
  ): Promise<ToolExecutionResult> {
    const headers: Record<string, string> = {
      ...this.decryptHeaders(tool),
    };

    let url = tool.url;
    const init: RequestInit = {
      method: tool.method,
      headers,
      signal: AbortSignal.timeout(tool.timeoutMs),
    };

    if (tool.method === 'GET') {
      const qs = new URLSearchParams();
      for (const [key, value] of Object.entries(args)) {
        if (value === undefined || value === null) continue;
        qs.append(
          key,
          // string vai crua; número/booleano/objeto como JSON ("5", "true", "{...}")
          typeof value === 'string' ? value : JSON.stringify(value),
        );
      }
      const query = qs.toString();
      if (query) url += (url.includes('?') ? '&' : '?') + query;
    } else {
      headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
      init.body = JSON.stringify(args);
    }

    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (err) {
      const e = err as Error;
      const isTimeout = e.name === 'TimeoutError' || e.name === 'AbortError';
      return {
        ok: false,
        error: isTimeout
          ? `A ferramenta "${tool.name}" excedeu o tempo limite de ${tool.timeoutMs}ms e a requisição foi cancelada.`
          : `Falha de rede ao chamar a ferramenta "${tool.name}": ${e.message}. Verifique se a URL está acessível.`,
      };
    }

    let body = '';
    try {
      body = await res.text();
    } catch {
      body = '';
    }
    if (body.length > MAX_BODY_CHARS) {
      body = `${body.slice(0, MAX_BODY_CHARS)}… [truncado]`;
    }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body,
        error: `A ferramenta "${tool.name}" retornou HTTP ${res.status} (${
          res.status >= 500
            ? 'erro no servidor de destino'
            : 'erro na requisição'
        }). Resposta: ${body || '(vazia)'}`,
      };
    }

    return { ok: true, status: res.status, body };
  }
}
