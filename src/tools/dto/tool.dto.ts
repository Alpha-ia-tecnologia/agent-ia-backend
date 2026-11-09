import { HttpMethod } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  Min,
} from 'class-validator';

export const TOOL_NAME_REGEX = /^[a-z0-9_]{2,64}$/;

export class CreateToolDto {
  @Matches(TOOL_NAME_REGEX, {
    message:
      'name deve ser um slug com letras minúsculas, números e underscore (2-64 chars)',
  })
  name: string;

  @IsString()
  @IsNotEmpty()
  displayName: string;

  @IsString()
  @IsNotEmpty()
  description: string;

  @IsEnum(HttpMethod)
  method: HttpMethod;

  @IsUrl({ require_tld: false, require_protocol: true })
  url: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsObject()
  paramsSchema: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(120000)
  timeoutMs?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdateToolDto {
  @IsOptional()
  @Matches(TOOL_NAME_REGEX, {
    message:
      'name deve ser um slug com letras minúsculas, números e underscore (2-64 chars)',
  })
  name?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  displayName?: string;

  @IsOptional()
  @IsString()
  @IsNotEmpty()
  description?: string;

  @IsOptional()
  @IsEnum(HttpMethod)
  method?: HttpMethod;

  @IsOptional()
  @IsUrl({ require_tld: false, require_protocol: true })
  url?: string;

  @IsOptional()
  @IsObject()
  headers?: Record<string, string>;

  @IsOptional()
  @IsObject()
  paramsSchema?: Record<string, unknown>;

  @IsOptional()
  @IsInt()
  @Min(1000)
  @Max(120000)
  timeoutMs?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class TestToolDto {
  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}

export class AgentToolsDto {
  @IsString({ each: true })
  toolIds: string[];
}

export class ExecuteToolDto {
  @IsString()
  @IsNotEmpty()
  companyId: string;

  @IsString()
  @IsNotEmpty()
  toolName: string;

  @IsOptional()
  @IsObject()
  args?: Record<string, unknown>;
}
