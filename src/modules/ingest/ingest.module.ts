import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { ApiFootballAdapter } from './adapters/api-football.adapter';
import { OddsApiAdapter } from './adapters/odds-api.adapter';
import { IngestService } from './ingest.service';
import { IngestController } from './ingest.controller';

@Module({
  controllers: [IngestController],
  imports: [
    ConfigModule,
    PrismaModule,
    ScheduleModule.forRoot(),
  ],
  providers: [
    ApiFootballAdapter,
    OddsApiAdapter,
    IngestService,
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
