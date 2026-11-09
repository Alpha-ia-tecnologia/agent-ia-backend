import { Body, Controller, Delete, Get, HttpCode, Post } from '@nestjs/common';
import { AuthService } from './auth.service';
import { Public } from './decorators/public.decorator';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthUser } from './decorators/current-user.decorator';
import { NoOrg } from './decorators/no-org.decorator';
import {
  DeleteAccountDto,
  LoginDto,
  SignupDto,
  SwitchOrgDto,
} from './dto/auth.dto';

@Controller('auth')
@NoOrg() // conta funciona sem organização ativa
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Public()
  @Post('signup')
  signup(@Body() dto: SignupDto) {
    return this.authService.signup(dto);
  }

  @Public()
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto);
  }

  @Delete('account')
  @HttpCode(200)
  deleteAccount(@CurrentUser() user: AuthUser, @Body() dto: DeleteAccountDto) {
    return this.authService.deleteAccount(user.userId, dto);
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser) {
    return user;
  }

  /** Troca a organização ativa: devolve um novo token para ela. */
  @Post('switch-org')
  @HttpCode(200)
  switchOrg(@CurrentUser() user: AuthUser, @Body() dto: SwitchOrgDto) {
    return this.authService.switchOrg(user.userId, dto.companyId);
  }
}
