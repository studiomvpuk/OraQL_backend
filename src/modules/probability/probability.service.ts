import { Injectable, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ExplanationService } from './explanation.service';

interface TeamStats {
  avgGoalsScored: number;
  avgGoalsAgainst: number;
  avgCorners: number;
  avgYellowCards: number;
  avgRedCards: number;
  avgPossession: number;
  avgShotsOnTarget: number;
  winRate: number;
  matchesPlayed: number;
  matchesScored: number; // Matches where team scored at least 1 goal
}

interface ProbabilityResult {
  market: string;
  line?: number;
  probability: number;
  confidence: number;
  explanation: string;
}

@Injectable()
export class ProbabilityService {
  private readonly logger = new Logger(ProbabilityService.name);
  private readonly MATCH_WINDOW = 10;
  private readonly RECENCY_WEIGHT_MAX = 2.0;

  constructor(
    private prisma: PrismaService,
    private explanationService: ExplanationService,
  ) {}

  /**
   * Main entry point: compute all probabilities for an event.
   * Blends Poisson model output with bookmaker odds when available,
   * and uses deterministic per-event variance to avoid identical picks.
   */
  async computeForEvent(eventId: string): Promise<void> {
    try {
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
        include: {
          homeTeam: true,
          awayTeam: true,
          league: true,
        },
      });

      if (!event) {
        throw new Error(`Event ${eventId} not found`);
      }

      // Fetch related data
      const homeHistory = await this.getTeamHistory(event.homeTeamId);
      const awayHistory = await this.getTeamHistory(event.awayTeamId);
      const injuries = await this.prisma.playerInjury.findMany({
        where: {
          player: {
            teamId: { in: [event.homeTeamId, event.awayTeamId] },
          },
          isActive: true,
        },
        include: { player: true },
      });
      const lineups = await this.prisma.lineup.findMany({
        where: { eventId },
        include: { team: true },
      });

      const homeInjuries = injuries.filter(
        (i: any) => i.player.teamId === event.homeTeamId,
      );
      const awayInjuries = injuries.filter(
        (i: any) => i.player.teamId === event.awayTeamId,
      );

      const homeInjuryFactor = this.computeInjuryAdjustment(homeInjuries);
      const awayInjuryFactor = this.computeInjuryAdjustment(awayInjuries);

      // Fetch bookmaker odds for this event
      const bookmakerOdds = await this.prisma.bookmakerOdds.findMany({
        where: { eventId },
      });

      // Build odds lookup: marketName → average implied probability across bookmakers
      const oddsLookup = this.buildOddsLookup(bookmakerOdds);

      // Deterministic per-event seed for controlled variance when using defaults
      const eventSeed = this.hashToFloat(eventId);
      const hasRealHistory = homeHistory.matchesPlayed > 1 || awayHistory.matchesPlayed > 1;

      // Compute markets
      const markets: ProbabilityResult[] = [];

      // Match Result
      markets.push(
        this.computeMatchResult(homeHistory, awayHistory, homeInjuryFactor, awayInjuryFactor, event),
      );

      // Goals
      markets.push(
        ...this.computeGoals(homeHistory, awayHistory, homeInjuryFactor, awayInjuryFactor),
      );

      // Corners
      markets.push(
        ...this.computeCorners(homeHistory, awayHistory, homeInjuryFactor, awayInjuryFactor),
      );

      // Cards
      markets.push(
        ...this.computeCards(homeHistory, awayHistory, homeInjuryFactor, awayInjuryFactor),
      );

      // BTTS
      markets.push(this.computeBTTS(homeHistory, awayHistory, homeInjuryFactor, awayInjuryFactor));

