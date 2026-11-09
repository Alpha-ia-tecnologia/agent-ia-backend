import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface ReportSpec {
  titulo: string;
  /** corpo do relatório em Markdown (títulos, listas, tabelas) */
  markdown: string;
  geradoEm: string;
}

/**
 * Relatórios em PDF entregues na conversa: o agente descreve o conteúdo em
 * Markdown e o PDF é gerado no navegador do usuário (botão "Baixar PDF"). Aqui
 * só validamos e penduramos a spec na conversa — mesmo mecanismo dos gráficos.
 */
@Injectable()
export class ReportService {
  constructor(private readonly prisma: PrismaService) {}

  build(req: { titulo?: string; conteudo_markdown?: string }): {
    erro?: string;
    spec?: ReportSpec;
  } {
    const titulo = req.titulo?.trim();
    const markdown = req.conteudo_markdown?.trim();
    if (!titulo) return { erro: 'Informe o título do relatório' };
    if (!markdown)
      return { erro: 'Informe o conteúdo do relatório em Markdown' };
    if (markdown.length > 60_000) {
      return { erro: 'Relatório muito longo (máx. 60.000 caracteres)' };
    }
    return {
      spec: { titulo, markdown, geradoEm: new Date().toISOString() },
    };
  }

  /** Pendura o relatório na conversa; consumeBridge anexa à resposta final. */
  async attachPending(conversationId: string, spec: ReportSpec): Promise<void> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    if (!conv) return;
    const meta = (conv.metadata ?? {}) as Record<string, unknown>;
    const pending = Array.isArray(meta.pendingReports)
      ? meta.pendingReports
      : [];
    if (pending.length >= 3) pending.shift(); // no máximo 3 relatórios por resposta
    pending.push(spec);
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        metadata: { ...meta, pendingReports: pending },
      },
    });
  }

  /** Consome (e limpa) os relatórios pendentes da conversa. */
  async drainPending(conversationId: string): Promise<ReportSpec[]> {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { metadata: true },
    });
    const meta = (conv?.metadata ?? {}) as Record<string, unknown>;
    const pending = Array.isArray(meta.pendingReports)
      ? (meta.pendingReports as unknown as ReportSpec[])
      : [];
    if (pending.length) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: {
          metadata: { ...meta, pendingReports: [] },
        },
      });
    }
    return pending;
  }
}
