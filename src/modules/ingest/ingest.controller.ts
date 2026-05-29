import { Controller, Post, Body, Logger, HttpCode } from '@nestjs/common';
import { IsOptional, IsIn, IsInt, Min, Max } from 'class-validator';
import { IngestService } from './ingest.service';

class TriggerIngestDto {
  @IsOptional()
  @IsIn(['fixtures', 'odds', 'lineups', 'player-data', 'all'])
  type?: 'fixtures' | 'odds' | 'lineups' | 'player-data' | 'all';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  days?: number;
}

class BackfillPlayerDataDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  days?: number;
}

class BackfillSeasonStatsDto {
  @IsOptional()
  season?: string;
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
        await this.ingestService.ingestFixtures(startDate, dto.days || 1);
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

      if (type === 'player-data' || type === 'all') {
        await this.ingestService.ingestPlayerDataForRecentEvents();
        results['player-data'] = 'completed';
      }

      return { triggered: type, results };
    } catch (error) {
      this.logger.error(`Manual ingest failed: ${type}`, error);
      throw error;
    }
  }

  /**
   * Backfill player match data for finished events over the last N days.
   * POST /api/v1/ingest/backfill/player-data
   * Body: { days?: number } (default 7, max 30)
   */
  @Post('backfill/player-data')
  @HttpCode(200)
  async backfillPlayerData(@Body() dto: BackfillPlayerDataDto) {
    const days = dto.days || 7;
    this.logger.log(`Backfilling player data for last ${days} days`);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);

    const finishedEvents = await this.ingestService['prisma'].event.findMany({
      where: {
        status: 'FINISHED',
        kickoffAt: { gte: cutoff },
        playerEvents: { none: {} },
      },
      select: { id: true, externalId: true },
    });

    this.logger.log(`Found ${finishedEvents.length} events to backfill`);

    let succeeded = 0;
    let failed = 0;

    for (const event of finishedEvents) {
      try {
        await this.ingestService.ingestPlayerDataForEvent(event.id, event.externalId);
        succeeded++;
      } catch {
        failed++;
      }
    }

    return {
      backfill: 'player-data',
      days,
      totalEvents: finishedEvents.length,
      succeeded,
      failed,
    };
  }

  /**
   * Backfill season stats for all players on all active teams.
   * POST /api/v1/ingest/backfill/season-stats
   * Body: { season?: string } (default current year)
   */
  @Post('backfill/season-stats')
  @HttpCode(200)
  async backfillSeasonStats(@Body() dto: BackfillSeasonStatsDto) {
    const season = dto.season || String(new Date().getFullYear());
    this.logger.log(`Backfilling season stats for season ${season}`);

    const teams = await this.ingestService['prisma'].team.findMany({
      where: { players: { some: {} } },
      select: { id: true, name: true },
    });

    let succeeded = 0;
    let failed = 0;

    for (const team of teams) {
      try {
        await this.ingestService.ingestPlayerSeasonStats(team.id, season);
        succeeded++;
      } catch {
        failed++;
      }
    }

    return {
      backfill: 'season-stats',
      season,
      totalTeams: teams.length,
      succeeded,
      failed,
    };
  }
}
