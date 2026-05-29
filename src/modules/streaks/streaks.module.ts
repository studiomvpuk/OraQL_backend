import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaModule } from '../prisma/prisma.module';
import { StreakDetectionService } from './streak-detection.service';
import { StreakAnalysisService } from './streak-analysis.service';
import { PlayerValidationService } from './player-validation.service';
import { CrossLeagueService } from './cross-league.service';
import { StreakCronService } from './streak-cron.service';
import { StreaksController } from './streaks.controller';

@Module({
  imports: [PrismaModule, ScheduleModule.forRoot()],
  controllers: [StreaksController],
  providers: [
    StreakDetectionService,
    StreakAnalysisService,
    PlayerValidationService,
    CrossLeagueService,
    StreakCronService,
  ],
  exports: [
    StreakDetectionService,
    StreakAnalysisService,
    PlayerValidationService,
    CrossLeagueService,
  ],
})
export class StreaksModule {}
