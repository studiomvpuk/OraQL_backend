import { Controller, Post, Body, Logger, HttpCode } from '@nestjs/common';
import { IngestService } from './ingest.service';

class TriggerIngestDto {
  type?: 'fixtures' | 'odds' | 'lineups' | 'all';
}

@Controller('ingest')
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(private ingestService: IngestService) {}

  /**
   * Manual trigger for data ingestion.
   * POST /api/v1/ingest/trigger
   *
   * Body: { type?: 'fixtures' | 'odds' | 'lineups' | 'all' }
   * Defaults to 'fixtures' if not specified.
   */
  @Post('trigger')
  @HttpCode(200)
  async triggerIngest(@Body() dto: TriggerIngestDto) {
    const type = dto.type || 'fixtures';
    this.logger.log(`Manual ingest triggered: ${type}`);

    const results: Record<string, string> = {};

    try {
      if (type === 'fixtures' || type === 'all') {
        const startDate = new Date();
        await this.ingestService.ingestFixtures(startDate);
        results.fixtures = 'completed';
      }

      if (type === 'odds' || type === 'all') {
        await this.ingestService.refreshOddsForActiveEvents();
        results.odds = 'completed';
      }

      if (type === 'lineups' || type === 'all') {
        await this.ingestService.checkLineupsForUpcomingEvents();
        results.lineups = 'completed';
      }

      return { triggered: type, results };
    } catch (error) {
      this.logger.error(`Manual ingest failed: ${type}`, error);
      throw error;
    }
  }
}
