import { Module } from '@nestjs/common';
import { Cms0057PaAdapter } from './pa-adapter';

@Module({
  providers: [Cms0057PaAdapter],
  exports: [Cms0057PaAdapter],
})
export class Cms0057Module {}