      // Post-process: blend with bookmaker odds + add per-event variance
      for (const result of markets) {
        const oddsKey = this.marketToOddsKey(result.market, result.line);
        const bookmakerProb = oddsLookup.get(oddsKey);

        if (bookmakerProb && bookmakerProb > 0.01 && bookmakerProb < 0.99) {
          // Blend: 40% model, 60% bookmaker odds (odds are sharper when no history)
          const modelWeight = hasRealHistory ? 0.6 : 0.4;
          result.probability = result.probability * modelWeight + bookmakerProb * (1 - modelWeight);
          result.confidence = Math.min(0.92, result.confidence + 0.05);
          result.explanation += ` | Calibrated with bookmaker consensus (${(bookmakerProb * 100).toFixed(1)}%)`;
        } else if (!hasRealHistory) {
          // No odds, no history: add deterministic variance so events differ
          // Variance range: ±12% of probability, seeded by event ID
          const variance = (eventSeed - 0.5) * 0.24;
          result.probability = result.probability + (result.probability * variance);
          result.confidence = Math.max(0.5, result.confidence - 0.15);
        }

        // Final clamp: [0.05, 0.95]
        result.probability = Math.min(0.95, Math.max(0.05, result.probability));
      }

      // Save markets
      for (const result of markets) {
        const existing = await this.prisma.market.findFirst({
          where: {
            eventId,
            name: result.market,
            line: result.line ?? null,
          },
        });

        const category = this.marketNameToCategory(result.market);

        if (existing) {
          await this.prisma.market.update({
            where: { id: existing.id },
            data: {
              probability: result.probability,
              confidence: result.confidence,
              explanation: result.explanation,
              updatedAt: new Date(),
            },
          });
        } else {
          await this.prisma.market.create({
            data: {
              eventId,
              name: result.market,
              category: category as any,
              line: result.line,
              probability: result.probability,
              confidence: result.confidence,
              explanation: result.explanation,
            },
          });
        }
      }

