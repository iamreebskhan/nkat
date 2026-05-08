/**
 * X12 837P generator endpoint.
 *
 *   POST /v1/edi/837p  { identity, provider, subscriber, payer, claim, control } → text/edi
 */
import { Body, Controller, Header, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsInt, IsNumber, IsOptional, IsString, Length, Matches, MaxLength, Min,
} from 'class-validator';
import { Type } from 'class-transformer';
import type { Request } from 'express';
import { AuthGuard } from '../../auth/auth.guard';
import { assertUuid } from '../../common/uuid';
import {
  generate837P,
  type Edi837Claim,
  type Edi837Control,
  type Edi837Identity,
  type Edi837Payer,
  type Edi837Provider,
  type Edi837Subscriber,
} from './generator';
import {
  generate837I,
  type Edi837IClaim,
  type Edi837IControl,
  type Edi837IIdentity,
  type Edi837IPayer,
  type Edi837IProvider,
  type Edi837ISubscriber,
} from './generator-institutional';

class IdentityDto {
  @IsString() @Length(2, 15) senderId!: string;
  @IsString() @Length(2, 15) receiverId!: string;
  @IsIn(['P', 'T']) usage!: 'P' | 'T';
}

class ProviderDto {
  @IsString() @MaxLength(60) organizationName!: string;
  @IsString() @Length(10, 10) npi!: string;
  @IsString() @MaxLength(20) taxId!: string;
  @IsIn(['EI', 'SY']) taxIdQualifier!: 'EI' | 'SY';
  @IsOptional() @IsString() @MaxLength(20) taxonomy?: string;
}

class SubscriberDto {
  @IsString() @MaxLength(80) memberId!: string;
  @IsString() @MaxLength(35) firstName!: string;
  @IsString() @MaxLength(35) lastName!: string;
  @IsString() @Length(8, 8) dob!: string;
  @IsIn(['M', 'F', 'U']) gender!: 'M' | 'F' | 'U';
  @IsString() @MaxLength(55) address1!: string;
  @IsString() @MaxLength(30) city!: string;
  @IsString() @Length(2, 2) state!: string;
  @IsString() @MaxLength(15) zip!: string;
}

class PayerDto {
  @IsString() @MaxLength(60) name!: string;
  @IsString() @MaxLength(80) payerId!: string;
  @IsIn(['PI', 'XV']) payerIdQualifier!: 'PI' | 'XV';
}

class ServiceLineDto {
  @IsInt() @Min(1) lineNumber!: number;
  @IsString() @MaxLength(8) procedureCode!: string;
  @IsArray() @ArrayMaxSize(4) @IsString({ each: true }) modifiers!: string[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(4) @IsInt({ each: true }) diagnosisPointers!: number[];
  @IsNumber() @Min(0) chargeAmount!: number;
  @IsNumber() @Min(0) units!: number;
  @IsString() @Length(8, 8) serviceDate!: string;
  @IsString() @MaxLength(2) placeOfService!: string;
}

class ClaimDto {
  @IsString() @MaxLength(38) patientControlNumber!: string;
  @IsNumber() @Min(0) totalCharge!: number;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(12)
  @IsString({ each: true })
  @Matches(/^[A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?$/, { each: true })
  diagnoses!: string[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(50) @Type(() => ServiceLineDto)
  lines!: ServiceLineDto[];
}

class ControlDto {
  @Matches(/^\d{1,9}$/) interchangeControlNumber!: string;
  @Matches(/^\d{1,9}$/) groupControlNumber!: string;
  @Matches(/^\d{1,9}$/) transactionSetControlNumber!: string;
  @IsString() referenceId!: string;
}

class Generate837Dto {
  identity!: IdentityDto;
  provider!: ProviderDto;
  subscriber!: SubscriberDto;
  payer!: PayerDto;
  claim!: ClaimDto;
  control!: ControlDto;
}

@ApiTags('edi')
@Controller('v1/edi/837p')
@UseGuards(AuthGuard)
export class Edi837PController {
  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'application/edi-x12')
  @ApiOperation({ summary: 'Generate an X12 837P professional claim' })
  generate(@Req() req: Request, @Body() body: Generate837Dto): string {
    assertUuid(req.auth?.orgId, 'orgId');
    return generate837P(
      body.identity as Edi837Identity,
      body.provider as Edi837Provider,
      body.subscriber as Edi837Subscriber,
      body.payer as Edi837Payer,
      body.claim as unknown as Edi837Claim,
      body.control as Edi837Control,
    );
  }
}

@ApiTags('edi')
@Controller('v1/edi/837i')
@UseGuards(AuthGuard)
export class Edi837IController {
  @Post()
  @HttpCode(200)
  @Header('Content-Type', 'application/edi-x12')
  @ApiOperation({ summary: 'Generate an X12 837I institutional claim (UB-04)' })
  generate(@Req() req: Request, @Body() body: unknown): string {
    const b = body as {
      identity: Edi837IIdentity;
      provider: Edi837IProvider;
      subscriber: Edi837ISubscriber;
      payer: Edi837IPayer;
      claim: Edi837IClaim;
      control: Edi837IControl;
    };
    assertUuid(req.auth?.orgId, 'orgId');
    return generate837I(b.identity, b.provider, b.subscriber, b.payer, b.claim, b.control);
  }
}
