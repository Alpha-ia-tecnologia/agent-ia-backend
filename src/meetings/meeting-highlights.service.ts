import { Injectable } from '@nestjs/common';
import { Provider } from '@prisma/client';
import {
  BridgeService,
  type BridgeChatRequest,
} from '../conversations/bridge.service';
import { ConversationsService } from '../conversations/conversations.service';
import { LlmClientService } from '../onboarding/llm-client.service';
import {
  parseHighlights,
  type MeetingHighlight,
} from './meeting-highlights.parser';

export type { MeetingHighlight } from './meeting-highlights.parser';

const TRANSCRIPT_LIMIT = 100_000;

/**
 * Extrai os pontos importantes da reunião (decisões, ações, tópicos) com o
 * carimbo de tempo de cada um, para virarem uma trilha clicável no player.
 *
 * Usa a mesma resolução de provedor do chat (BYOK direto via LlmClientService;
 * assinatura via Hermes/bridge), no molde do ProjectAnalysisService. É uma
 * chamada de turno único que pede JSON estruturado.
 */
@Injectable()
export class MeetingHighlightsService {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly llm: LlmClientService,
    private readonly bridge: BridgeService,
  ) {}

  /** Extrai highlights da transcrição carimbada. Lança em erro de provedor. */
  async extract(
    companyId: string,
    subject: string,
    timestampedTranscript: string,
  ): Promise<MeetingHighlight[]> {
    const prompt = this.buildPrompt(
      subject,
      timestampedTranscript.slice(0, TRANSCRIPT_LIMIT),
    );
    const provider = await this.conversations.resolveProvider(companyId, {});

    const raw = provider.api_key
      ? await this.llm.complete({
          provider: provider.provider.toUpperCase() as Provider,
          apiKey: provider.api_key,
          baseUrl: provider.base_url,
          model: provider.model,
          prompt,
        })
      : await this.completeViaBridge(companyId, provider, prompt);

    return parseHighlights(raw);
  }

  private async completeViaBridge(
    companyId: string,
    provider: BridgeChatRequest['provider'],
    prompt: string,
  ): Promise<string> {
    const request: BridgeChatRequest = {
      tenant_id: companyId,
      session_id: `meeting-highlights:${companyId}`,
      message: prompt,
      file_paths: [],
      tools: [],
      sandbox: { mode: 'workspace' },
      agent: {
        agent_id: 'meeting-highlights',
        name: 'Ata da reunião',
        system_prompt:
          'Você resume reuniões. Responda exatamente o que for pedido, apenas com o JSON solicitado, sem texto fora do JSON.',
      },
      provider,
    };

    let streamed = '';
    let finalText = '';
    for await (const ev of this.bridge.chat(request)) {
      if (ev.type === 'token_chunk' && ev.text) streamed += ev.text;
      else if (ev.type === 'final_message') finalText = ev.text ?? finalText;
      else if (ev.type === 'error')
        throw new Error(
          ev.text || 'Falha ao extrair highlights pela assinatura',
        );
    }
    const out = (finalText || streamed).trim();
    if (!out) throw new Error('A extração de highlights não retornou conteúdo');
    return out;
  }

  private buildPrompt(subject: string, transcript: string): string {
    return `Você recebeu a transcrição carimbada da reunião "${subject}". Cada linha começa com um carimbo de tempo no formato [HH:MM:SS].

Extraia os pontos importantes como uma lista de highlights. Para cada ponto:
- "kind": "decision" (uma decisão tomada), "action" (uma tarefa/ação combinada) ou "topic" (um assunto relevante discutido).
- "ts": o carimbo de tempo da transcrição mais próximo do momento em que o ponto aparece, no formato "HH:MM:SS".
- "text": uma frase curta e objetiva descrevendo o ponto (em português).
- "speaker": quem falou ou é responsável, se identificável (senão omita).

Foque no que importa: decisões, responsáveis, prazos, próximos passos e tópicos-chave. Ignore conversa fiada.

Responda APENAS com JSON válido neste formato (sem comentários, sem texto fora do JSON):
{
  "highlights": [
    { "kind": "decision|action|topic", "ts": "HH:MM:SS", "text": "descrição curta", "speaker": "nome (opcional)" }
  ]
}

Transcrição:
"""
${transcript}
"""`;
  }
}
