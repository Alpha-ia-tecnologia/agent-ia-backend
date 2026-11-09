import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ProviderKeysService } from './provider-keys.service';

export type ActiveProvider =
  | { type: 'subscription'; provider: string; model: string }
  | {
      type: 'key';
      key: NonNullable<
        Awaited<ReturnType<ProviderKeysService['getDecrypted']>>
      >;
    }
  | null;

/**
 * Ponto único para saber COMO a empresa fala com LLM: assinatura ativa tem
 * precedência sobre chaves de API. Usado fora do chat (onboarding, análises)
 * — o chat tem sua própria resolução com cadeia de fallback.
 */
@Injectable()
export class ProviderResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providerKeys: ProviderKeysService,
  ) {}

  async active(companyId: string): Promise<ActiveProvider> {
    const company = await this.prisma.company.findUnique({
      where: { id: companyId },
      select: { subscriptionProvider: true, subscriptionModel: true },
    });
    if (company?.subscriptionProvider && company.subscriptionModel) {
      return {
        type: 'subscription',
        provider: company.subscriptionProvider,
        model: company.subscriptionModel,
      };
    }
    const key = await this.providerKeys.getDecrypted(companyId);
    return key ? { type: 'key', key } : null;
  }
}
