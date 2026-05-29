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
   * Ingest fixtures for a given date range.
   * @param startDate - Start date for fixture ingestion
   * @param days - Number of days to fetch (default 1; free API plan only allows ±1 day)
   */
  async ingestFixtures(startDate: Date, days = 1): Promise<void> {
    try {
      // Process date window (free plan: 1 day, paid: up to 7)
      for (let i = 0; i < days; i++) {
        const currentDate = new Date(startDate);
        currentDate.setDate(currentDate.getDate() + i);

        const fixtures = await this.apiFootballAdapter.getFixtures(currentDate);

        for (const fixture of fixtures) {
          // Upsert league (with name/logo from fixture data)
          const league = await this.prisma.league.upsert({
            where: { externalId: fixture.leagueExternalId },
            update: {
              ...(fixture.leagueName && { name: fixture.leagueName }),
              ...(fixture.leagueLogoUrl && { logoUrl: fixture.leagueLogoUrl }),
              ...(fixture.leagueCountry && { country: fixture.leagueCountry }),
            },
            create: {
              externalId: fixture.leagueExternalId,
              name: fixture.leagueName || 'Unknown League',
              sport: 'FOOTBALL',
              logoUrl: fixture.leagueLogoUrl,
              country: fixture.leagueCountry,
            },
          });

          // Upsert home team (leagueId set on create only — repair
          // endpoint fixes teams to their most-played league)
          const homeTeam = await this.prisma.team.upsert({
            where: { externalId: fixture.homeTeamExternalId },
            update: {
              ...(fixture.homeTeamName && { name: fixture.homeTeamName }),
              ...(fixture.homeTeamLogoUrl && { logoUrl: fixture.homeTeamLogoUrl }),
            },
            create: {
              externalId: fixture.homeTeamExternalId,
              name: fixture.homeTeamName || 'Unknown Team',
              sport: 'FOOTBALL',
              leagueId: league.id,
              logoUrl: fixture.homeTeamLogoUrl,
            },
          });

          // Upsert away team
          const awayTeam = await this.prisma.team.upsert({
            where: { externalId: fixture.awayTeamExternalId },
            update: {
              ...(fixture.awayTeamName && { name: fixture.awayTeamName }),
              ...(fixture.awayTeamLogoUrl && { logoUrl: fixture.awayTeamLogoUrl }),
            },
            create: {
              externalId: fixture.awayTeamExternalId,
              name: fixture.awayTeamName || 'Unknown Team',
              sport: 'FOOTBALL',
              leagueId: league.id,
              logoUrl: fixture.awayTeamLogoUrl,
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
              round: fixture.round != null ? String(fixture.round) : null,
              season: fixture.season != null ? String(fixture.season) : null,
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

  // ==========================================================================
  // PHASE 1: PLAYER-LEVEL DATA INGESTION
  // ==========================================================================

  /**
   * Daily ingest of player match data for recently finished events (5 AM).
   * Runs after fixture ingestion so new events exist in DB.
   */
  @Cron('0 5 * * *')
  async ingestDailyPlayerData(): Promise<void> {
    this.logger.log('Starting daily player data ingestion');
    try {
      await this.ingestQueue.add(
        'player-data-ingest',
        {},
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 3000 },
        },
      );
    } catch (error) {
      this.logger.error('Failed to queue player data ingest job', error);
    }
  }

  /**
   * Ingest player events + stats for all recently finished events
   * that don't already have player data.
   */
  async ingestPlayerDataForRecentEvents(): Promise<void> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    // Find finished events from the last 48 hours that have no player events yet
    const finishedEvents = await this.prisma.event.findMany({
      where: {
        status: 'FINISHED',
        kickoffAt: { gte: yesterday },
        playerEvents: { none: {} },
      },
      include: {
        homeTeam: true,
        awayTeam: true,
      },
      take: 50, // batch size to avoid rate limits
    });

    this.logger.log(
      `Ingesting player data for ${finishedEvents.length} finished events`,
    );

    for (const event of finishedEvents) {
      try {
        await this.ingestPlayerDataForEvent(event.id, event.externalId, event);
        await this.createIngestJob('PLAYER_DATA_INGEST', event.externalId, 'COMPLETED');
      } catch (error) {
        this.logger.warn(
          `Failed to ingest player data for event ${event.id}`,
          error,
        );
        await this.createIngestJob('PLAYER_DATA_INGEST', event.externalId, 'FAILED', error);
      }
    }
  }

  /**
   * Ingest player events (goals, cards, subs) and per-player match stats
   * for a single event.
   */
  async ingestPlayerDataForEvent(
    eventId: string,
    fixtureExternalId: string,
    event?: any,
  ): Promise<void> {
    if (!event) {
      event = await this.prisma.event.findUnique({
        where: { id: eventId },
        include: { homeTeam: true, awayTeam: true },
      });
    }
    if (!event) throw new Error(`Event ${eventId} not found`);

    // Build a lookup: externalId → internal team id
    const teamLookup: Record<string, string> = {
      [event.homeTeam.externalId]: event.homeTeam.id,
      [event.awayTeam.externalId]: event.awayTeam.id,
    };

    // --- 1. Fixture events (goals, cards, subs) ---
    if (this.apiFootballAdapter.getFixtureEvents) {
      const events = await this.apiFootballAdapter.getFixtureEvents(fixtureExternalId);

      for (const evt of events) {
        const teamId = teamLookup[evt.teamExternalId];
        if (!teamId) continue;

        // Resolve player (must exist in our DB)
        const player = await this.prisma.player.findUnique({
          where: { externalId: evt.playerExternalId },
        });
        if (!player) {
          // Auto-create placeholder player
          const newPlayer = await this.prisma.player.create({
            data: {
              externalId: evt.playerExternalId,
              name: `Player ${evt.playerExternalId}`,
              teamId,
            },
          });
          await this.upsertPlayerMatchEvent(eventId, newPlayer.id, teamId, evt);
        } else {
          await this.upsertPlayerMatchEvent(eventId, player.id, teamId, evt);
        }
      }

      this.logger.debug(
        `Ingested ${events.length} player events for fixture ${fixtureExternalId}`,
      );
    }

    // --- 2. Per-player match stats (SoT, crosses, tackles, rating) ---
    if (this.apiFootballAdapter.getFixturePlayerStats) {
      const playerStats = await this.apiFootballAdapter.getFixturePlayerStats(fixtureExternalId);

      for (const ps of playerStats) {
        const teamId = teamLookup[ps.teamExternalId];
        if (!teamId) continue;

        let player = await this.prisma.player.findUnique({
          where: { externalId: ps.playerExternalId },
        });

        if (!player) {
          player = await this.prisma.player.create({
            data: {
              externalId: ps.playerExternalId,
              name: `Player ${ps.playerExternalId}`,
              teamId,
            },
          });
        }

        await this.prisma.playerMatchStats.upsert({
          where: {
            eventId_playerId: {
              eventId,
              playerId: player.id,
            },
          },
          update: {
            minutesPlayed: ps.minutesPlayed,
            shotsTotal: ps.shotsTotal,
            shotsOnTarget: ps.shotsOnTarget,
            passes: ps.passes,
            passAccuracy: ps.passAccuracy,
            tackles: ps.tackles,
            duels: ps.duels,
            duelsWon: ps.duelsWon,
            dribbles: ps.dribbles,
            foulsCommitted: ps.foulsCommitted,
            foulsDrawn: ps.foulsDrawn,
            crosses: ps.crosses,
            rating: ps.rating,
          },
          create: {
            eventId,
            playerId: player.id,
            teamId,
            minutesPlayed: ps.minutesPlayed,
            shotsTotal: ps.shotsTotal,
            shotsOnTarget: ps.shotsOnTarget,
            passes: ps.passes,
            passAccuracy: ps.passAccuracy,
            tackles: ps.tackles,
            duels: ps.duels,
            duelsWon: ps.duelsWon,
            dribbles: ps.dribbles,
            foulsCommitted: ps.foulsCommitted,
            foulsDrawn: ps.foulsDrawn,
            crosses: ps.crosses,
            rating: ps.rating,
          },
        });
      }

      this.logger.debug(
        `Ingested ${playerStats.length} player match stats for fixture ${fixtureExternalId}`,
      );
    }
  }

  /**
   * Ingest season-level stats for all players on a given team.
   * Called per-team; batches API calls to respect rate limits.
   */
  async ingestPlayerSeasonStats(
    teamId: string,
    season: string,
  ): Promise<void> {
    if (!this.apiFootballAdapter.getPlayerSeasonStats) return;

    const team = await this.prisma.team.findUnique({
      where: { id: teamId },
      include: { players: true, league: true },
    });

    if (!team || !team.league) {
      this.logger.warn(`Team ${teamId} or its league not found — skipping season stats`);
      return;
    }

    this.logger.log(
      `Ingesting season stats for ${team.players.length} players on ${team.name}`,
    );

    for (const player of team.players) {
      try {
        const seasonStats = await this.apiFootballAdapter.getPlayerSeasonStats(
          player.externalId,
          season,
        );

        for (const ss of seasonStats) {
          // Resolve league
          const league = await this.prisma.league.findUnique({
            where: { externalId: ss.leagueExternalId },
          });
          if (!league) continue;

          await this.prisma.playerSeasonStats.upsert({
            where: {
              playerId_season_leagueId: {
                playerId: player.id,
                season: ss.season,
                leagueId: league.id,
              },
            },
            update: {
              appearances: ss.appearances,
              goals: ss.goals,
              assists: ss.assists,
              yellowCards: ss.yellowCards,
              redCards: ss.redCards,
              minutesPlayed: ss.minutesPlayed,
              shotsTotal: ss.shotsTotal,
              shotsOnTarget: ss.shotsOnTarget,
              passAccuracy: ss.passAccuracy,
              crosses: ss.crosses,
              rating: ss.rating,
            },
            create: {
              playerId: player.id,
              teamId: team.id,
              season: ss.season,
              leagueId: league.id,
              appearances: ss.appearances,
              goals: ss.goals,
              assists: ss.assists,
              yellowCards: ss.yellowCards,
              redCards: ss.redCards,
              minutesPlayed: ss.minutesPlayed,
              shotsTotal: ss.shotsTotal,
              shotsOnTarget: ss.shotsOnTarget,
              passAccuracy: ss.passAccuracy,
              crosses: ss.crosses,
              rating: ss.rating,
            },
          });
        }
      } catch (error) {
        this.logger.warn(
          `Failed to ingest season stats for player ${player.id}`,
          error,
        );
        // Continue with other players
      }
    }

    await this.createIngestJob('PLAYER_SEASON_STATS', teamId, 'COMPLETED');
  }

  // ==========================================================================
  // HISTORICAL FIXTURES BACKFILL
  // ==========================================================================

  /**
   * Backfill historical fixtures day-by-day.
   * Called from the Bull queue processor (long-running).
   */
  async backfillHistoricalFixtures(days: number): Promise<{
    daysSucceeded: number;
    daysFailed: number;
    totalEvents: number;
    finishedEvents: number;
  }> {
    this.logger.log(`Starting historical fixtures backfill for ${days} days`);

    let succeeded = 0;
    let failed = 0;

    for (let i = days; i >= 0; i--) {
      const date = new Date();
      date.setDate(date.getDate() - i);
      date.setHours(0, 0, 0, 0);

      try {
        await this.ingestFixtures(date, 1);
        succeeded++;

        if (succeeded % 10 === 0) {
          this.logger.log(
            `Backfill progress: ${succeeded}/${days + 1} days processed`,
          );
        }
      } catch (error) {
        failed++;
        this.logger.warn(
          `Failed to ingest fixtures for ${date.toISOString().split('T')[0]}`,
          error,
        );
      }
    }

    const totalEvents = await this.prisma.event.count();
    const finishedEvents = await this.prisma.event.count({
      where: { status: 'FINISHED' },
    });

    this.logger.log(
      `Fixtures backfill complete: ${succeeded} days ok, ${failed} failed. ` +
      `DB totals: ${totalEvents} events (${finishedEvents} finished)`,
    );

    return { daysSucceeded: succeeded, daysFailed: failed, totalEvents, finishedEvents };
  }

  // ==========================================================================
  // PHASE 2: TEAM-LEVEL MATCH STATS INGESTION (corners, cards, possession)
  // ==========================================================================

  /**
   * Daily ingest of team-level match stats for recently finished events (5:30 AM).
   * Runs after fixture + player data ingestion so events exist in DB.
   */
  @Cron('30 5 * * *')
  async ingestDailyMatchStats(): Promise<void> {
    this.logger.log('Starting daily match stats ingestion');
    try {
      await this.ingestQueue.add(
        'match-stats-ingest',
        {},
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 3000 },
        },
      );
    } catch (error) {
      this.logger.error('Failed to queue match stats ingest job', error);
    }
  }

  /**
   * Ingest team-level match statistics (corners, cards, possession, shots, fouls)
   * for all recently finished events that don't already have MatchStats records.
   */
  async ingestMatchStatsForFinishedEvents(
    cutoffDate?: Date,
    batchSize = 50,
  ): Promise<{ processed: number; succeeded: number; failed: number }> {
    const cutoff = cutoffDate || new Date(Date.now() - 48 * 60 * 60 * 1000); // default: last 48h

    // Find finished events that have NO matchStats yet
    const finishedEvents = await this.prisma.event.findMany({
      where: {
        status: 'FINISHED',
        kickoffAt: { gte: cutoff },
        matchStats: { none: {} },
      },
      include: {
        homeTeam: true,
        awayTeam: true,
      },
      take: batchSize,
      orderBy: { kickoffAt: 'desc' },
    });

    this.logger.log(
      `Ingesting match stats for ${finishedEvents.length} finished events (cutoff: ${cutoff.toISOString()})`,
    );

    let succeeded = 0;
    let failed = 0;

    for (const event of finishedEvents) {
      try {
        await this.ingestMatchStatsForEvent(event);
        succeeded++;
        await this.createIngestJob('MATCH_STATS_INGEST', event.externalId, 'COMPLETED');
      } catch (error) {
        failed++;
        this.logger.warn(
          `Failed to ingest match stats for event ${event.id} (ext: ${event.externalId})`,
          error,
        );
        await this.createIngestJob('MATCH_STATS_INGEST', event.externalId, 'FAILED', error);
      }
    }

    this.logger.log(
      `Match stats ingestion complete: ${succeeded} succeeded, ${failed} failed out of ${finishedEvents.length}`,
    );

    return { processed: finishedEvents.length, succeeded, failed };
  }

  /**
   * Ingest team-level match stats for a single event.
   * Calls API-Football /fixtures/statistics and upserts two MatchStats rows
   * (one per team).
   */
  private async ingestMatchStatsForEvent(event: any): Promise<void> {
    const statsData = await this.apiFootballAdapter.getMatchStats(event.externalId);

    if (!statsData || statsData.length === 0) {
      this.logger.debug(`No match stats returned for fixture ${event.externalId}`);
      return;
    }

    // Build lookup: external team ID → internal team ID
    const teamLookup: Record<string, string> = {
      [event.homeTeam.externalId]: event.homeTeam.id,
      [event.awayTeam.externalId]: event.awayTeam.id,
    };

    for (const stat of statsData) {
      const teamId = teamLookup[stat.teamExternalId];
      if (!teamId) {
        this.logger.debug(
          `Unknown team externalId ${stat.teamExternalId} for fixture ${event.externalId} — skipping`,
        );
        continue;
      }

      await this.prisma.matchStats.upsert({
        where: {
          eventId_teamId: {
            eventId: event.id,
            teamId,
          },
        },
        update: {
          goals: stat.goals,
          shotsTotal: stat.shotsTotal ?? null,
          shotsOnTarget: stat.shotsOnTarget ?? null,
          possession: stat.possession ?? null,
          corners: stat.corners,
          yellowCards: stat.yellowCards,
          redCards: stat.redCards,
          fouls: stat.fouls ?? null,
          offsides: stat.offsides ?? null,
        },
        create: {
          eventId: event.id,
          teamId,
          goals: stat.goals,
          shotsTotal: stat.shotsTotal ?? null,
          shotsOnTarget: stat.shotsOnTarget ?? null,
          possession: stat.possession ?? null,
          corners: stat.corners,
          yellowCards: stat.yellowCards,
          redCards: stat.redCards,
          fouls: stat.fouls ?? null,
          offsides: stat.offsides ?? null,
        },
      });
    }

    this.logger.debug(
      `Ingested ${statsData.length} team match stats for fixture ${event.externalId}`,
    );
  }

  // ==========================================================================
  // PRIVATE HELPERS
  // ==========================================================================

  private async upsertPlayerMatchEvent(
    eventId: string,
    playerId: string,
    teamId: string,
    evt: { type: string; minute: number; detail?: string },
  ): Promise<void> {
    const type = evt.type as any;
    try {
      await this.prisma.playerMatchEvent.upsert({
        where: {
          eventId_playerId_type_minute: {
            eventId,
            playerId,
            type,
            minute: evt.minute,
          },
        },
        update: { detail: evt.detail },
        create: {
          eventId,
          playerId,
          teamId,
          type,
          minute: evt.minute,
          detail: evt.detail,
        },
      });
    } catch (error) {
      this.logger.warn(
        `Failed to upsert player event: ${playerId} ${type} @ ${evt.minute}'`,
        error,
      );
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
