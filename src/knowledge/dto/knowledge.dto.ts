import {
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
  MinLength,
} from 'class-validator';

export class AddTextDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @IsString()
  @MinLength(10)
  @MaxLength(500_000)
  content: string;

  @IsOptional()
  @IsString()
  agentId?: string;
}

export class SetEmbeddingConfigDto {
  /** null desliga a busca inteligente (volta a lexical pura) */
  @IsOptional()
  @IsString()
  keyId?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string | null;
}

export class AddUrlDto {
  @IsUrl({ require_protocol: true, protocols: ['http', 'https'] })
  url: string;

  @IsOptional()
  @IsString()
  agentId?: string;
}
