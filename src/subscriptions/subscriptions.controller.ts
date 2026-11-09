import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { SubscriptionsService } from './subscriptions.service';

const PROVIDERS = [
  'openai-codex',
  'anthropic-oauth',
  'copilot',
  'nous',
  'xai-oauth',
];
const DEVICE_FLOW = ['openai-codex', 'copilot', 'nous', 'xai-oauth'];

@Controller('providers/subscription')
@Roles(UserRole.OWNER, UserRole.ADMIN)
export class SubscriptionsController {
  constructor(
    private readonly service: SubscriptionsService,
    private readonly prisma: PrismaService,
  ) {}

  private assertProvider(provider: string, deviceOnly = false) {
    const list = deviceOnly ? DEVICE_FLOW : PROVIDERS;
    if (!list.includes(provider)) {
      throw new BadRequestException(`Provider inválido: ${provider}`);
    }
  }

  @Get('status')
  async status(@CurrentUser() user: AuthUser) {
    const [bridgeStatus, company] = await Promise.all([
      this.service.bridgeStatusSafe(user.companyId),
      this.prisma.company.findUnique({
        where: { id: user.companyId },
        select: { subscriptionProvider: true, subscriptionModel: true },
      }),
    ]);
    return {
      active: company?.subscriptionProvider
        ? {
            provider: company.subscriptionProvider,
            model: company.subscriptionModel,
          }
        : null,
      providers: bridgeStatus,
    };
  }

  @Post(':provider/start')
  async start(
    @CurrentUser() user: AuthUser,
    @Param('provider') provider: string,
  ) {
    this.assertProvider(provider, true);
    return this.service.startFlow(user.companyId, provider, user.userId);
  }

  @Get(':provider/flow')
  async flow(
    @CurrentUser() user: AuthUser,
    @Param('provider') provider: string,
  ) {
    this.assertProvider(provider, true);
    return this.service.flowStatus(user.companyId, provider, user.userId);
  }

  @Post('anthropic/url')
  anthropicUrl(@CurrentUser() user: AuthUser) {
    return this.service.anthropicUrl(user.companyId);
  }

  @Post('anthropic/exchange')
  anthropicExchange(@CurrentUser() user: AuthUser, @Body('code') code: string) {
    if (!code?.trim()) throw new BadRequestException('Informe o código.');
    return this.service.anthropicExchange(
      user.companyId,
      code.trim(),
      user.userId,
    );
  }

  /** Define a assinatura como provider ativo da empresa. */
  @Post('activate')
  async activate(
    @CurrentUser() user: AuthUser,
    @Body() body: { provider: string; model: string },
  ) {
    this.assertProvider(body.provider);
    if (!body.model?.trim()) {
      throw new BadRequestException('Informe o modelo (ex.: gpt-5-codex).');
    }
    const status = await this.service.bridgeStatus(user.companyId);
    const key =
      body.provider === 'anthropic-oauth' ? 'anthropic' : body.provider;
    if (!status?.[key]?.connected) {
      throw new BadRequestException(
        'Conecte a assinatura antes de ativá-la como provider.',
      );
    }
    await this.prisma.company.update({
      where: { id: user.companyId },
      data: {
        subscriptionProvider: body.provider,
        subscriptionModel: body.model.trim(),
      },
    });
    await this.service.audit(
      user.companyId,
      user.userId,
      'subscription_activated',
      {
        provider: body.provider,
        model: body.model.trim(),
      },
    );
    // instância precisa reprovisionar com o novo provider
    await this.service.restartTenant(user.companyId);
    return { active: { provider: body.provider, model: body.model.trim() } };
  }

  /** Volta a usar as chaves de API cadastradas. */
  @Post('deactivate')
  async deactivate(@CurrentUser() user: AuthUser) {
    await this.prisma.company.update({
      where: { id: user.companyId },
      data: { subscriptionProvider: null, subscriptionModel: null },
    });
    await this.service.audit(
      user.companyId,
      user.userId,
      'subscription_deactivated',
      {},
    );
    await this.service.restartTenant(user.companyId);
    return { active: null };
  }

  /** Desconecta a assinatura (remove os tokens do tenant). */
  @Delete(':provider')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('provider') provider: string,
  ) {
    this.assertProvider(provider);
    await this.service.removeCredentials(user.companyId, provider, user.userId);
    const company = await this.prisma.company.findUnique({
      where: { id: user.companyId },
      select: { subscriptionProvider: true },
    });
    if (company?.subscriptionProvider === provider) {
      await this.prisma.company.update({
        where: { id: user.companyId },
        data: { subscriptionProvider: null, subscriptionModel: null },
      });
    }
    return { removed: true };
  }
}
