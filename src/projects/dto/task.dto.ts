import { TaskPriority, TaskStatus } from '@prisma/client';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateTaskListDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  projectId?: string;
}

export class UpdateTaskListDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;
}

export class CreateTaskDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  listId?: string;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsDateString()
  dueDate?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  memberUserIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  memberAgentIds?: string[];
}

export class UpdateTaskDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  title?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @IsOptional()
  @IsString()
  listId?: string | null;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  @IsOptional()
  @IsEnum(TaskPriority)
  priority?: TaskPriority;

  @IsOptional()
  @IsDateString()
  dueDate?: string | null;
}

export class MoveTaskDto {
  @IsEnum(TaskStatus)
  status: TaskStatus;

  @IsInt()
  @Min(0)
  position: number;
}

export class TaskFilterDto {
  @IsOptional()
  @IsString()
  projectId?: string;

  @IsOptional()
  @IsString()
  listId?: string;

  @IsOptional()
  @IsEnum(TaskStatus)
  status?: TaskStatus;

  /** 'true' = apenas tasks sem projeto */
  @IsOptional()
  @IsString()
  isolated?: string;
}

export class AddTaskMemberDto {
  @IsOptional()
  @IsString()
  userId?: string;

  @IsOptional()
  @IsString()
  agentId?: string;
}
