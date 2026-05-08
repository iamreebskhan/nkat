/**
 * X12 270 generator endpoint.
 *
 *   POST /v1/edi/270   { identity, info, control } → text/plain
 *
 * Returns the EDI body. The caller forwards it to a clearinghouse
 * (Availity, Change Healthcare, Waystar) and gets a 271 back, which
 * we parse via Edi271Module.
 */
import { Body, Controller, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsNumberString, IsString, Length, Matches, MaxLength, MinLength,
} from 'class-validator';
import type { Request } from 'express';
import { AuthGuard } from '../../auth/auth.guard';
import { assertUuid } from '../../common/uuid';
import { generate270, type Edi270Identity, type Edi270Information, type Edi270Control } from './generator';

class IdentityDto {
  @IsString() @Length(2, 15) senderId!: string;
  @IsString() @Length(2, 15) receiverId!: string;
  @IsIn(['P', 'T']) usage!: 'P' | 'T';
}

class InformationDto {
  @IsString() @MaxLength(60) payerName!: string;
  @IsIn(['PI', 'XV']) payerIdQualifier!: 'PI' | 'XV';
  @IsString() @MaxLength(80) payerId!: string;
  @IsString() @MaxLength(60) providerName!: string;
  @IsString() @Length(10, 10) providerNpi!: string;
  @IsString() @MaxLength(35) subscriberFirstName!: string;
  @IsString() @MaxLength(35) subscriberLastName!: string;
  @IsString() @MaxLength(80) subscriberMemberId!: string;
  @IsNumberString() @Length(8, 8) subscriberDob!: string;
  @IsIn(['M', 'F', 'U']) subscriberGender!: 'M' | 'F' | 'U';
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @IsString({ each: true }) serviceTypeCodes!: string[];
  @IsNumberString() @Length(8, 8) serviceDate!: string;
}

class ControlDto {
  @Matches(/^\d{1,9}$/) interchangeControlNumber!: string;
  @Matches(/^\d{1,9}$/) groupControlNumber!: string;
  @Matches(/^\d{1,9}$/) transactionSetControlNumber!: string;
  @IsString() @MinLength(1) @MaxLength(50) referenceId!: string;
}

class Generate270Dto {
  identity!: IdentityDto;
  info!: InformationDto;
  control!: ControlDto;
}

@ApiTags('edi')
@Controller('v1/edi/270')
@UseGuards(AuthGuard)
export class Edi270Controller {
  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'application/edi-x12')
  @ApiOperation({ summary: 'Generate an X12 270 eligibility inquiry' })
  generate(@Req() req: Request, @Body() body: Generate270Dto): string {
    assertUuid(req.auth?.orgId, 'orgId');
    return generate270(
      body.identity as Edi270Identity,
      body.info as Edi270Information,
      body.control as Edi270Control,
    );
  }
}
