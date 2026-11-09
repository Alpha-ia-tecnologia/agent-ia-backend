import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  Post,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';
import { TrailService } from './trail.service';
import { TOTAL_STATIONS } from './trail.logic';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

class TrailAnswerDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty({ message: 'Digite sua resposta.' })
  @MaxLength(20_000, { message: 'O texto pode ter até 20 mil caracteres.' })
  content: string;
}

class TrailAttachDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  documentId: string;
}

class TrailOpenDto {
  @IsBoolean()
  open: boolean;
}

class TrailPilotVoteDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(TOTAL_STATIONS)
  station: number;
}

class TrailSheetDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  field: string;

  @Transform(trim)
  @IsString()
  @MaxLength(1000, { message: 'O campo pode ter até mil caracteres.' })
  value: string;
}

class TrailPublicVoteDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(40)
  runId: string;
}

class ReleaseDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(TOTAL_STATIONS)
  upTo: number;
}

@Controller('trail')
export class TrailController {
  constructor(private readonly trail: TrailService) {}

  @Get('stations')
  stations() {
    return this.trail.stations();
  }

  @Get('state')
  state(@CurrentUser() user: AuthUser) {
    return this.trail.state(user);
  }

  @Get('agents')
  agents(@CurrentUser() user: AuthUser) {
    return this.trail.officeAgents(user.companyId);
  }

  @Get('activity')
  activity(@CurrentUser() user: AuthUser) {
    return this.trail.activities(user);
  }

  /** Coloca a pessoa em uma sala com lugar; quem já tem sala permanece nela. */
  @Post('join')
  @HttpCode(200)
  join(@CurrentUser() user: AuthUser) {
    return this.trail.join(user);
  }

  @Get('stations/:n/session')
  session(@CurrentUser() user: AuthUser, @Param('n', ParseIntPipe) n: number) {
    return this.trail.session(user, n);
  }

  @Post('stations/:n/attach')
  @HttpCode(200)
  attach(
    @CurrentUser() user: AuthUser,
    @Param('n', ParseIntPipe) n: number,
    @Body() dto: TrailAttachDto,
  ) {
    return this.trail.attach(user, n, dto.documentId);
  }

  @Post('stations/:n/answer')
  @HttpCode(200)
  answer(
    @CurrentUser() user: AuthUser,
    @Param('n', ParseIntPipe) n: number,
    @Body() dto: TrailAnswerDto,
  ) {
    return this.trail.answer(user, n, dto.content);
  }

  @Get('stations/:n/mural')
  mural(@CurrentUser() user: AuthUser, @Param('n', ParseIntPipe) n: number) {
    return this.trail.mural(user, n);
  }

  @Get('pilot')
  pilot(@CurrentUser() user: AuthUser) {
    return this.trail.pilot(user);
  }

  @Post('pilot/start')
  @HttpCode(200)
  startPilot(@CurrentUser() user: AuthUser) {
    return this.trail.startPilot(user);
  }

  @Post('pilot/vote')
  @HttpCode(200)
  votePilot(@CurrentUser() user: AuthUser, @Body() dto: TrailPilotVoteDto) {
    return this.trail.votePilot(user, dto.station);
  }

  @Post('pilot/close')
  @HttpCode(200)
  closePilot(@CurrentUser() user: AuthUser) {
    return this.trail.closePilot(user);
  }

  @Post('pilot/sheet')
  @HttpCode(200)
  editSheet(@CurrentUser() user: AuthUser, @Body() dto: TrailSheetDto) {
    return this.trail.editSheet(user, dto.field, dto.value);
  }

  @Get('plan')
  plan(@CurrentUser() user: AuthUser) {
    return this.trail.plan(user);
  }

  /** Responde na hora; a tela acompanha o andamento por GET plan. */
  @Post('plan')
  @HttpCode(200)
  startPlan(@CurrentUser() user: AuthUser) {
    return this.trail.startPlan(user);
  }

  @Get('vote')
  publicVote(@CurrentUser() user: AuthUser) {
    return this.trail.publicVote(user);
  }

  @Post('vote')
  @HttpCode(200)
  castVote(@CurrentUser() user: AuthUser, @Body() dto: TrailPublicVoteDto) {
    return this.trail.castPublicVote(user, dto.runId);
  }

  @Get('board')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  board(@CurrentUser() user: AuthUser) {
    return this.trail.board(user.companyId);
  }

  @Post('release')
  @HttpCode(200)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  releaseRoom(@CurrentUser() user: AuthUser, @Body() dto: ReleaseDto) {
    return this.trail.releaseRoom(user.companyId, dto.upTo);
  }

  @Post('pilot-open')
  @HttpCode(200)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  setPilotOpen(@CurrentUser() user: AuthUser, @Body() dto: TrailOpenDto) {
    return this.trail.setPilotOpen(user.companyId, dto.open);
  }

  @Post('vote-open')
  @HttpCode(200)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  setVoteOpen(@CurrentUser() user: AuthUser, @Body() dto: TrailOpenDto) {
    return this.trail.setVoteOpen(user.companyId, dto.open);
  }

  @Post('chegada-open')
  @HttpCode(200)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  setChegadaOpen(@CurrentUser() user: AuthUser, @Body() dto: TrailOpenDto) {
    return this.trail.setChegadaOpen(user.companyId, dto.open);
  }

  @Get('pilots')
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  pilots(@CurrentUser() user: AuthUser) {
    return this.trail.pilots(user.companyId);
  }

  @Post('runs/:id/release')
  @HttpCode(200)
  @Roles(UserRole.OWNER, UserRole.ADMIN)
  releaseRun(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: ReleaseDto,
  ) {
    return this.trail.releaseRun(user.companyId, id, dto.upTo);
  }
}
