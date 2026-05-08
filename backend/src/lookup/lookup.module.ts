import { Module } from '@nestjs/common';
import { AscModule } from '../asc/asc.module';
import { AuthModule } from '../auth/auth.module';
import { LookupController } from './lookup.controller';
import { CobService } from './services/cob.service';
import { DmepostService } from './services/dmepos.service';
import { LookupService } from './services/lookup.service';
import { MedicalNecessityService } from './services/icd10-medical-necessity.service';
import { MhpaeaParityService } from './services/mhpaea-parity.service';
import { ModifierService } from './services/modifier.service';
import { NcciService } from './services/ncci.service';
import { PayerRuleRepository } from './services/payer-rule.repository';
import { ProviderTaxonomyService } from './services/provider-taxonomy.service';
import { SudConsentService } from './services/sud-consent.service';
import { TimelyFilingService } from './services/timely-filing.service';

@Module({
  imports: [AuthModule, AscModule],
  providers: [
    LookupService,
    PayerRuleRepository,
    ModifierService,
    NcciService,
    TimelyFilingService,
    CobService,
    MedicalNecessityService,
    ProviderTaxonomyService,
    SudConsentService,
    MhpaeaParityService,
    DmepostService,
  ],
  controllers: [LookupController],
})
export class LookupModule {}
