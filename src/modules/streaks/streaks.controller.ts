import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { StreakDetectionService } from './streak-detection.service';
import { StreakAnalysisService } from './streak-analysis.service';
import { PlayerValidationService } from './player-validation.service';
import { CrossLeagueService } from './cross-league.service';
import { PrismaService } from '../prisma/prisma.service';

@Controller('streaks')
export class StreaksController {
  private readonly logger = new Logger(StreaksController.name);

  /** Simple in-memory caches (streak/league data changes only when cron runs) */
  private statsCache: { data: any; timestamp: number } | null = null;
  private leagueCache: { data: any; timestamp: number } | null = null;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private streakDetectionService: StreakDetectionService,
    private streakAnalysisService: StreakAnalysisService,
    private playerValidationService: PlayerValidationService,
    private crossLeagueService: CrossLeagueService,
    private prisma: PrismaService,
  ) {}

  /**
   * GET /api/v1/streaks
   * Get top ranked active streaks.
   */
  @Get()
  async getTopStreaks(
    @Query('limit') limit?: string,
    @Query('sport') sport?: string,
  ) {
    const scored = await this.streakAnalysisService.scoreAndRankStreaks(
      limit ? parseInt(limit, 10) : 50,
    );

    return { streaks: scored, total: scored.length };
  }

  /**
   * GET /api/v1/streaks/leagues
   * All leagues that have teams in the system.
   * Used by the frontend league filter. Cached for 5 minutes.
   */
  @Get('leagues')
  async getLeagues() {
    const now = Date.now();
    if (this.leagueCache && now - this.leagueCache.timestamp < this.CACHE_TTL_MS) {
      return this.leagueCache.data;
    }

    const leagues = await this.prisma.league.findMany({
      where: { teams: { some: {} } },
      select: { id: true, name: true, country: true, logoUrl: true },
      orderBy: { name: 'asc' },
    });

    const data = { leagues, total: leagues.length };
    this.leagueCache = { data, timestamp: now };
    return data;
  }

  /**
   * GET /api/v1/streaks/team/:teamId
   * Get all active streaks for a specific team.
   */
  @Get('team/:teamId')
  async getTeamStreaks(@Param('teamId') teamId: string) {
    const streaks = await this.prisma.streak.findMany({
      where: {
        teamId,
        isActive: true,
      },
      include: {
        team: true,
        streakMatches: {
          orderBy: { matchDate: 'desc' },
          take: 10,
        },
      },
      orderBy: { hitRate: 'desc' },
    });

    return { streaks, total: streaks.length };
  }

  /**
   * GET /api/v1/streaks/event/:eventId
   * Get streak-based suggestions for an upcoming event.
   */
  @Get('event/:eventId')
  async getEventStreakSuggestions(@Param('eventId') eventId: string) {
    const suggestions =
      await this.streakAnalysisService.getStreakSuggestionsForEvent(eventId);

    return { suggestions, total: suggestions.length };
  }

  /**
   * POST /api/v1/streaks/detect
   * Manually trigger full streak detection scan (fire-and-forget).
   * Returns 202 immediately; work runs in background.
   */
  @Post('detect')
  @HttpCode(202)
  async triggerDetection() {
    this.logger.log('Manual streak detection triggered (fire-and-forget)');

    this.streakDetectionService
      .detectAllStreaks()
      .then((result) =>
        this.logger.log(
          `Streak detection DONE: ${result.teamsScanned} teams, ` +
          `${result.streaksDetected} detected, ${result.streaksSaved} saved`,
        ),
      )
      .catch((err) => this.logger.error('Streak detection FAILED', err));

    return {
      status: 'started',
      message: 'Streak detection running in background. Watch deploy logs for progress.',
    };
  }

  /**
   * POST /api/v1/streaks/detect/team/:teamId
   * Detect streaks for a single team.
   */
  @Post('detect/team/:teamId')
  @HttpCode(200)
  async detectForTeam(@Param('teamId') teamId: string) {
    this.logger.log(`Manual streak detection for team ${teamId}`);
    const streaks = await this.streakDetectionService.detectStreaksForTeam(teamId);
    return {
      teamId,
      streaksDetected: streaks.length,
      streaks: streaks.map((s) => ({
        marketName: s.marketName,
        line: s.line,
        venueFilter: s.venueFilter,
        streakLength: s.streakLength,
        hitRate: s.hitRate,
      })),
    };
  }

  /**
   * GET /api/v1/streaks/event/:eventId/validation
   * Get player validation for all streaks relevant to an event.
   * Shows which key players are available/injured and how it affects confidence.
   */
  @Get('event/:eventId/validation')
  async getEventValidation(@Param('eventId') eventId: string) {
    const validations =
      await this.playerValidationService.validateStreaksForEvent(eventId);

    return {
      eventId,
      validations,
      total: validations.length,
    };
  }

  /**
   * GET /api/v1/streaks/:streakId/validation
   * Validate a single streak (optionally against an upcoming event).
   */
  @Get(':streakId/validation')
  async getStreakValidation(
    @Param('streakId') streakId: string,
    @Query('eventId') eventId?: string,
  ) {
    const validation = await this.playerValidationService.validateStreak(
      streakId,
      eventId,
    );
    return validation;
  }

  /**
   * GET /api/v1/streaks/tickets
   * Get AI-generated multi-leg ticket suggestions from cross-league streaks.
   */
  @Get('tickets')
  async getSuggestedTickets(
    @Query('maxLegs') maxLegs?: string,
    @Query('minLegs') minLegs?: string,
    @Query('limit') limit?: string,
  ) {
    const tickets = await this.crossLeagueService.generateSuggestedTickets({
      maxLegs: maxLegs ? parseInt(maxLegs, 10) : undefined,
      minLegs: minLegs ? parseInt(minLegs, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { tickets, total: tickets.length };
  }

  /**
   * GET /api/v1/streaks/event/:eventId/legs
   * Get streak-backed ticket legs for a specific event.
   */
  @Get('event/:eventId/legs')
  async getEventLegs(@Param('eventId') eventId: string) {
    const legs = await this.crossLeagueService.getLegsForEvent(eventId);
    return { legs, total: legs.length };
  }

  /**
   * GET /api/v1/streaks/diagnostics
   * Deep look at what data exists — leagues, events, streaks per league.
   * Use this to understand data coverage.
   */
  @Get('diagnostics')
  async getDiagnostics() {
    // Total counts
    const [leagueCount, teamCount, eventCount, finishedCount, streakCount] = await Promise.all([
      this.prisma.league.count(),
      this.prisma.team.count(),
      this.prisma.event.count(),
      this.prisma.event.count({ where: { status: 'FINISHED' } }),
      this.prisma.streak.count({ where: { isActive: true } }),
    ]);

    // Per-league breakdown: events and streaks
    const leagues = await this.prisma.league.findMany({
      select: {
        id: true,
        name: true,
        country: true,
        _count: {
          select: {
            events: true,
            teams: true,
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    // Count finished events per league
    const finishedByLeague = await this.prisma.event.groupBy({
      by: ['leagueId'],
      where: { status: 'FINISHED' },
      _count: true,
    });
    const finishedMap = new Map(finishedByLeague.map((r) => [r.leagueId, r._count]));

    // Count active streaks per league (through team relation)
    const streaksByTeam = await this.prisma.streak.groupBy({
      by: ['teamId'],
      where: { isActive: true },
      _count: true,
    });

    // Map teamId → leagueId
    const teamLeagueMap = new Map<string, string>();
    const allTeams = await this.prisma.team.findMany({ select: { id: true, leagueId: true } });
    for (const t of allTeams) teamLeagueMap.set(t.id, t.leagueId);

    const streaksByLeague = new Map<string, number>();
    for (const s of streaksByTeam) {
      const leagueId = teamLeagueMap.get(s.teamId);
      if (leagueId) streaksByLeague.set(leagueId, (streaksByLeague.get(leagueId) || 0) + s._count);
    }

    // Date range of events
    const [earliest, latest] = await Promise.all([
      this.prisma.event.findFirst({ orderBy: { kickoffAt: 'asc' }, select: { kickoffAt: true } }),
      this.prisma.event.findFirst({ orderBy: { kickoffAt: 'desc' }, select: { kickoffAt: true } }),
    ]);

    const leagueBreakdown = leagues.map((l) => ({
      name: l.name,
      country: l.country,
      teams: l._count.teams,
      totalEvents: l._count.events,
      finishedEvents: finishedMap.get(l.id) || 0,
      activeStreaks: streaksByLeague.get(l.id) || 0,
    }));

    // Sort by finished events descending to see which leagues have most data
    leagueBreakdown.sort((a, b) => b.finishedEvents - a.finishedEvents);

    return {
      summary: {
        totalLeagues: leagueCount,
        totalTeams: teamCount,
        totalEvents: eventCount,
        finishedEvents: finishedCount,
        activeStreaks: streakCount,
        dataRange: {
          earliest: earliest?.kickoffAt,
          latest: latest?.kickoffAt,
        },
      },
      topLeagues: leagueBreakdown.slice(0, 30),
      allLeagues: leagueBreakdown,
    };
  }

  /**
   * GET /api/v1/streaks/stats
   * Summary stats about the streak engine.
   */
  @Get('stats')
  async getStreakStats() {
    // Serve cached stats if fresh
    const now = Date.now();
    if (this.statsCache && now - this.statsCache.timestamp < this.CACHE_TTL_MS) {
      return this.statsCache.data;
    }

    const [total, active, avgHitRate] = await Promise.all([
      this.prisma.streak.count(),
      this.prisma.streak.count({ where: { isActive: true } }),
      this.prisma.streak.aggregate({
        where: { isActive: true },
        _avg: { hitRate: true, streakLength: true, confidence: true },
      }),
    ]);

    const data = {
      totalStreaks: total,
      activeStreaks: active,
      averageHitRate: avgHitRate._avg.hitRate,
      averageStreakLength: avgHitRate._avg.streakLength,
      averageConfidence: avgHitRate._avg.confidence,
    };

    this.statsCache = { data, timestamp: now };
    return data;
  }
}
