import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/decorators/current-user.decorator';
import {
  AddTaskMemberDto,
  CreateTaskDto,
  CreateTaskListDto,
  MoveTaskDto,
  TaskFilterDto,
  UpdateTaskDto,
  UpdateTaskListDto,
} from './dto/task.dto';
import { TasksService } from './tasks.service';

@Controller('task-lists')
export class TaskListsController {
  constructor(private readonly service: TasksService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskListDto) {
    return this.service.createList(user.companyId, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query('projectId') projectId?: string) {
    return this.service.listLists(user.companyId, projectId);
  }

  @Patch(':id')
  rename(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTaskListDto,
  ) {
    return this.service.renameList(user.companyId, id, dto.name);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.removeList(user.companyId, id);
  }
}

@Controller('tasks')
export class TasksController {
  constructor(private readonly service: TasksService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateTaskDto) {
    return this.service.create(user.companyId, dto);
  }

  @Get()
  findAll(@CurrentUser() user: AuthUser, @Query() filter: TaskFilterDto) {
    return this.service.findAll(user.companyId, filter);
  }

  @Get(':id')
  findOne(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.findOne(user.companyId, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateTaskDto,
  ) {
    return this.service.update(user.companyId, id, dto);
  }

  @Patch(':id/move')
  move(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: MoveTaskDto,
  ) {
    return this.service.move(user.companyId, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.remove(user.companyId, id);
  }

  @Post(':id/members')
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: AddTaskMemberDto,
  ) {
    return this.service.addMember(user.companyId, id, dto);
  }

  @Delete(':id/members/:memberId')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Param('memberId') memberId: string,
  ) {
    return this.service.removeMember(user.companyId, id, memberId);
  }
}
