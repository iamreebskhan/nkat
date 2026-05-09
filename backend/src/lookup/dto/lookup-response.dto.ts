import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Citation. Every finding in a lookup response carries one. UI renders a
 * "show me the source" link from `source_url` and surfaces `verbatim_quote`
 * inline. `retrieved_at` is shown as part of confidence context.
 */
export class CitationDto {
  @ApiProperty() source_doc_id!: string;
  @ApiProperty() source_url!: string;
  @ApiProperty({ description: 'When the source document was last fetched' })
  retrieved_at!: string;
  @ApiPropertyOptional() effective_date?: string;
  @ApiPropertyOptional() expiration_date?: string;
  @ApiPropertyOptional() verbatim_quote?: string;
  @ApiPropertyOptional() page_number?: number;
}

export type Severity = 'critical' | 'warning' | 'info' | 'ok';
export type CarcClass =
  | 'medical_necessity_11'
  | 'missing_info_16'
  | 'bundled_97'
  | 'modifier_4'
  | 'coverage_50'
  | 'timely_filing_29'
  | 'cob_22_24'
  | 'provider_eligibility_170_185'
  | 'mhpaea'
  | 'part2_consent'
  | 'abn_required'
  | 'dmepos_master_list'
  | 'asc_payment'
  | 'institutional_form'
  | 'unknown';

export class FindingDto {
  @ApiProperty({ enum: ['critical', 'warning', 'info', 'ok'] }) severity!: Severity;
  @ApiProperty() carc_class!: CarcClass;
  @ApiProperty() title!: string;
  @ApiProperty() detail!: string;
  @ApiProperty({ description: '0..1; 0 means refused' }) confidence!: number;
  @ApiProperty({ type: [CitationDto] }) citations!: CitationDto[];
  @ApiPropertyOptional() recommendation?: string;
  @ApiPropertyOptional() applies_to_line_index?: number;
}

export class LineFindingsDto {
  @ApiProperty() line_index!: number;
  @ApiProperty() code!: string;
  @ApiProperty({ type: [FindingDto] }) findings!: FindingDto[];
}

export class LookupResponseDto {
  @ApiProperty() request_id!: string;
  @ApiProperty() date_of_service!: string;
  @ApiProperty({ type: [LineFindingsDto] }) lines!: LineFindingsDto[];
  @ApiProperty({
    type: [FindingDto],
    description: 'Findings that span multiple lines (bundling, COB, timely filing)',
  })
  cross_line_findings!: FindingDto[];
  @ApiProperty() overall_severity!: Severity;
  @ApiProperty() summary!: string;
}
