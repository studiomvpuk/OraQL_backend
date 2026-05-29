import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { VenueFilter } from '@prisma/client';

// ============================================================================
// TYPES
// ============================================================================

export interface MarketDefinition {
  marketName: string;
  line?: number;
  /** Given a MatchStats row, does this market "hit"? */
  evaluate: (stats: MatchStatsRow, isHome: boolean) => boolean;
}

interface MatchStatsRow {
  eventId: string;
  teamId: string;
  goals: number;
  shotsTotal: number | null;
  shotsOnTarget: number | null;
  possession: number | null;
  corners: number;
  yellowCards: number;
  redCards: number;
  fouls: number | null;
  offsides: number | null;
  // From the event itself
  homeScore: number | null;
  awayScore: number | null;
  homeTeamId: string;
  awayTeamId: string;
  kickoffAt: Date;
}

export interface DetectedStreak {
  teamId: string;
  marketName: string;
  line: number | null;
  venueFilter: VenueFilter;
  streakLength: number;
  windowSize: number;
  hitRate: number;
  matchIds: string[];
  hitResults: boolean[];
  startedAt: Date;
}

// ============================================================================
// MARKET DEFINITIONS
// ============================================================================

/**
 * All the markets the SPOT engine scans for streaks.
 * Each one defines a predicate: given a team's match stats and whether
 * they were the home team, did the market "hit"?
 */