      this.logger.log(`Probabilities computed and saved for event ${eventId}`);
    } catch (error) {
      this.logger.error(`Failed to compute probabilities for event ${eventId}`, error);
      throw error;
    }
  }

  /**
   * Build a lookup of average implied probabilities from bookmaker odds.
   * Aggregates across bookmakers for each market+line combination.
   */
  private buildOddsLookup(bookmakerOdds: any[]): Map<string, number> {
    const accumulator = new Map<string, { sum: number; count: number }>();

    for (const odd of bookmakerOdds) {
      if (!odd.impliedProbability) continue;
      const key = `${odd.marketName}|${odd.line ?? ''}`;
      const existing = accumulator.get(key) || { sum: 0, count: 0 };
      existing.sum += odd.impliedProbability;
      existing.count++;
      accumulator.set(key, existing);
    }

    const lookup = new Map<string, number>();
    for (const [key, val] of accumulator) {
      lookup.set(key, val.sum / val.count);
    }
    return lookup;
  }

  /**
   * Map internal market names to bookmaker odds market names
   */
  private marketToOddsKey(market: string, line?: number): string {
    // Common mappings between our market names and The Odds API market names
    const mappings: Record<string, string> = {
      MATCH_RESULT_HOME: 'h2h|',
      GOALS_OVER: `totals|${line ?? ''}`,
      GOALS_UNDER: `totals|${line ?? ''}`,
      BTTS_YES: 'btts|',
    };
    return mappings[market] || `${market}|${line ?? ''}`;
  }

  /**
   * Deterministic hash of a string to a float in [0, 1].
   * Used to generate per-event variance from the event ID.
   */
  private hashToFloat(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit int
    }
    // Map to [0, 1]
    return (Math.abs(hash) % 10000) / 10000;
  }

  /**
   * Map market name to MarketCategory enum
   */
  private marketNameToCategory(marketName: string): string {
    if (marketName.startsWith('MATCH_RESULT')) return 'MATCH_RESULT';
    if (marketName.startsWith('GOALS')) return 'GOALS';
    if (marketName.startsWith('CORNERS')) return 'CORNERS';
    if (marketName.startsWith('CARDS')) return 'CARDS';
    if (marketName.startsWith('BTTS')) return 'GOALS';
    return 'SPECIAL';
  }

  /**
   * Compute match result probabilities (H/D/A with 8% home advantage)
   */
  private computeMatchResult(
    homeStats: TeamStats,
    awayStats: TeamStats,
    homeInjuryFactor: number,
    awayInjuryFactor: number,
    event: any,
  ): ProbabilityResult {
    // Apply injury adjustments
    const adjustedHomeGoalsFor = homeStats.avgGoalsScored * homeInjuryFactor;
    const adjustedHomeGoalsAgainst = homeStats.avgGoalsAgainst * awayInjuryFactor;
    const adjustedAwayGoalsFor = awayStats.avgGoalsScored * awayInjuryFactor;
    const adjustedAwayGoalsAgainst = awayStats.avgGoalsAgainst * homeInjuryFactor;

    // Expected goals
    const homeExpectedGoals = adjustedHomeGoalsFor;
    const awayExpectedGoals = adjustedAwayGoalsFor;

    // Poisson probabilities
    const homeWinProb =
      this.poissonMatchProb(homeExpectedGoals, awayExpectedGoals, 'home') * 1.08; // 8% home advantage
    const drawProb = this.poissonMatchProb(homeExpectedGoals, awayExpectedGoals, 'draw');
    const awayWinProb = this.poissonMatchProb(homeExpectedGoals, awayExpectedGoals, 'away');

    // Normalize to sum to 1
    const total = homeWinProb + drawProb + awayWinProb;

    const explanation = this.explanationService.explainMatchResult(
      event,
      homeStats,
      awayStats,
      homeExpectedGoals,
      awayExpectedGoals,
      homeInjuryFactor,
      awayInjuryFactor,
    );

    return {
      market: 'MATCH_RESULT_HOME',
      probability: homeWinProb / total,
      confidence: 0.85,
      explanation,
    };
  }

  /**
   * Compute goal probabilities (over/under for various lines)
   */
  private computeGoals(
    homeStats: TeamStats,
    awayStats: TeamStats,
    homeInjuryFactor: number,
    awayInjuryFactor: number,
  ): ProbabilityResult[] {
    // Expected total goals = home attack + away attack (no halving)
    const totalGoals = homeStats.avgGoalsScored * homeInjuryFactor
      + awayStats.avgGoalsScored * awayInjuryFactor;
    const goals: ProbabilityResult[] = [];

    for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
      const overProb = this.poissonOverProb(totalGoals, line);
      const underProb = 1 - overProb;

      // Clamp to [0.01, 0.95] — trivially certain markets aren't useful
      goals.push({
        market: 'GOALS_UNDER',
        line,
        probability: Math.min(0.95, Math.max(0.01, underProb)),
        confidence: 0.8,
        explanation: `Expected ${totalGoals.toFixed(2)} total goals (Poisson model)`,
      });

      goals.push({
        market: 'GOALS_OVER',
        line,
        probability: Math.min(0.95, Math.max(0.01, overProb)),
        confidence: 0.8,
        explanation: `Expected ${totalGoals.toFixed(2)} total goals (Poisson model)`,
      });
    }

    return goals;
  }

  /**
   * Compute corner probabilities
   */
  private computeCorners(
    homeStats: TeamStats,
    awayStats: TeamStats,
    homeInjuryFactor: number,
    awayInjuryFactor: number,
  ): ProbabilityResult[] {
    const totalCorners =
      homeStats.avgCorners * homeInjuryFactor + awayStats.avgCorners * awayInjuryFactor;
    const corners: ProbabilityResult[] = [];

    for (const line of [7.5, 8.5, 9.5, 10.5, 11.5]) {
      const overProb = this.poissonOverProb(totalCorners, line);
      const underProb = 1 - overProb;

      corners.push({
        market: 'CORNERS_UNDER',
        line,
        probability: Math.min(0.95, Math.max(0.01, underProb)),
        confidence: 0.75,
        explanation: `Expected ${totalCorners.toFixed(1)} corners (Poisson model)`,
      });

      corners.push({
        market: 'CORNERS_OVER',
        line,
        probability: Math.min(0.95, Math.max(0.01, overProb)),
        confidence: 0.75,
        explanation: `Expected ${totalCorners.toFixed(1)} corners (Poisson model)`,
      });
    }

    return corners;
  }

  /**
   * Compute card probabilities
   */
  private computeCards(
    homeStats: TeamStats,
    awayStats: TeamStats,
    homeInjuryFactor: number,
    awayInjuryFactor: number,
  ): ProbabilityResult[] {
    const totalCards =
      homeStats.avgYellowCards + awayStats.avgYellowCards;
    const cards: ProbabilityResult[] = [];

    for (const line of [2.5, 3.5, 4.5, 5.5]) {
      const overProb = this.poissonOverProb(totalCards, line);
      const underProb = 1 - overProb;

      cards.push({
        market: 'CARDS_UNDER',
        line,
        probability: Math.min(0.95, Math.max(0.01, underProb)),
        confidence: 0.7,
        explanation: `Expected ${totalCards.toFixed(1)} yellow cards (Poisson model)`,
      });

      cards.push({
        market: 'CARDS_OVER',
        line,
        probability: Math.min(0.95, Math.max(0.01, overProb)),
        confidence: 0.7,
        explanation: `Expected ${totalCards.toFixed(1)} yellow cards (Poisson model)`,
      });
    }

    return cards;
  }

  /**
   * Compute BTTS (Both Teams To Score) probability using Poisson model.
   * P(BTTS) = 1 - P(home=0) - P(away=0) + P(both=0)
   * where P(team=0) = e^(-lambda)
   */
  private computeBTTS(
    homeStats: TeamStats,
    awayStats: TeamStats,
    homeInjuryFactor: number,
    awayInjuryFactor: number,
  ): ProbabilityResult {
    const homeLambda = homeStats.avgGoalsScored * homeInjuryFactor;
    const awayLambda = awayStats.avgGoalsScored * awayInjuryFactor;

    // Poisson: P(goals = 0) = e^(-lambda)
    const homeZeroProb = Math.exp(-homeLambda);
    const awayZeroProb = Math.exp(-awayLambda);

    // P(BTTS) = 1 - P(home=0) - P(away=0) + P(home=0 AND away=0)
    const bttsProb = 1 - homeZeroProb - awayZeroProb + (homeZeroProb * awayZeroProb);

    // Clamp to [0.01, 0.95] — no market should ever be 0% or 100%
    const clampedProb = Math.min(0.95, Math.max(0.01, bttsProb));

    return {
      market: 'BTTS_YES',
      probability: clampedProb,
      confidence: 0.78,
      explanation: `Poisson BTTS model: home xG=${homeLambda.toFixed(2)}, away xG=${awayLambda.toFixed(2)}. P(home scores)=${((1 - homeZeroProb) * 100).toFixed(1)}%, P(away scores)=${((1 - awayZeroProb) * 100).toFixed(1)}%`,
    };
  }

  /**
   * Calculate Poisson probability for Over
   * P(X > line) = 1 - P(X <= line)
   * P(X <= line) = sum(e^-λ * λ^k / k!) for k=0 to floor(line)
   */
  private poissonOverProb(lambda: number, line: number): number {
    if (lambda <= 0) return 0;

    let cumulativeProb = 0;
    const floorLine = Math.floor(line);

    for (let k = 0; k <= floorLine; k++) {
      const factorial = this.factorial(k);
      cumulativeProb += (Math.exp(-lambda) * Math.pow(lambda, k)) / factorial;
    }

    return 1 - cumulativeProb;
  }

  /**
   * Calculate Poisson match outcome probability
   */
  private poissonMatchProb(
    homeGoals: number,
    awayGoals: number,
    outcome: 'home' | 'draw' | 'away',
  ): number {
    let prob = 0;

    if (outcome === 'home') {
      for (let h = 1; h <= 10; h++) {
        for (let a = 0; a < h; a++) {
          const hProb = (Math.exp(-homeGoals) * Math.pow(homeGoals, h)) / this.factorial(h);
          const aProb = (Math.exp(-awayGoals) * Math.pow(awayGoals, a)) / this.factorial(a);
          prob += hProb * aProb;
        }
      }
    } else if (outcome === 'draw') {
      for (let goals = 0; goals <= 10; goals++) {
        const hProb = (Math.exp(-homeGoals) * Math.pow(homeGoals, goals)) / this.factorial(goals);
        const aProb = (Math.exp(-awayGoals) * Math.pow(awayGoals, goals)) / this.factorial(goals);
        prob += hProb * aProb;
      }
    } else {
      for (let a = 1; a <= 10; a++) {
        for (let h = 0; h < a; h++) {
          const hProb = (Math.exp(-homeGoals) * Math.pow(homeGoals, h)) / this.factorial(h);
          const aProb = (Math.exp(-awayGoals) * Math.pow(awayGoals, a)) / this.factorial(a);
          prob += hProb * aProb;
        }
      }
    }

    return prob;
  }

  /**
   * Get weighted team statistics over last N matches
   */
  async getTeamHistory(teamId: string): Promise<TeamStats> {
    const events = await this.prisma.event.findMany({
      where: {
        OR: [
          { homeTeamId: teamId, status: 'FINISHED' },
          { awayTeamId: teamId, status: 'FINISHED' },
        ],
      },
      orderBy: { kickoffAt: 'desc' },
      take: this.MATCH_WINDOW,
      include: { matchStats: true },
    });

    if (events.length === 0) {
      return {
        avgGoalsScored: 1.0,
        avgGoalsAgainst: 1.0,
        avgCorners: 5.0,
        avgYellowCards: 1.8,
        avgRedCards: 0.05,
        avgPossession: 50.0,
        avgShotsOnTarget: 3.5,
        winRate: 0.4,
        matchesPlayed: 1,
        matchesScored: 1,
      };
    }

    let totalGoalsScored = 0;
    let totalGoalsAgainst = 0;
    let totalCorners = 0;
    let totalYellowCards = 0;
    let totalRedCards = 0;
    let totalPossession = 0;
    let totalShotsOnTarget = 0;
    let totalWins = 0;
    let totalMatches = 0;
    let matchesScored = 0;

    for (const event of events) {
      const isHome = event.homeTeamId === teamId;
      const teamMatchStats = event.matchStats.find(
        (s: any) => s.teamId === teamId,
      );

      if (!teamMatchStats) continue;

      totalMatches++;

      // Goals
      const goalsScored = isHome ? event.homeScore : event.awayScore;
      const goalsAgainst = isHome ? event.awayScore : event.homeScore;
      totalGoalsScored += goalsScored || 0;
      totalGoalsAgainst += goalsAgainst || 0;

      if ((goalsScored || 0) > 0) {
        matchesScored++;
      }

      // Win calculation
      if ((goalsScored ?? 0) > (goalsAgainst ?? 0)) {
        totalWins++;
      } else if ((goalsScored ?? 0) === (goalsAgainst ?? 0)) {
        totalWins += 0.33; // Draw counts as partial win
      }

      // Stats
      totalCorners += teamMatchStats.corners || 0;
      totalYellowCards += teamMatchStats.yellowCards || 0;
      totalRedCards += teamMatchStats.redCards || 0;
      totalPossession += teamMatchStats.possession || 50;
      totalShotsOnTarget += teamMatchStats.shotsOnTarget || 0;
    }

    const avgMatches = totalMatches || 1;

    return {
      avgGoalsScored: totalGoalsScored / avgMatches,
      avgGoalsAgainst: totalGoalsAgainst / avgMatches,
      avgCorners: totalCorners / avgMatches,
      avgYellowCards: totalYellowCards / avgMatches,
      avgRedCards: totalRedCards / avgMatches,
      avgPossession: totalPossession / avgMatches,
      avgShotsOnTarget: totalShotsOnTarget / avgMatches,
      winRate: totalWins / avgMatches,
      matchesPlayed: totalMatches,
      matchesScored: matchesScored,
    };
  }

  /**
   * Compute injury adjustment factor (0.90 to 1.0)
   */
  computeInjuryAdjustment(injuries: any[]): number {
    if (injuries.length === 0) return 1.0;

    let adjustmentFactor = 1.0;

    for (const injury of injuries) {
      const isKeyPlayer = injury.player.position === 'F' || injury.player.position === 'D';
      const severityFactor =
        injury.severity === 'SEVERE'
          ? 0.15
          : injury.severity === 'MODERATE'
            ? 0.08
            : 0.03;

      const injuryFactor = isKeyPlayer ? severityFactor * 1.5 : severityFactor;
      adjustmentFactor -= injuryFactor;
    }

    // Clamp between 0.85 and 1.0
    return Math.max(0.85, Math.min(1.0, adjustmentFactor));
  }

  /**
   * Helper: factorial calculation
   */
  private factorial(n: number): number {
    if (n <= 1) return 1;
    let result = 1;
    for (let i = 2; i <= n; i++) {
      result *= i;
    }
    return result;
  }
}
