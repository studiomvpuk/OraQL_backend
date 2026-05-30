import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PlayerValidationService, StreakValidation } from './player-validation.service';

// ============================================================================
// TYPES
// ============================================================================

export interface ScoredStreak {
  id: string;
  teamId: string;
  teamName: string;
  teamLogoUrl: string | null;
  leagueName: string | null;
  marketName: string;
  line: number | null;
  venueFilter: string;
  streakLength: number;
  windowSize: number;
  hitRate: number;
  confidence: number;
  recencyScore: number;
  qualityScore: number; // combined ranking metric
  summary: string; // human-readable e.g. "Arsenal Over 1.5 Goals in last 7 home matches (6/7)"
}

export interface StreakPickSuggestion {
  eventId: string;
  teamId: string;
  marketName: string;
  line: number | null;
  streakId: string;
  confidence: number;
  streakBoost: number;
  summary: string;
  /** Player validation level (when available) */
  validationLevel?: string;
  /** Player validation summary */
  validationSummary?: string;
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class StreakAnalysisService {
  private readonly logger = new Logger(StreakAnalysisService.name);

  /**
   * Weights for the quality score formula:
   *   quality = (hitRate * W_HR) + (streakLength * W_SL) + (recency * W_REC) + (windowBonus * W_WIN)
   */
  private readonly W_HIT_RATE = 0.40;
  private readonly W_STREAK_LENGTH = 0.25;
  private readonly W_RECENCY = 0.20;
  private readonly W_WINDOW = 0.15;

  /** Streak boost factor range applied to probability */
  private readonly MAX_STREAK_BOOST = 0.12; // up to +12% probability boost

  /** In-memory cache for scored streaks (streak data only changes once/day via cron) */
  private scoreCache: { data: ScoredStreak[]; timestamp: number } | null = null;
  private readonly SCORE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  constructor(
    private prisma: PrismaService,
    @Optional() private playerValidationService?: PlayerValidationService,
  ) {}

  // ==========================================================================
  // ANALYSE: Score and rank all active streaks
  // ==========================================================================

  /**
   * Score all active streaks and return them ranked by quality.
   * This is the ANALYSE step.
   */
  async scoreAndRankStreaks(limit = 100, leagueName?: string): Promise<ScoredStreak[]> {
    // Serve from cache if fresh AND no league filter (filtered queries bypass cache)
    const now = Date.now();
    if (
      !leagueName &&
      this.scoreCache &&
      now - this.scoreCache.timestamp < this.SCORE_CACHE_TTL_MS
    ) {
      return this.scoreCache.data.slice(0, limit);
    }

    const whereClause: any = { isActive: true };

    // Filter by league name if provided
    if (leagueName) {
      whereClause.team = { league: { name: leagueName } };
    }

    const activeStreaks = await this.prisma.streak.findMany({
      where: whereClause,
      include: {
        team: {
          include: { league: true },
        },
      },
      orderBy: { hitRate: 'desc' },
      take: 500, // pre-filter top 500 by raw hit rate
    });

    const scored: ScoredStreak[] = activeStreaks.map((streak) => {
      const recencyScore = this.computeRecencyScore(streak.detectedAt);
      const normalizedStreakLen = Math.min(streak.streakLength / 10, 1.0);
      const windowBonus = streak.windowSize >= 10 ? 1.0 : streak.windowSize >= 5 ? 0.7 : 0.4;

      const qualityScore =
        streak.hitRate * this.W_HIT_RATE +
        normalizedStreakLen * this.W_STREAK_LENGTH +
        recencyScore * this.W_RECENCY +
        windowBonus * this.W_WINDOW;

      const confidence = this.computeConfidence(
        streak.hitRate,
        streak.streakLength,
        streak.windowSize,
      );

      const summary = this.buildSummary(
        streak.team.name,
        streak.marketName,
        streak.line,
        streak.venueFilter,
        streak.streakLength,
        streak.windowSize,
        streak.hitRate,
      );

      return {
        id: streak.id,
        teamId: streak.teamId,
        teamName: streak.team.name,
        teamLogoUrl: streak.team.logoUrl,
        leagueName: streak.team.league?.name ?? null,
        marketName: streak.marketName,
        line: streak.line,
        venueFilter: streak.venueFilter,
        streakLength: streak.streakLength,
        windowSize: streak.windowSize,
        hitRate: streak.hitRate,
        confidence,
        recencyScore,
        qualityScore,
        summary,
      };
    });

    // SORT by quality score descending
    scored.sort((a, b) => b.qualityScore - a.qualityScore);

    // Only cache the unfiltered global query
    if (!leagueName) {
      this.scoreCache = { data: scored, timestamp: Date.now() };
    }

    return scored.slice(0, limit);
  }

  // ==========================================================================
  // SORT & PICK: Match streaks to upcoming events
  // ==========================================================================

  /**
   * For a given upcoming event, find all active streaks that apply
   * to either the home or away team, and return ranked suggestions.
   */
  async getStreakSuggestionsForEvent(
    eventId: string,
  ): Promise<StreakPickSuggestion[]> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: {
        homeTeam: true,
        awayTeam: true,
      },
    });

    if (!event) return [];

    // Find active streaks for home team (HOME or ALL venue filter)
    const homeStreaks = await this.prisma.streak.findMany({
      where: {
        teamId: event.homeTeamId,
        isActive: true,
        venueFilter: { in: ['HOME', 'ALL'] },
      },
      include: { team: true },
      orderBy: { hitRate: 'desc' },
    });

    // Find active streaks for away team (AWAY or ALL venue filter)
    const awayStreaks = await this.prisma.streak.findMany({
      where: {
        teamId: event.awayTeamId,
        isActive: true,
        venueFilter: { in: ['AWAY', 'ALL'] },
      },
      include: { team: true },
      orderBy: { hitRate: 'desc' },
    });

    // Build validation lookup if player validation service is available
    const validationMap = new Map<string, StreakValidation>();
    if (this.playerValidationService) {
      try {
        const validations = await this.playerValidationService.validateStreaksForEvent(eventId);
        for (const v of validations) {
          validationMap.set(v.streakId, v);
        }
      } catch (err) {
        this.logger.warn('Player validation failed, proceeding without', err);
      }
    }

    const suggestions: StreakPickSuggestion[] = [];

    for (const streak of [...homeStreaks, ...awayStreaks]) {
      let confidence = this.computeConfidence(
        streak.hitRate,
        streak.streakLength,
        streak.windowSize,
      );

      let streakBoost = this.computeStreakBoost(
        streak.hitRate,
        streak.streakLength,
        streak.windowSize,
      );

      const summary = this.buildSummary(
        streak.team.name,
        streak.marketName,
        streak.line,
        streak.venueFilter,
        streak.streakLength,
        streak.windowSize,
        streak.hitRate,
      );

      // Apply player validation adjustment
      const validation = validationMap.get(streak.id);
      let validationLevel: string | undefined;
      let validationSummary: string | undefined;

      if (validation) {
        confidence *= validation.confidenceAdjustment;
        streakBoost *= validation.confidenceAdjustment;
        validationLevel = validation.validationLevel;
        validationSummary = validation.summary;
      }

      suggestions.push({
        eventId,
        teamId: streak.teamId,
        marketName: streak.marketName,
        line: streak.line,
        streakId: streak.id,
        confidence: Math.min(0.95, Math.max(0.1, confidence)),
        streakBoost: Math.max(0, streakBoost),
        summary,
        validationLevel,
        validationSummary,
      });
    }

    // Sort by confidence descending
    suggestions.sort((a, b) => b.confidence - a.confidence);

    return suggestions;
  }

  // ==========================================================================
  // CONFIDENCE & BOOST COMPUTATION
  // ==========================================================================

  /**
   * Compute a confidence score [0, 1] for a streak.
   * Based on hit rate, streak length, and sample size.
   * Public so CrossLeagueService can score streaks without re-querying.
   */
  computeConfidence(
    hitRate: number,
    streakLength: number,
    windowSize: number,
  ): number {
    // Base from hit rate
    let confidence = hitRate * 0.6;

    // Bonus for longer consecutive streaks
    if (streakLength >= 7) confidence += 0.15;
    else if (streakLength >= 5) confidence += 0.10;
    else if (streakLength >= 3) confidence += 0.05;

    // Bonus for larger sample size
    if (windowSize >= 15) confidence += 0.10;
    else if (windowSize >= 10) confidence += 0.07;
    else if (windowSize >= 5) confidence += 0.03;

    // Penalize if window is small
    if (windowSize < 5) confidence *= 0.8;

    return Math.min(0.95, Math.max(0.1, confidence));
  }

  /**
   * Compute the probability boost a streak contributes.
   * Applied as an additive factor to the base model probability.
   */
  computeStreakBoost(
    hitRate: number,
    streakLength: number,
    windowSize: number,
  ): number {
    // Base boost proportional to how much the hit rate exceeds 50%
    const excessRate = Math.max(0, hitRate - 0.5);

    // Scale by streak length (longer = more reliable)
    const lengthMultiplier = Math.min(streakLength / 7, 1.0);

    // Scale by sample size
    const sampleMultiplier = Math.min(windowSize / 10, 1.0);

    const boost =
      excessRate * lengthMultiplier * sampleMultiplier * this.MAX_STREAK_BOOST * 4;

    return Math.min(this.MAX_STREAK_BOOST, Math.max(0, boost));
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * Recency score: streaks detected more recently are scored higher.
   * 1.0 if detected today, decays to 0.3 over 14 days.
   */
  private computeRecencyScore(detectedAt: Date): number {
    const daysSinceDetection =
      (Date.now() - detectedAt.getTime()) / (1000 * 60 * 60 * 24);

    if (daysSinceDetection <= 1) return 1.0;
    if (daysSinceDetection <= 3) return 0.9;
    if (daysSinceDetection <= 7) return 0.7;
    if (daysSinceDetection <= 14) return 0.5;
    return 0.3;
  }

  /**
   * Build a human-readable summary like:
   * "Arsenal Over 1.5 Goals in last 7 home matches (6/7, 86%)"
   * Public so CrossLeagueService can build summaries in bulk without re-querying.
   */
  buildSummary(
    teamName: string,
    marketName: string,
    line: number | null,
    venueFilter: string,
    streakLength: number,
    windowSize: number,
    hitRate: number,
  ): string {
    const marketLabel = this.marketLabel(marketName, line);
    const venueLabel =
      venueFilter === 'HOME'
        ? 'home'
        : venueFilter === 'AWAY'
          ? 'away'
          : '';
    const hitCount = Math.round(hitRate * windowSize);
    const pct = (hitRate * 100).toFixed(0);

    const venuePart = venueLabel ? ` ${venueLabel}` : '';
    return `${teamName} ${marketLabel} in last ${windowSize}${venuePart} matches (${hitCount}/${windowSize}, ${pct}%)`;
  }

  /**
   * Convert internal market name to display label.
   */
  marketLabel(marketName: string, line: number | null): string {
    const labels: Record<string, string> = {
      GOALS_OVER: `Over ${line} Goals`,
      GOALS_UNDER: `Under ${line} Goals`,
      TEAM_GOALS_OVER: `Team Over ${line} Goals`,
      TEAM_GOALS_UNDER: `Team Under ${line} Goals`,
      CORNERS_OVER: `Over ${line} Corners`,
      CORNERS_UNDER: `Under ${line} Corners`,
      CARDS_OVER: `Over ${line} Cards`,
      CARDS_UNDER: `Under ${line} Cards`,
      BTTS_YES: 'Both Teams to Score',
      BTTS_NO: 'Not Both Teams to Score',
      CLEAN_SHEET: 'Clean Sheet',
      MATCH_RESULT_HOME: 'Home Win',
    };

    return labels[marketName] || `${marketName} ${line ?? ''}`.trim();
  }
}
