import { Injectable, Logger } from '@nestjs/common';

const MAX_CONCURRENT_PER_COMPANY = 2;

/**
 * Serializa o processamento de mensagens de canal por empresa: no máximo
 * N execuções de agente simultâneas por tenant. Evita a "tempestade" que
 * derruba a instância Hermes quando muitas mensagens chegam de uma vez.
 */
@Injectable()
export class ChannelInboundQueue {
  private readonly logger = new Logger(ChannelInboundQueue.name);
  private readonly running = new Map<string, number>();
  private readonly queues = new Map<string, (() => Promise<void>)[]>();

  async run(companyId: string, task: () => Promise<void>): Promise<void> {
    const current = this.running.get(companyId) ?? 0;
    if (current >= MAX_CONCURRENT_PER_COMPANY) {
      const queue = this.queues.get(companyId) ?? [];
      queue.push(task);
      this.queues.set(companyId, queue);
      if (queue.length % 10 === 0) {
        this.logger.warn(
          `fila de canais da empresa ${companyId}: ${queue.length} mensagens aguardando`,
        );
      }
      return;
    }
    await this.execute(companyId, task);
  }

  private async execute(
    companyId: string,
    task: () => Promise<void>,
  ): Promise<void> {
    this.running.set(companyId, (this.running.get(companyId) ?? 0) + 1);
    try {
      await task();
    } catch (err) {
      this.logger.error(`inbound de canal falhou: ${(err as Error).message}`);
    } finally {
      const count = (this.running.get(companyId) ?? 1) - 1;
      if (count <= 0) this.running.delete(companyId);
      else this.running.set(companyId, count);
      const queue = this.queues.get(companyId);
      const next = queue?.shift();
      if (next) void this.execute(companyId, next);
      if (queue && queue.length === 0) this.queues.delete(companyId);
    }
  }
}
