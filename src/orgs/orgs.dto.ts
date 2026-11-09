import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateOrgDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @IsOptional()
  @IsString()
  businessDescription?: string;

  @IsOptional()
  @IsString()
  industry?: string;
}
