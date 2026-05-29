import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { StreakDetectionService } from './streak-detection.service';

@Injectable()
export class StreakCronService {
  private readonly logger = new Logger(StreakCronService.name);

  constructor(private streakDetectionService: StreakDetectionService) {}

  /**
   * Daily streak detection at 6 AM.
   * Runs after:
   *   - 4 AM: fixture ingestion
   *   - 5 AM: player data ingestion
   * So all match data is fresh before we scan for streaks.
   */
  @Cron('0 6 * * *')
  async dailyStreakDetection(): Promise<void> {
    this.logger.log('Starting daily streak detection (SPOT engine)');
    try {
      const result = await this.streakDetectionService.detectAllStreaks();
      this.logger.log(
        `Daily streak detection complete: ${result.teamsScanned} teams, ` +
          `${result.streaksDetected} detected, ${result.streaksSaved} saved`,
      );
    } catch (error) {
      this.logger.error('Daily streak detection failed', error);
    }
  }
}
