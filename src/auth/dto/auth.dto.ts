import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class SignupDto {
  /** opcional: sem ele, cria só a conta (a pessoa entra depois por convite) */
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  companyName?: string;

  @IsOptional()
  @IsString()
  businessDescription?: string;

  @IsOptional()
  @IsString()
  industry?: string;

  @IsString()
  @IsNotEmpty()
  name: string;

  @IsEmail()
  email: string;

  @IsString()
  @MinLength(8)
  password: string;
}

export class LoginDto {
  @IsEmail()
  email: string;

  @IsString()
  @IsNotEmpty()
  password: string;
}

export class DeleteAccountDto {
  @IsString()
  @IsNotEmpty()
  password: string;
}

export class SwitchOrgDto {
  @IsString()
  @IsNotEmpty()
  companyId: string;
}
