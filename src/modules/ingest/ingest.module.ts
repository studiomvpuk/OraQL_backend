import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bull';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../../prisma/prisma.module';
import { ApiFootballAdapter } from './adapters/api-football.adapter';
import { OddsApiAdapter } from './adapters/odds-api.adapter';
import { IngestService } from './ingest.service';
import { IngestProcessor } from './ingest.processor';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    ScheduleModule.forRoot(),
    BullModule.registerQueue({
      name: 'ingest',
    }),
  ],
  providers: [
    ApiFootballAdapter,
    OddsApiAdapter,
    IngestService,
    IngestProcessor,
    {
      provide: 'API_FOOTBALL_ADAPTER',
      useClass: ApiFootballAdapter,
    },
    {
      provide: 'ODDS_API_ADAPTER',
      useClass: OddsApiAdapter,
    },
  ],
  exports: [IngestService],
})
export class IngestModule {}
