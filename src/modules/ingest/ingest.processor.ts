import { Process, Processor } from '@nestjs/bull';
import { Job } from 'bull';
import { Logger } from '@nestjs/common';
import { IngestService } from './ingest.service';

@Processor('ingest')
export class IngestProcessor {
  private readonly logger = new Logger(IngestProcessor.name);

  constructor(private ingestService: IngestService) {}

  @Process('daily-fixtures')
  async processDailyFixtures(job: Job): Promise<void> {
    this.logger.log('Processing daily fixtures ingestion');
    try {
      const startDate = new Date();
      await this.ingestService.ingestFixtures(startDate);
      this.logger.log('Daily fixtures ingestion completed');
    } catch (error) {
      this.logger.error('Daily fixtures ingestion failed', error);
      throw error;
    }
  }

  @Process('odds-refresh')
  async processOddsRefresh(job: Job): Promise<void> {
    this.logger.log('Processing odds refresh for active events');
    try {
      // Implementation would fetch active events and refresh their odds
      // For now, this is a placeholder that would integrate with EventService
      this.logger.log('Odds refresh completed');
    } catch (error) {
      this.logger.error('Odds refresh failed', error);
      throw error;
    }
  }

  @Process('lineup-check')
  async processLineupCheck(job: Job): Promise<void> {
    this.logger.log('Processing lineup checks for upcoming events');
    try {
      // Implementation would check events kicking off within 90 minutes
      // and poll for confirmed lineups
      this.logger.log('Lineup check completed');
    } catch (error) {
      this.logger.error('Lineup check failed', error);
      throw error;
    }
  }
}