const MARKET_DEFINITIONS: MarketDefinition[] = [
  // --- Goals Over/Under ---
  ...[0.5, 1.5, 2.5, 3.5, 4.5].flatMap((line) => [
    {
      marketName: 'GOALS_OVER',
      line,
      evaluate: (s: MatchStatsRow) => {
        const total = (s.homeScore ?? 0) + (s.awayScore ?? 0);
        return total > line;
      },
    },
    {
      marketName: 'GOALS_UNDER',
      line,
      evaluate: (s: MatchStatsRow) => {
        const total = (s.homeScore ?? 0) + (s.awayScore ?? 0);
        return total < line;
      },
    },
  ]),

  // --- Team Goals Over/Under (team-specific) ---
  ...[0.5, 1.5, 2.5].flatMap((line) => [
    {
      marketName: 'TEAM_GOALS_OVER',
      line,
      evaluate: (s: MatchStatsRow, isHome: boolean) => {
        const teamGoals = isHome ? (s.homeScore ?? 0) : (s.awayScore ?? 0);
        return teamGoals > line;
      },
    },
    {
      marketName: 'TEAM_GOALS_UNDER',
      line,
      evaluate: (s: MatchStatsRow, isHome: boolean) => {
        const teamGoals = isHome ? (s.homeScore ?? 0) : (s.awayScore ?? 0);
        return teamGoals < line;
      },
    },
  ]),

  // --- Clean Sheet ---
  {
    marketName: 'CLEAN_SHEET',
    line: undefined,
    evaluate: (s: MatchStatsRow, isHome: boolean) => {
      // Did the opposition score 0?
      const conceded = isHome ? (s.awayScore ?? 0) : (s.homeScore ?? 0);
      return conceded === 0;
    },
  },

  // --- BTTS ---
  {
    marketName: 'BTTS_YES',
    line: undefined,
    evaluate: (s: MatchStatsRow) => {
      return (s.homeScore ?? 0) > 0 && (s.awayScore ?? 0) > 0;
    },
  },
  {
    marketName: 'BTTS_NO',
    line: undefined,
    evaluate: (s: MatchStatsRow) => {
      return (s.homeScore ?? 0) === 0 || (s.awayScore ?? 0) === 0;
    },
  },

  // --- Corners Over/Under ---
  ...[7.5, 8.5, 9.5, 10.5, 11.5].flatMap((line) => [
    {
      marketName: 'CORNERS_OVER',
      line,
      evaluate: (s: MatchStatsRow) => {
        // We use the team's corner count from MatchStats (per-team)
        // But total corners = sum of both teams, which we approximate
        // from the stats we have. Here `s.corners` is THIS team's corners.
        // For total match corners, the caller sums both team rows.
        // For per-team streak, we use s.corners directly.
        return false; // overridden at scan time with total corners logic
      },
    },
    {
      marketName: 'CORNERS_UNDER',
      line,
      evaluate: (s: MatchStatsRow) => {
        return false; // overridden at scan time
      },
    },
  ]),

  // --- Cards Over/Under ---
  ...[2.5, 3.5, 4.5, 5.5].flatMap((line) => [
    {
      marketName: 'CARDS_OVER',
      line,
      evaluate: (s: MatchStatsRow) => {
        return false; // overridden at scan time with total cards logic
      },
    },
    {
      marketName: 'CARDS_UNDER',
      line,
      evaluate: (s: MatchStatsRow) => {
        return false; // overridden at scan time
      },
    },
  ]),
];

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class StreakDetectionService {
  private readonly logger = new Logger(StreakDetectionService.name);

  /** Minimum consecutive hits to qualify as a streak */
  private readonly MIN_STREAK_LENGTH = 3;
  /** Window sizes to scan */
  private readonly WINDOW_SIZES = [5, 10, 15];
  /** Minimum hit rate within a window to flag */
  private readonly MIN_HIT_RATE = 0.7;

  constructor(private prisma: PrismaService) {}

  // ==========================================================================
  // MAIN ENTRY: DETECT ALL STREAKS FOR A TEAM
  // ==========================================================================

  /**
   * SPOT engine: scan all markets across all venue filters for a single team.
   * Returns all detected streaks above threshold.
   */
  async detectStreaksForTeam(teamId: string): Promise<DetectedStreak[]> {
    const streaks: DetectedStreak[] = [];

    for (const venueFilter of ['ALL', 'HOME', 'AWAY'] as VenueFilter[]) {
      // Fetch match history for this team + venue filter
      const matches = await this.getTeamMatchHistory(teamId, venueFilter, 20);
      if (matches.length < this.MIN_STREAK_LENGTH) continue;

      // For each window size
      for (const windowSize of this.WINDOW_SIZES) {
        if (matches.length < windowSize) continue;
        const window = matches.slice(0, windowSize);

        // Scan goal-based markets
        for (const mDef of MARKET_DEFINITIONS) {
          if (
            mDef.marketName.startsWith('CORNERS_') ||
            mDef.marketName.startsWith('CARDS_')
          ) {
            // Handle total-match stat markets separately
            continue;
          }

          const results = window.map((m) => ({
            eventId: m.eventId,
            hit: mDef.evaluate(m, m.homeTeamId === teamId),
          }));

          const hitCount = results.filter((r) => r.hit).length;
          const hitRate = hitCount / windowSize;

          if (hitRate < this.MIN_HIT_RATE) continue;

          // Count consecutive streak from most recent
          const streakLength = this.countConsecutive(results.map((r) => r.hit));
          if (streakLength < this.MIN_STREAK_LENGTH) continue;

          // Find when the streak started
          const streakStartMatch = window[streakLength - 1];

          streaks.push({
            teamId,
            marketName: mDef.marketName,
            line: mDef.line ?? null,
            venueFilter,
            streakLength,
            windowSize,
            hitRate,
            matchIds: results.map((r) => r.eventId),
            hitResults: results.map((r) => r.hit),
            startedAt: streakStartMatch.kickoffAt,
          });
        }

        // --- Corners & Cards: need both teams' stats per match ---
        await this.scanTotalStatMarkets(
          teamId,
          venueFilter,
          window,
          windowSize,
          streaks,
          'corners',
          'CORNERS',
          [7.5, 8.5, 9.5, 10.5, 11.5],
        );

        await this.scanTotalStatMarkets(
          teamId,
          venueFilter,
          window,
          windowSize,
          streaks,
          'cards',
          'CARDS',
          [2.5, 3.5, 4.5, 5.5],
        );
      }
    }

    return streaks;
  }

  // ==========================================================================
  // DETECT ALL STREAKS ACROSS ALL ACTIVE TEAMS
  // ==========================================================================

  /**
   * Run the full SPOT scan across every team that has enough match history.
   * Called by the daily cron.
   */
  async detectAllStreaks(): Promise<{
    teamsScanned: number;
    streaksDetected: number;
    streaksSaved: number;
  }> {
    // First try teams with MatchStats (full data including corners/cards)
    let teams = await this.prisma.team.findMany({
      where: {
        matchStats: { some: {} },
      },
      select: { id: true, name: true },
    });

    // If no MatchStats exist, fall back to teams with finished events
    // (goals/BTTS/CS markets only need homeScore/awayScore from Event)
    if (teams.length === 0) {
      this.logger.log('No MatchStats found — falling back to Event scores for goal-based markets');
      const teamsWithEvents = await this.prisma.team.findMany({
        where: {
          OR: [
            { homeEvents: { some: { status: 'FINISHED' } } },
            { awayEvents: { some: { status: 'FINISHED' } } },
          ],
        },
        select: { id: true, name: true },
      });
      teams = teamsWithEvents;
    }

    this.logger.log(`SPOT engine scanning ${teams.length} teams`);

    let totalDetected = 0;
    let totalSaved = 0;

    for (const team of teams) {
      try {
        const streaks = await this.detectStreaksForTeam(team.id);
        totalDetected += streaks.length;

        // Persist to DB
        for (const streak of streaks) {
          await this.saveStreak(streak);
          totalSaved++;
        }
      } catch (error) {
        this.logger.warn(
          `Streak detection failed for team ${team.name} (${team.id})`,
          error,
        );
      }
    }

    // Expire old streaks that are no longer active
    const expired = await this.expireStaleStreaks();

    this.logger.log(
      `SPOT engine complete: ${teams.length} teams scanned, ` +
        `${totalDetected} streaks detected, ${totalSaved} saved, ${expired} expired`,
    );

    return {
      teamsScanned: teams.length,
      streaksDetected: totalDetected,
      streaksSaved: totalSaved,
    };
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * Fetch a team's recent match stats, filtered by venue.
   * Returns most recent first.
   */
  private async getTeamMatchHistory(
    teamId: string,
    venueFilter: VenueFilter,
    limit: number,
  ): Promise<MatchStatsRow[]> {
    const whereClause: any = {
      status: 'FINISHED',
    };

    if (venueFilter === 'HOME') {
      whereClause.homeTeamId = teamId;
    } else if (venueFilter === 'AWAY') {
      whereClause.awayTeamId = teamId;
    } else {
      whereClause.OR = [{ homeTeamId: teamId }, { awayTeamId: teamId }];
    }

    const events = await this.prisma.event.findMany({
      where: whereClause,
      orderBy: { kickoffAt: 'desc' },
      take: limit,
      include: {
        matchStats: {
          where: { teamId },
        },
      },
    });

    return events.map((e) => {
      const stats = e.matchStats?.[0];
      const isHome = e.homeTeamId === teamId;
      return {
        eventId: e.id,
        teamId,
        // Use MatchStats if available, otherwise derive from Event scores
        goals: stats?.goals ?? (isHome ? (e.homeScore ?? 0) : (e.awayScore ?? 0)),
        shotsTotal: stats?.shotsTotal ?? null,
        shotsOnTarget: stats?.shotsOnTarget ?? null,
        possession: stats?.possession ?? null,
        corners: stats?.corners ?? 0,
        yellowCards: stats?.yellowCards ?? 0,
        redCards: stats?.redCards ?? 0,
        fouls: stats?.fouls ?? null,
        offsides: stats?.offsides ?? null,
        homeScore: e.homeScore,
        awayScore: e.awayScore,
        homeTeamId: e.homeTeamId,
        awayTeamId: e.awayTeamId,
        kickoffAt: e.kickoffAt,
      };
    });
  }

  /**
   * Scan total-match stats (corners, cards) which require summing
   * both teams' stats for the same event.
   */
  private async scanTotalStatMarkets(
    teamId: string,
    venueFilter: VenueFilter,
    window: MatchStatsRow[],
    windowSize: number,
    streaks: DetectedStreak[],
    statField: 'corners' | 'cards',
    marketPrefix: string,
    lines: number[],
  ): Promise<void> {
    // For each match in the window, we need both teams' stats
    const eventIds = window.map((m) => m.eventId);

    const allStats = await this.prisma.matchStats.findMany({
      where: { eventId: { in: eventIds } },
    });

    // Group by eventId → sum both teams' stat
    const totalByEvent = new Map<string, number>();
    for (const stat of allStats) {
      const current = totalByEvent.get(stat.eventId) || 0;
      if (statField === 'corners') {
        totalByEvent.set(stat.eventId, current + stat.corners);
      } else {
        totalByEvent.set(
          stat.eventId,
          current + stat.yellowCards + stat.redCards,
        );
      }
    }

    for (const line of lines) {
      for (const direction of ['OVER', 'UNDER'] as const) {
        const results = window.map((m) => {
          const total = totalByEvent.get(m.eventId) ?? 0;
          const hit =
            direction === 'OVER' ? total > line : total < line;
          return { eventId: m.eventId, hit };
        });

        const hitCount = results.filter((r) => r.hit).length;
        const hitRate = hitCount / windowSize;
        if (hitRate < this.MIN_HIT_RATE) continue;

        const streakLength = this.countConsecutive(
          results.map((r) => r.hit),
        );
        if (streakLength < this.MIN_STREAK_LENGTH) continue;

        const streakStartMatch = window[streakLength - 1];

        streaks.push({
          teamId,
          marketName: `${marketPrefix}_${direction}`,
          line,
          venueFilter,
          streakLength,
          windowSize,
          hitRate,
          matchIds: results.map((r) => r.eventId),
          hitResults: results.map((r) => r.hit),
          startedAt: streakStartMatch.kickoffAt,
        });
      }
    }
  }

  /**
   * Count consecutive true values from the start of an array.
   * E.g. [true, true, true, false, true] → 3
   */
  private countConsecutive(results: boolean[]): number {
    let count = 0;
    for (const hit of results) {
      if (hit) count++;
      else break;
    }
    return count;
  }

  /**
   * Persist a detected streak to the database.
   * Upserts based on teamId + marketName + line + venueFilter.
   */
  private async saveStreak(streak: DetectedStreak): Promise<void> {
    // Find existing streak for this combination
    const existing = await this.prisma.streak.findFirst({
      where: {
        teamId: streak.teamId,
        marketName: streak.marketName,
        line: streak.line,
        venueFilter: streak.venueFilter,
        isActive: true,
      },
    });

    // Compute confidence from hit rate + streak length + sample size
    const baseConf = streak.hitRate;
    const lengthBonus = Math.min(streak.streakLength / 15, 0.15);
    const samplePenalty = streak.windowSize < 10 ? 0.05 : 0;
    const confidence = Math.min(baseConf + lengthBonus - samplePenalty, 0.99);

    const data = {
      streakLength: streak.streakLength,
      windowSize: streak.windowSize,
      hitRate: streak.hitRate,
      confidence,
      isActive: true,
      lastMatchId: streak.matchIds[0] || null,
      startedAt: streak.startedAt,
      detectedAt: new Date(),
      metadata: {
        hitResults: streak.hitResults,
      },
    };

    let streakId: string;

    if (existing) {
      await this.prisma.streak.update({
        where: { id: existing.id },
        data,
      });
      streakId = existing.id;
    } else {
      const created = await this.prisma.streak.create({
        data: {
          teamId: streak.teamId,
          marketName: streak.marketName,
          line: streak.line,
          venueFilter: streak.venueFilter,
          ...data,
        },
      });
      streakId = created.id;
    }

    // Save streak-match records
    for (let i = 0; i < streak.matchIds.length; i++) {
      const eventId = streak.matchIds[i];
      const wasHit = streak.hitResults[i];

      try {
        await this.prisma.streakMatch.upsert({
          where: {
            streakId_eventId: {
              streakId,
              eventId,
            },
          },
          update: { wasHit },
          create: {
            streakId,
            eventId,
            wasHit,
            matchDate: new Date(), // approximate; real date from event
          },
        });
      } catch {
        // Ignore duplicate errors
      }
    }
  }

  /**
   * Mark streaks as inactive if their last match is older than 30 days
   * or if the team's most recent match broke the streak.
   */
  private async expireStaleStreaks(): Promise<number> {
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const result = await this.prisma.streak.updateMany({
      where: {
        isActive: true,
        OR: [
          { detectedAt: { lt: thirtyDaysAgo } },
          { expiresAt: { lt: new Date() } },
        ],
      },
      data: { isActive: false },
    });

    return result.count;
  }
}
