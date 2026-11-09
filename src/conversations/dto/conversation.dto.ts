import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
} from 'class-validator';
import { ConversationVisibility } from '@prisma/client';

export class CreateConversationDto {
  @IsOptional()
  @IsString()
  title?: string;

  @IsOptional()
  @IsString()
  projectId?: string;
}

export class SendMessageDto {
  @IsString()
  @IsNotEmpty()
  content: string;

  @IsOptional()
  @IsString()
  agentId?: string;

  /** "Tentar de novo": reprocessa sem gravar a mensagem do usuário outra vez */
  @IsOptional()
  @IsBoolean()
  retry?: boolean;
}

export class UpdateConversationDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  title?: string;

  @IsOptional()
  @IsBoolean()
  pinned?: boolean;
}

export class ShareConversationDto {
  @IsIn(['PRIVATE', 'COMPANY', 'USERS'])
  visibility: ConversationVisibility;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  userIds?: string[];
}

export class ResolveShareRequestDto {
  @IsIn(['approve', 'deny'])
  action: 'approve' | 'deny';
}
