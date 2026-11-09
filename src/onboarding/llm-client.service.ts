import { BadGatewayException, Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';

const DEFAULT_BASE_URLS: Partial<Record<Provider, string>> = {
  OPENAI: 'https://api.openai.com/v1',
  DEEPSEEK: 'https://api.deepseek.com/v1',
  OPENROUTER: 'https://openrouter.ai/api/v1',
};

export const DEFAULT_MODELS: Partial<Record<Provider, string>> = {
  OPENAI: 'gpt-4o-mini',
  DEEPSEEK: 'deepseek-chat',
  ANTHROPIC: 'claude-sonnet-5-5',
  GOOGLE: 'gemini-2.0-flash',
};

export interface LlmCallOptions {
  provider: Provider;
  apiKey: string;
  baseUrl?: string | null;
  model?: string;
  prompt: string;
}

@Injectable()
export class LlmClientService {
  /** Single-turn completion against the customer's own provider (BYOK). */
  async complete(opts: LlmCallOptions): Promise<string> {
    const model = opts.model ?? DEFAULT_MODELS[opts.provider];
    if (!model) {
      throw new BadGatewayException(
        `Modelo não configurado para o provider ${opts.provider}`,
      );
    }

    try {
      if (opts.provider === Provider.ANTHROPIC) {
        return await this.callAnthropic(opts.apiKey, model, opts.prompt);
      }
      if (opts.provider === Provider.GOOGLE) {
        return await this.callGoogle(opts.apiKey, model, opts.prompt);
      }
      const base = opts.baseUrl ?? DEFAULT_BASE_URLS[opts.provider];
      if (!base) {
        throw new BadGatewayException(
          'baseUrl não configurada para este provider',
        );
      }
      return await this.callOpenAiCompatible(
        base,
        opts.apiKey,
        model,
        opts.prompt,
      );
    } catch (err) {
      if (err instanceof BadGatewayException) throw err;
      throw new BadGatewayException(
        `Falha ao chamar o LLM: ${(err as Error).message}`,
      );
    }
  }

  private async callOpenAiCompatible(
    baseUrl: string,
    apiKey: string,
    model: string,
    prompt: string,
  ): Promise<string> {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      throw new BadGatewayException(`Provider retornou HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return body.choices?.[0]?.message?.content ?? '';
  }

  private async callAnthropic(
    apiKey: string,
    model: string,
    prompt: string,
  ): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) {
      throw new BadGatewayException(`Anthropic retornou HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      content?: { type: string; text?: string }[];
    };
    return (
      body.content
        ?.filter((b) => b.type === 'text')
        .map((b) => b.text ?? '')
        .join('') ?? ''
    );
  }

  private async callGoogle(
    apiKey: string,
    model: string,
    prompt: string,
  ): Promise<string> {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
        signal: AbortSignal.timeout(120000),
      },
    );
    if (!res.ok) {
      throw new BadGatewayException(`Google retornou HTTP ${res.status}`);
    }
    const body = (await res.json()) as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    };
    return (
      body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ??
      ''
    );
  }
}
