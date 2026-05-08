import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Matches,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

const STATE_REGEX = /^[A-Z]{2}$/;
const CODE_REGEX = /^[A-Z0-9]{4,7}$/;
const ICD10_REGEX = /^[A-TV-Z][0-9][0-9A-Z](?:\.[0-9A-Z]{1,4})?$/;

export class ClaimLineDto {
  @ApiProperty({ example: '99497', description: 'CPT or HCPCS Level II code' })
  @IsString()
  @Matches(CODE_REGEX, { message: 'code must look like a CPT/HCPCS' })
  code!: string;

  @ApiPropertyOptional({ example: ['25'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  modifiers?: string[];

  @ApiPropertyOptional({ example: '11' })
  @IsOptional()
  @IsString()
  @Length(2, 2)
  pos?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  units?: number;
}

export class LookupRequestDto {
  @ApiProperty({ example: '11111111-1111-4111-8111-111111111111' })
  @IsString()
  payer_id!: string;

  @ApiProperty({ example: 'OH' })
  @IsString()
  @Matches(STATE_REGEX, { message: 'state must be 2 uppercase letters' })
  state!: string;

  @ApiProperty({ example: 'medicare_ffs' })
  @IsString()
  product_line!: string;

  @ApiProperty({ example: '2026-04-15' })
  @IsDateString()
  date_of_service!: string;

  @ApiProperty({ type: [ClaimLineDto] })
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => ClaimLineDto)
  lines!: ClaimLineDto[];

  @ApiPropertyOptional({ example: ['Z51.5'] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @Matches(ICD10_REGEX, { each: true, message: 'each diagnosis must be an ICD-10 code' })
  diagnoses?: string[];

  @ApiPropertyOptional({ example: '363LF0000X' })
  @IsOptional()
  @IsString()
  @Length(10, 10)
  provider_taxonomy?: string;

  @ApiPropertyOptional({ example: 'employer_group_lt_20' })
  @IsOptional()
  @IsString()
  @IsIn([
    'medicare',
    'medicaid',
    'employer_group_lt_20',
    'employer_group_gte_20',
    'commercial',
    'auto_no_fault',
    'workers_comp',
    'va_benefits',
    'tricare',
    'tribal',
    'self_insured',
  ])
  cob_other_coverage?: string;

  @ApiPropertyOptional({ example: '2026-05-01' })
  @IsOptional()
  @IsDateString()
  filing_date?: string;

  @ApiPropertyOptional({ example: '22222222-2222-4222-8222-222222222222', description: 'Tenant client_id; required if SUD codes appear on the claim.' })
  @IsOptional()
  @IsString()
  client_id?: string;

  @ApiPropertyOptional({ example: 'PHASH:abc123', description: 'De-identified patient reference, used for 42 CFR Part 2 SUD consent lookup.' })
  @IsOptional()
  @IsString()
  patient_external_id?: string;
}
