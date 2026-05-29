import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

// ============================================================================
// TYPES
// ============================================================================

export type ValidationLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface KeyPlayer {
  playerId: string;
  playerName: string;
  position: string | null;
  /** Why this player is key for this streak */
  reason: string;
  /** Contribution metric (goals, SoT, tackles, etc.) */
  contributionScore: number;
  /** Current availability status */
  status: 'AVAILABLE' | 'INJURED' | 'DOUBTFUL' | 'IN_LINEUP' | 'UNKNOWN';
  /** Active injury info if any */
  injury?: {
    type: string;
    severity: string | null;
    expectedReturn: Date | null;
  };
}

export interface StreakValidation {
  streakId: string;
  teamId: string;
  marketName: string;
  line: number | null;
  validationLevel: ValidationLevel;
  /** Confidence adjustment factor: 0.7–1.1 (< 1 = downgrade, > 1 = upgrade) */
  confidenceAdjustment: number;
  keyPlayers: KeyPlayer[];
  availableCount: number;
  totalKeyPlayers: number;
  summary: string;
}

// ============================================================================
// MARKET → PLAYER ROLE MAPPING
// ============================================================================

/**
 * Maps market types to the player roles/positions and stats that matter.
 * This determines which players are "key" for validating a given streak.
 */
interface MarketPlayerCriteria {
  /** Player event types to look for (from PlayerMatchEvent) */
  eventTypes: string[];
  /** PlayerMatchStats fields to rank by (higher = more important) */
  statField: string;
  /** Positions most relevant to this market */
  relevantPositions: string[];
  /** Minimum number of key players to identify */
  minKeyPlayers: number;
  /** Maximum key players to track */
  maxKeyPlayers: number;
}

