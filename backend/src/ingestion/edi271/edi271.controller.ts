import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsString, MaxLength } from 'class-validator';
import { AuthGuard } from '../../auth/auth.guard';
import { parseEdi271 } from './parser';
import type { Edi271File } from './types';

class ParseDto {
  @IsString()
  @MaxLength(2 * 1024 * 1024)
  body!: string;
}

@ApiTags('eligibility')
@Controller('v1/eligibility')
@UseGuards(AuthGuard)
export class Edi271Controller {
  @Post('parse-271')
  @ApiOperation({ summary: 'Parse an X12 271 eligibility response into a typed object' })
  parse(@Body() body: ParseDto): Edi271File {
    return parseEdi271(body.body);
  }
}
