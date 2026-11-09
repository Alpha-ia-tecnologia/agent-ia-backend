import { Module } from '@nestjs/common';
import { ProviderKeysController } from './provider-keys.controller';
import { ProviderKeysService } from './provider-keys.service';
import { ProviderResolverService } from './provider-resolver.service';

@Module({
  controllers: [ProviderKeysController],
  providers: [ProviderKeysService, ProviderResolverService],
  exports: [ProviderKeysService, ProviderResolverService],
})
export class ProviderKeysModule {}
