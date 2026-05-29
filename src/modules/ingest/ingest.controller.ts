import { Controller, Post, Body, Logger, HttpCode } from '@nestjs/common';
import { IsOptional, IsIn, IsInt, Min, Max } from 'class-validator';
import { IngestService } from './ingest.service';

class TriggerIngestDto {
  @IsOptional()
  @IsIn(['fixtures', 'odds', 'lineups', 'player-data', 'match-stats', 'all'])
  type?: 'fixtures' | 'odds' | 'lineups' | 'player-data' | 'match-stats' | 'all';

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(7)
  days?: number;
}

class BackfillFixturesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  days?: number;
}

class BackfillPlayerDataDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(30)
  days?: number;
}

class BackfillMatchStatsDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(90)
  days?: number;

  @IsOptional()
  @IsInt()
  @Min(10)
  @Max(200)
  batchSize?: number;
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

      if (type === 'match-stats' || type === 'all') {
        const statsResult = await this.ingestService.ingestMatchStatsForFinishedEvents();
        results['match-stats'] = `completed (${statsResult.succeeded}/${statsResult.processed})`;
      }

      return { triggered: type, results };
    } catch (error) {
      this.logger.error(`Manual ingest failed: ${type}`, error);
      throw error;
    }
  }

  /**
   * Backfill historical fixtures day-by-day.
   * POST /api/v1/ingest/backfill/fixtures
   * Body: { days?: number } (default 60, max 180)
   *
   * Loops from (today - days) to today, calling ingestFixtures for each date.
   * This populates enough match history per team for streak detection
   * (need 3+ matches per team). Rate-limited to 30 req/min by the adapter.
   *
   * NOTE: This is a long-running request. 60 days ≈ 60 API calls ≈ 2-3 minutes.
   */
  @Post('backfill/fixtures')
  @HttpCode(200)
  async backfillFixtures(@Body() dto: BackfillFixturesDto) {
    const days = dto.days || 60;
    this.logger.log(`Backfilling fixtures for last ${days} days`);

    let succeeded = 0;
    let failed = 0;
    let totalFixtures = 0;

    for (let i = days; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);

      try {
        // Count events before ingest to track new additions
        const beforeCount = await this.ingestService['prisma'].event.count();
        await this.ingestService.ingestFixtures(date, 1);
        const afterCount = await this.ingestService['prisma'].event.count();
        const added = afterCount - beforeCount;
        totalFixtures += added;
        succeeded++;

        if (succeeded % 10 === 0) {
          this.logger.log(
            `Backfill progress: ${succeeded}/${days + 1} days processed, ${totalFixtures} new fixtures`,
          );
        }
      } catch (error) {
        failed++;
        this.logger.warn(`Failed to ingest fixtures for date ${date.toISOString().split('T')[0]}`, error);
      }
    }

    // Count final totals
    const totalEvents = await this.ingestService['prisma'].event.count();
    const finishedEvents = await this.ingestService['prisma'].event.count({
      where: { status: 'FINISHED' },
    });

    this.logger.log(
      `Fixtures backfill complete: ${succeeded} days ok, ${failed} failed, ` +
      `${totalFixtures} new fixtures. DB totals: ${totalEvents} events (${finishedEvents} finished)`,
    );

    return {
      backfill: 'fixtures',
      days,
      daysSucceeded: succeeded,
      daysFailed: failed,
      newFixtures: totalFixtures,
      totalEventsInDb: totalEvents,
      finishedEventsInDb: finishedEvents,
    };
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
   * Backfill team-level match statistics for finished events over the last N days.
   * POST /api/v1/ingest/backfill/match-stats
   * Body: { days?: number, batchSize?: number } (default 30 days, 50 per batch)
   *
   * This populates MatchStats (corners, cards, possession, etc.) needed for
   * streak detection on non-goals markets.
   */
  @Post('backfill/match-stats')
  @HttpCode(200)
  async backfillMatchStats(@Body() dto: BackfillMatchStatsDto) {
    const days = dto.days || 30;
    const batchSize = dto.batchSize || 50;
    this.logger.log(`Backfilling match stats for last ${days} days (batch: ${batchSize})`);

    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    cutoff.setHours(0, 0, 0, 0);

    // Count total events to process
    const totalCount = await this.ingestService['prisma'].event.count({
      where: {
        status: 'FINISHED',
        kickoffAt: { gte: cutoff },
        matchStats: { none: {} },
      },
    });

    this.logger.log(`Found ${totalCount} events without match stats in last ${days} days`);

    let totalSucceeded = 0;
    let totalFailed = 0;
    let totalProcessed = 0;

    // Process in batches to avoid overwhelming the API rate limit
    while (totalProcessed < totalCount) {
      const result = await this.ingestService.ingestMatchStatsForFinishedEvents(
        cutoff,
        batchSize,
      );

      totalSucceeded += result.succeeded;
      totalFailed += result.failed;
      totalProcessed += result.processed;

      // If no more events were found, stop
      if (result.processed === 0) break;

      this.logger.log(
        `Batch complete: ${totalProcessed}/${totalCount} processed (${totalSucceeded} ok, ${totalFailed} failed)`,
      );
    }

    return {
      backfill: 'match-stats',
      days,
      totalEvents: totalCount,
      succeeded: totalSucceeded,
      failed: totalFailed,
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
