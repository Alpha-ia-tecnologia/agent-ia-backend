import { ProjectStatus } from '@prisma/client';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  allDepartments?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  departmentIds?: string[];
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string;

  @IsOptional()
  @IsBoolean()
  allDepartments?: boolean;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  departmentIds?: string[];
}

export class UpdateProjectStatusDto {
  @IsEnum(ProjectStatus)
  status: ProjectStatus;
}
