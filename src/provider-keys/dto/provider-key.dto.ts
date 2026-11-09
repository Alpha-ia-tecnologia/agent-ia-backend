import { Provider } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
} from 'class-validator';

export class CreateProviderKeyDto {
  // O frontend usa os ids em minúsculo ("openai"); o enum do Prisma é maiúsculo.
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toUpperCase() : value,
  )
  @IsEnum(Provider)
  provider: Provider;

  @IsString()
  @IsNotEmpty()
  apiKey: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  baseUrl?: string;

  @IsString()
  @IsNotEmpty()
  label: string;

  @IsOptional()
  @IsString()
  defaultModel?: string;
}
