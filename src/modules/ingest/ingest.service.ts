import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bull';
import { InjectQueue } from '@nestjs/bull';
import { PrismaService } from '../prisma/prisma.service';
import { IDataProvider } from './interfaces/data-provider.interface';

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    @Inject('API_FOOTBALL_ADAPTER')
    private apiFootballAdapter: IDataProvider,
    @Inject('ODDS_API_ADAPTER')
    private oddsApiAdapter: any,
    private prisma: PrismaService,
    @InjectQueue('ingest') private ingestQueue: Queue,
  ) {}

  /**
   * Daily ingest of fixtures (7-day window at 4 AM)
   */
  @Cron('0 4 * * *')
  async ingestDailyFixtures(): Promise<void> {
    this.logger.log('Starting daily fixture ingestion');
    try {
      await this.ingestQueue.add(
        'daily-fixtures',
        {},
        {
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      );
    } catch (error) {
      this.logger.error('Failed to queue daily fixtures job', error);
    }
  }

  /**
   * Refresh odds every 5 minutes for active events
   */
  @Cron('*/5 * * * *')
  async refreshOdds(): Promise<void> {
    try {
      await this.ingestQueue.add(
        'odds-refresh',
        {},
        {
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        },
      );
    } catch (error) {
      this.logger.error('Failed to queue odds refresh job', error);
    }
  }

  /**
   * Poll lineups every 10 minutes for events kicking off within 90 minutes
   */
  @Cron('*/10 * * * *')
  async pollLineups(): Promise<void> {
    try {
      await this.ingestQueue.add(
        'lineup-check',
        {},
        {
          attempts: 2,
          backoff: {
            type: 'exponential',
            delay: 1000,
          },
        },
      );
    } catch (error) {
      this.logger.error('Failed to queue lineup check job', error);
    }
  }

  /**
   * Ingest fixtures for a given date range
   */
  async ingestFixtures(startDate: Date): Promise<void> {
    try {
      // Process 7-day window
      for (let i = 0; i < 7; i++) {
        const currentDate = new Date(startDate);
        currentDate.setDate(currentDate.getDate() + i);

        const fixtures = await this.apiFootballAdapter.getFixtures(currentDate);

        for (const fixture of fixtures) {
          // Upsert league
          const league = await this.prisma.league.upsert({
            where: { externalId: fixture.leagueExternalId },
            update: {},
            create: {
              externalId: fixture.leagueExternalId,
              name: '', // Will be fetched separately
              sport: 'FOOTBALL',
            },
          });

          // Upsert home team
          const homeTeam = await this.prisma.team.upsert({
            where: { externalId: fixture.homeTeamExternalId },
            update: {},
            create: {
              externalId: fixture.homeTeamExternalId,
              name: '', // Will be fetched separately
              sport: 'FOOTBALL',
              leagueId: league.id,
            },
          });

          // Upsert away team
          const awayTeam = await this.prisma.team.upsert({
            where: { externalId: fixture.awayTeamExternalId },
            update: {},
            create: {
              externalId: fixture.awayTeamExternalId,
              name: '', // Will be fetched separately
              sport: 'FOOTBALL',
              leagueId: league.id,
            },
          });

          // Upsert event (fixture)
          await this.prisma.event.upsert({
            where: { externalId: fixture.externalId },
            update: {
              status: fixture.status,
              kickoffAt: fixture.kickoffAt,
              homeScore: fixture.homeScore,
              awayScore: fixture.awayScore,
              updatedAt: new Date(),
            },
            create: {
              externalId: fixture.externalId,
              leagueId: league.id,
              homeTeamId: homeTeam.id,
              awayTeamId: awayTeam.id,
              sport: 'FOOTBALL',
              kickoffAt: fixture.kickoffAt,
              status: fixture.status,
              venue: fixture.venue,
              round: fixture.round,
              season: fixture.season,
              homeScore: fixture.homeScore,
              awayScore: fixture.awayScore,
            },
          });

          // Track ingest job
          await this.createIngestJob('FIXTURE_INGEST', fixture.externalId, 'COMPLETED');
        }
      }

      this.logger.log('Fixture ingestion completed successfully');
    } catch (error) {
      this.logger.error('Fixture ingestion failed', error);
      await this.createIngestJob('FIXTURE_INGEST', null, 'FAILED', error);
      throw error;
    }
  }

  /**
   * Refresh odds for all active (SCHEDULED or LIVE) events
   */
  async refreshOddsForActiveEvents(): Promise<void> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 24 * 60 * 60 * 1000); // next 24 hours

    const activeEvents = await this.prisma.event.findMany({
      where: {
        status: { in: ['SCHEDULED', 'LIVE', 'LINEUP_CONFIRMED'] },
        kickoffAt: { lte: windowEnd },
      },
      select: { id: true, externalId: true },
    });

    this.logger.log(`Refreshing odds for ${activeEvents.length} active events`);

    for (const event of activeEvents) {
      try {
        await this.ingestOdds(event.id);
      } catch (error) {
        this.logger.warn(`Failed to refresh odds for event ${event.id}`, error);
        // Continue processing other events
      }
    }
  }

  /**
   * Check lineups for events kicking off within 90 minutes (per PRD US-7.2)
   */
  async checkLineupsForUpcomingEvents(): Promise<void> {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + 90 * 60 * 1000); // 90 minutes ahead

    const upcomingEvents = await this.prisma.event.findMany({
      where: {
        status: { in: ['SCHEDULED', 'LINEUP_CONFIRMED'] },
        kickoffAt: {
          gte: now,
          lte: windowEnd,
        },
      },
      include: {
        homeTeam: true,
        awayTeam: true,
        lineups: true,
      },
    });

    this.logger.log(`Checking lineups for ${upcomingEvents.length} upcoming events`);

    for (const event of upcomingEvents) {
      try {
        // Fetch lineups from data provider
        const lineupData = await this.apiFootballAdapter.getLineups(event.externalId);

        if (!lineupData || lineupData.length === 0) {
          continue; // No lineup data yet
        }

        for (const lineup of lineupData) {
          // Determine which team this lineup is for
          const teamId =
            lineup.teamExternalId === event.homeTeam.externalId
              ? event.homeTeam.id
              : lineup.teamExternalId === event.awayTeam.externalId
                ? event.awayTeam.id
                : null;

          if (!teamId) continue;

          // Upsert lineup
          const savedLineup = await this.prisma.lineup.upsert({
            where: {
              eventId_teamId: {
                eventId: event.id,
                teamId,
              },
            },
            update: {
              formation: lineup.formation || null,
              isConfirmed: true,
              confirmedAt: new Date(),
            },
            create: {
              eventId: event.id,
              teamId,
              formation: lineup.formation || null,
              isConfirmed: true,
              confirmedAt: new Date(),
            },
          });

          // Upsert lineup entries (players)
          if (lineup.players && lineup.players.length > 0) {
            // Clear existing entries and re-create
            await this.prisma.lineupEntry.deleteMany({
              where: { lineupId: savedLineup.id },
            });

            for (const playerData of lineup.players) {
              // Find or skip player
              const player = await this.prisma.player.findUnique({
                where: { externalId: playerData.playerExternalId },
              });

              if (player) {
                await this.prisma.lineupEntry.create({
                  data: {
                    lineupId: savedLineup.id,
                    playerId: player.id,
                    isStarter: playerData.isStarter ?? true,
                    position: playerData.position || null,
                    shirtNumber: playerData.shirtNumber || null,
                  },
                });
              }
            }
          }
        }

        // Update event status to LINEUP_CONFIRMED if it was SCHEDULED
        if (event.status === 'SCHEDULED') {
          await this.prisma.event.update({
            where: { id: event.id },
            data: { status: 'LINEUP_CONFIRMED' },
          });
        }

        await this.createIngestJob('LINEUP_CHECK', event.externalId, 'COMPLETED');
        this.logger.debug(`Lineup confirmed for event ${event.id}`);
      } catch (error) {
        this.logger.warn(`Failed to check lineup for event ${event.id}`, error);
        await this.createIngestJob('LINEUP_CHECK', event.externalId, 'FAILED', error);
      }
    }
  }

  /**
   * Ingest odds for an event
   */
  async ingestOdds(eventId: string): Promise<void> {
    try {
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
      });

      if (!event) {
        throw new Error(`Event ${eventId} not found`);
      }

      const odds = await this.oddsApiAdapter.getOdds(event.externalId);

      for (const oddData of odds) {
        await this.prisma.bookmakerOdds.upsert({
          where: {
            eventId_bookmaker_marketName_line: {
              eventId,
              bookmaker: oddData.bookmaker,
              marketName: oddData.marketName,
              line: oddData.line ?? 0,
            },
          },
          update: {
            odds: oddData.odds,
            impliedProbability: oddData.impliedProbability,
            lastUpdatedAt: new Date(),
          },
          create: {
            eventId,
            bookmaker: oddData.bookmaker,
            marketName: oddData.marketName,
            line: oddData.line ?? 0,
            odds: oddData.odds,
            impliedProbability: oddData.impliedProbability,
            lastUpdatedAt: new Date(),
          },
        });
      }

      await this.createIngestJob('ODDS_INGEST', eventId, 'COMPLETED');
      this.logger.debug(`Odds ingestion completed for event ${eventId}`);
    } catch (error) {
      this.logger.error(`Odds ingestion failed for event ${eventId}`, error);
      await this.createIngestJob('ODDS_INGEST', eventId, 'FAILED', error);
      throw error;
    }
  }

  /**
   * Create ingest job tracking record
   */
  private async createIngestJob(
    jobType: string,
    externalId: string | null,
    status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED',
    error?: any,
  ): Promise<void> {
    try {
      await this.prisma.ingestJob.create({
        data: {
          type: jobType,
          jobType,
          externalId,
          status,
          errorMessage: error ? JSON.stringify(error) : null,
          processedAt: status === 'COMPLETED' ? new Date() : null,
        },
      });
    } catch (err) {
      this.logger.error('Failed to create ingest job record', err);
    }
  }
}