const MARKET_CRITERIA: Record<string, MarketPlayerCriteria> = {
  // Goal markets — strikers and attacking midfielders matter most
  GOALS_OVER: {
    eventTypes: ['GOAL', 'ASSIST', 'PENALTY_SCORED'],
    statField: 'shotsOnTarget',
    relevantPositions: ['Attacker', 'Midfielder', 'F', 'M'],
    minKeyPlayers: 2,
    maxKeyPlayers: 4,
  },
  GOALS_UNDER: {
    eventTypes: ['GOAL'],
    statField: 'shotsOnTarget',
    relevantPositions: ['Defender', 'Goalkeeper', 'D', 'G'],
    minKeyPlayers: 2,
    maxKeyPlayers: 4,
  },
  TEAM_GOALS_OVER: {
    eventTypes: ['GOAL', 'ASSIST', 'PENALTY_SCORED'],
    statField: 'shotsOnTarget',
    relevantPositions: ['Attacker', 'Midfielder', 'F', 'M'],
    minKeyPlayers: 2,
    maxKeyPlayers: 4,
  },
  TEAM_GOALS_UNDER: {
    eventTypes: ['GOAL'],
    statField: 'shotsOnTarget',
    relevantPositions: ['Defender', 'Goalkeeper', 'D', 'G'],
    minKeyPlayers: 2,
    maxKeyPlayers: 3,
  },
  CLEAN_SHEET: {
    eventTypes: [],
    statField: 'tackles',
    relevantPositions: ['Defender', 'Goalkeeper', 'D', 'G'],
    minKeyPlayers: 2,
    maxKeyPlayers: 4,
  },
  BTTS_YES: {
    eventTypes: ['GOAL', 'ASSIST'],
    statField: 'shotsOnTarget',
    relevantPositions: ['Attacker', 'Midfielder', 'F', 'M'],
    minKeyPlayers: 2,
    maxKeyPlayers: 3,
  },
  BTTS_NO: {
    eventTypes: [],
    statField: 'tackles',
    relevantPositions: ['Defender', 'Goalkeeper', 'D', 'G'],
    minKeyPlayers: 2,
    maxKeyPlayers: 3,
  },
  // Corner markets — fullbacks and wingers who deliver/win corners
  CORNERS_OVER: {
    eventTypes: [],
    statField: 'crosses',
    relevantPositions: ['Midfielder', 'Defender', 'M', 'D'],
    minKeyPlayers: 2,
    maxKeyPlayers: 3,
  },
  CORNERS_UNDER: {
    eventTypes: [],
    statField: 'crosses',
    relevantPositions: ['Defender', 'Goalkeeper', 'D', 'G'],
    minKeyPlayers: 2,
    maxKeyPlayers: 3,
  },
  // Card markets — players who foul or get fouled
  CARDS_OVER: {
    eventTypes: ['YELLOW_CARD', 'RED_CARD'],
    statField: 'foulsCommitted',
    relevantPositions: ['Midfielder', 'Defender', 'M', 'D'],
    minKeyPlayers: 2,
    maxKeyPlayers: 4,
  },
  CARDS_UNDER: {
    eventTypes: ['YELLOW_CARD', 'RED_CARD'],
    statField: 'foulsCommitted',
    relevantPositions: ['Midfielder', 'Defender', 'M', 'D'],
    minKeyPlayers: 2,
    maxKeyPlayers: 3,
  },
};

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class PlayerValidationService {
  private readonly logger = new Logger(PlayerValidationService.name);

  constructor(private prisma: PrismaService) {}

  // ==========================================================================
  // MAIN ENTRY: VALIDATE A STREAK
  // ==========================================================================

  /**
   * For a given streak and upcoming event, identify key players
   * and assess their availability. Returns a validation result
   * that can be used to adjust streak confidence.
   */
  async validateStreak(
    streakId: string,
    eventId?: string,
  ): Promise<StreakValidation> {
    const streak = await this.prisma.streak.findUnique({
      where: { id: streakId },
      include: {
        team: true,
        streakMatches: {
          orderBy: { matchDate: 'desc' },
          take: 10,
        },
      },
    });

    if (!streak) {
      throw new Error(`Streak ${streakId} not found`);
    }

    // 1. Identify key players from match history
    const keyPlayers = await this.identifyKeyPlayers(
      streak.teamId,
      streak.marketName,
      streak.streakMatches.map((m) => m.eventId),
    );

    // 2. Check player availability (injuries + lineup if event provided)
    await this.checkAvailability(keyPlayers, streak.teamId, eventId);

    // 3. Compute validation level and confidence adjustment
    const availableCount = keyPlayers.filter(
      (p) => p.status === 'AVAILABLE' || p.status === 'IN_LINEUP',
    ).length;

    const totalKeyPlayers = keyPlayers.length;
    const availabilityRatio =
      totalKeyPlayers > 0 ? availableCount / totalKeyPlayers : 0;

    const validationLevel = this.computeValidationLevel(
      availabilityRatio,
      totalKeyPlayers,
      keyPlayers,
    );

    const confidenceAdjustment =
      this.computeConfidenceAdjustment(validationLevel, availabilityRatio, keyPlayers);

    const summary = this.buildValidationSummary(
      streak.team.name,
      streak.marketName,
      keyPlayers,
      validationLevel,
    );

    return {
      streakId,
      teamId: streak.teamId,
      marketName: streak.marketName,
      line: streak.line,
      validationLevel,
      confidenceAdjustment,
      keyPlayers,
      availableCount,
      totalKeyPlayers,
      summary,
    };
  }

  /**
   * Batch validate all active streaks relevant to an upcoming event.
   */
  async validateStreaksForEvent(
    eventId: string,
  ): Promise<StreakValidation[]> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
    });

    if (!event) return [];

    const streaks = await this.prisma.streak.findMany({
      where: {
        isActive: true,
        teamId: { in: [event.homeTeamId, event.awayTeamId] },
      },
    });

    const validations: StreakValidation[] = [];

    for (const streak of streaks) {
      try {
        const validation = await this.validateStreak(streak.id, eventId);
        validations.push(validation);
      } catch (error) {
        this.logger.warn(
          `Failed to validate streak ${streak.id}`,
          error,
        );
      }
    }

    return validations;
  }

  // ==========================================================================
  // KEY PLAYER IDENTIFICATION
  // ==========================================================================

  /**
   * Identify the players most responsible for a streak holding.
   * Uses match events and per-player stats from the streak's matches.
   */
  private async identifyKeyPlayers(
    teamId: string,
    marketName: string,
    matchEventIds: string[],
  ): Promise<KeyPlayer[]> {
    const criteria = MARKET_CRITERIA[marketName] || MARKET_CRITERIA['GOALS_OVER'];

    // Strategy 1: Find players from match events (goals, cards, etc.)
    const playerScores = new Map<
      string,
      { score: number; reasons: string[]; name: string; position: string | null }
    >();

    if (criteria.eventTypes.length > 0 && matchEventIds.length > 0) {
      const events = await this.prisma.playerMatchEvent.findMany({
        where: {
          eventId: { in: matchEventIds },
          teamId,
          type: { in: criteria.eventTypes as any[] },
        },
        include: { player: true },
      });

      for (const evt of events) {
        const existing = playerScores.get(evt.playerId) || {
          score: 0,
          reasons: [],
          name: evt.player.name,
          position: evt.player.position,
        };

        // Weight by event type
        const weight = this.eventTypeWeight(evt.type);
        existing.score += weight;
        existing.reasons.push(`${evt.type} (minute ${evt.minute})`);
        playerScores.set(evt.playerId, existing);
      }
    }

    // Strategy 2: Rank by per-player match stats
    if (matchEventIds.length > 0) {
      const stats = await this.prisma.playerMatchStats.findMany({
        where: {
          eventId: { in: matchEventIds },
          teamId,
        },
        include: { player: true },
      });

      for (const stat of stats) {
        const statValue = this.getStatValue(stat, criteria.statField);
        if (statValue <= 0) continue;

        const existing = playerScores.get(stat.playerId) || {
          score: 0,
          reasons: [],
          name: stat.player.name,
          position: stat.player.position,
        };

        // Normalize stat contribution
        const statScore = statValue * 0.5;
        existing.score += statScore;

        if (!existing.reasons.some((r) => r.includes(criteria.statField))) {
          existing.reasons.push(
            `${criteria.statField}: ${statValue} across ${matchEventIds.length} matches`,
          );
        }

        playerScores.set(stat.playerId, existing);
      }
    }

    // Sort by score and take top N
    const ranked = Array.from(playerScores.entries())
      .map(([playerId, data]) => ({
        playerId,
        playerName: data.name,
        position: data.position,
        reason: data.reasons.slice(0, 3).join(', '),
        contributionScore: data.score,
        status: 'UNKNOWN' as KeyPlayer['status'],
      }))
      .sort((a, b) => b.contributionScore - a.contributionScore);

    // Filter by relevant positions if we have enough candidates
    let filtered = ranked;
    if (ranked.length > criteria.maxKeyPlayers) {
      const positionFiltered = ranked.filter((p) =>
        criteria.relevantPositions.some(
          (pos) =>
            p.position?.toLowerCase().includes(pos.toLowerCase()),
        ),
      );
      if (positionFiltered.length >= criteria.minKeyPlayers) {
        filtered = positionFiltered;
      }
    }

    return filtered.slice(0, criteria.maxKeyPlayers);
  }

  // ==========================================================================
  // AVAILABILITY CHECK
  // ==========================================================================

  /**
   * Check each key player's current availability:
   * - Active injuries
   * - Lineup confirmation (if event provided)
   */
  private async checkAvailability(
    keyPlayers: KeyPlayer[],
    teamId: string,
    eventId?: string,
  ): Promise<void> {
    const playerIds = keyPlayers.map((p) => p.playerId);

    // Fetch active injuries for these players
    const injuries = await this.prisma.playerInjury.findMany({
      where: {
        playerId: { in: playerIds },
        isActive: true,
      },
    });

    const injuryByPlayer = new Map(
      injuries.map((i) => [i.playerId, i]),
    );

    // Fetch lineup if event provided
    let lineupPlayerIds = new Set<string>();
    if (eventId) {
      const lineups = await this.prisma.lineup.findMany({
        where: { eventId, teamId },
        include: {
          entries: { select: { playerId: true } },
        },
      });

      for (const lineup of lineups) {
        for (const entry of lineup.entries) {
          lineupPlayerIds.add(entry.playerId);
        }
      }
    }

    // Update each key player's status
    for (const player of keyPlayers) {
      const injury = injuryByPlayer.get(player.playerId);

      if (injury) {
        player.status = injury.severity === 'SEVERE' ? 'INJURED' : 'DOUBTFUL';
        player.injury = {
          type: injury.type,
          severity: injury.severity,
          expectedReturn: injury.expectedReturn,
        };
      } else if (lineupPlayerIds.size > 0) {
        // Lineup data exists for this event
        player.status = lineupPlayerIds.has(player.playerId)
          ? 'IN_LINEUP'
          : 'UNKNOWN'; // not in lineup doesn't mean unavailable pre-lineup
      } else {
        player.status = 'AVAILABLE'; // no injury, no lineup data yet
      }
    }
  }

  // ==========================================================================
  // VALIDATION SCORING
  // ==========================================================================

  /**
   * Determine the validation level based on key player availability.
   */
  private computeValidationLevel(
    availabilityRatio: number,
    totalKeyPlayers: number,
    keyPlayers: KeyPlayer[],
  ): ValidationLevel {
    if (totalKeyPlayers === 0) return 'UNKNOWN';

    // Check if any key player is confirmed in lineup
    const inLineup = keyPlayers.filter((p) => p.status === 'IN_LINEUP').length;

    if (availabilityRatio >= 0.8 && inLineup >= 1) return 'HIGH';
    if (availabilityRatio >= 0.7) return 'HIGH';
    if (availabilityRatio >= 0.5) return 'MEDIUM';
    if (availabilityRatio >= 0.25) return 'LOW';
    return 'LOW';
  }

  /**
   * Compute the confidence adjustment factor.
   * - HIGH validation: 1.0–1.1 (maintain or slight boost)
   * - MEDIUM: 0.9–1.0 (slight reduction)
   * - LOW: 0.7–0.85 (significant reduction)
   * - UNKNOWN: 0.85 (cautious default)
   */
  private computeConfidenceAdjustment(
    level: ValidationLevel,
    availabilityRatio: number,
    keyPlayers: KeyPlayer[],
  ): number {
    // Bonus if top scorer is in lineup
    const topPlayerInLineup =
      keyPlayers.length > 0 && keyPlayers[0].status === 'IN_LINEUP';

    switch (level) {
      case 'HIGH':
        return topPlayerInLineup ? 1.08 : 1.0;
      case 'MEDIUM':
        return 0.92;
      case 'LOW':
        // Scale by how many key players are missing
        return 0.70 + availabilityRatio * 0.15;
      case 'UNKNOWN':
      default:
        return 0.85;
    }
  }

  // ==========================================================================
  // HELPERS
  // ==========================================================================

  /**
   * Weight match event types by their significance.
   */
  private eventTypeWeight(type: string): number {
    const weights: Record<string, number> = {
      GOAL: 3.0,
      ASSIST: 2.0,
      PENALTY_SCORED: 2.5,
      PENALTY_MISSED: 0.5,
      OWN_GOAL: 0.5,
      YELLOW_CARD: 1.5,
      RED_CARD: 2.5,
      SUBSTITUTION_IN: 0.3,
      SUBSTITUTION_OUT: 0.1,
    };
    return weights[type] ?? 1.0;
  }

  /**
   * Extract a numeric stat value from PlayerMatchStats.
   */
  private getStatValue(stat: any, field: string): number {
    const value = stat[field];
    if (value === null || value === undefined) return 0;
    return typeof value === 'number' ? value : parseFloat(value) || 0;
  }

  /**
   * Build a human-readable validation summary.
   */
  private buildValidationSummary(
    teamName: string,
    marketName: string,
    keyPlayers: KeyPlayer[],
    level: ValidationLevel,
  ): string {
    const available = keyPlayers.filter(
      (p) => p.status === 'AVAILABLE' || p.status === 'IN_LINEUP',
    );
    const injured = keyPlayers.filter(
      (p) => p.status === 'INJURED' || p.status === 'DOUBTFUL',
    );

    const parts: string[] = [];

    if (level === 'HIGH') {
      parts.push(`${teamName}: Key players available`);
      if (available.length > 0) {
        parts.push(
          `${available.map((p) => p.playerName).join(', ')} fit`,
        );
      }
    } else if (level === 'MEDIUM') {
      parts.push(`${teamName}: Partial availability`);
      if (injured.length > 0) {
        parts.push(
          `Missing: ${injured.map((p) => p.playerName).join(', ')}`,
        );
      }
    } else if (level === 'LOW') {
      parts.push(`${teamName}: Key players absent`);
      if (injured.length > 0) {
        parts.push(
          `Out: ${injured.map((p) => `${p.playerName} (${p.injury?.type || 'injured'})`).join(', ')}`,
        );
      }
    } else {
      parts.push(`${teamName}: Player availability unknown`);
    }

    return parts.join(' — ');
  }
}
