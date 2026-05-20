import { Injectable, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
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
   * Main entry point: compute all probabilities for an event
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
      const injuries = await this.prisma.injury.findMany({
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
        (i) => i.player.teamId === event.homeTeamId,
      );
      const awayInjuries = injuries.filter(
        (i) => i.player.teamId === event.awayTeamId,
      );

      const homeInjuryFactor = this.computeInjuryAdjustment(homeInjuries);
      const awayInjuryFactor = this.computeInjuryAdjustment(awayInjuries);

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

      // Save markets and generate explanations
      for (const result of markets) {
        await this.prisma.market.upsert({
          where: {
            eventId_name_line: {
              eventId,
              name: result.market,
              line: result.line,
            },
          },
          update: {
            probability: result.probability,
            confidence: result.confidence,
            explanation: result.explanation,
            updatedAt: new Date(),
          },
          create: {
            eventId,
            name: result.market,
            line: result.line,
            probability: result.probability,
            confidence: result.confidence,
            explanation: result.explanation,
          },
        });
      }

      this.logger.log(`Probabilities computed and saved for event ${eventId}`);

      // Broadcast via WebSocket (implementation would depend on WebSocket gateway)
      // this.websocketGateway.emitEventMarkets(eventId, markets);
    } catch (error) {
      this.logger.error(`Failed to compute probabilities for event ${eventId}`, error);
      throw error;
    }
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
    const totalGoals = (homeStats.avgGoalsScored + awayStats.avgGoalsScored) * 0.5;
    const goals: ProbabilityResult[] = [];

    for (const line of [0.5, 1.5, 2.5, 3.5, 4.5]) {
      const underProb = this.poissonOverProb(totalGoals, line);

      goals.push({
        market: 'GOALS_UNDER',
        line,
        probability: 1 - underProb, // Under probability
        confidence: 0.8,
        explanation: `Based on historical average of ${totalGoals.toFixed(2)} goals per match`,
      });

      goals.push({
        market: 'GOALS_OVER',
        line,
        probability: underProb,
        confidence: 0.8,
        explanation: `Expected goals total: ${totalGoals.toFixed(2)}`,
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
      (homeStats.avgCorners + awayStats.avgCorners) * 0.5;
    const corners: ProbabilityResult[] = [];

    for (const line of [7.5, 8.5, 9.5, 10.5, 11.5]) {
      const underProb = this.poissonOverProb(totalCorners, line);

      corners.push({
        market: 'CORNERS_UNDER',
        line,
        probability: 1 - underProb,
        confidence: 0.75,
        explanation: `Expected corners: ${totalCorners.toFixed(2)} per match`,
      });

      corners.push({
        market: 'CORNERS_OVER',
        line,
        probability: underProb,
        confidence: 0.75,
        explanation: `Based on ${this.MATCH_WINDOW}-match average`,
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
      (homeStats.avgYellowCards + awayStats.avgYellowCards) * 0.5;
    const cards: ProbabilityResult[] = [];

    for (const line of [2.5, 3.5, 4.5, 5.5]) {
      const underProb = this.poissonOverProb(totalCards, line);

      cards.push({
        market: 'CARDS_UNDER',
        line,
        probability: 1 - underProb,
        confidence: 0.7,
        explanation: `Average yellow cards: ${totalCards.toFixed(2)} per match`,
      });

      cards.push({
        market: 'CARDS_OVER',
        line,
        probability: underProb,
        confidence: 0.7,
        explanation: `Based on recent form and referee patterns`,
      });
    }

    return cards;
  }

  /**
   * Compute BTTS (Both Teams To Score) probability
   */
  private computeBTTS(
    homeStats: TeamStats,
    awayStats: TeamStats,
    homeInjuryFactor: number,
    awayInjuryFactor: number,
  ): ProbabilityResult {
    const homeScoreProb = (homeStats.matchesScored / homeStats.matchesPlayed) * homeInjuryFactor;
    const awayScoreProb = (awayStats.matchesScored / awayStats.matchesPlayed) * awayInjuryFactor;

    const bttsProb = homeScoreProb * awayScoreProb;

    return {
      market: 'BTTS_YES',
      probability: bttsProb,
      confidence: 0.78,
      explanation: `Home team scores in ${(homeScoreProb * 100).toFixed(1)}% of matches, away team in ${(awayScoreProb * 100).toFixed(1)}%`,
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
      // Sum of all combinations where home > away
      for (let h = 1; h <= 10; h++) {
        for (let a = 0; a < h; a++) {
          const hProb = (Math.exp(-homeGoals) * Math.pow(homeGoals, h)) / this.factorial(h);
          const aProb = (Math.exp(-awayGoals) * Math.pow(awayGoals, a)) / this.factorial(a);
          prob += hProb * aProb;
        }
      }
    } else if (outcome === 'draw') {
      // Sum of all combinations where home === away
      for (let goals = 0; goals <= 10; goals++) {
        const hProb = (Math.exp(-homeGoals) * Math.pow(homeGoals, goals)) / this.factorial(goals);
        const aProb = (Math.exp(-awayGoals) * Math.pow(awayGoals, goals)) / this.factorial(goals);
        prob += hProb * aProb;
      }
    } else {
      // Sum of all combinations where away > home
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
      include: { stats: true },
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
      const teamStats = event.stats.find(
        (s) => s.teamId === teamId,
      );

      if (!teamStats) continue;

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
      if (goalsScored > goalsAgainst) {
        totalWins++;
      } else if (goalsScored === goalsAgainst) {
        totalWins += 0.33; // Draw counts as partial win
      }

      // Stats
      totalCorners += teamStats.corners || 0;
      totalYellowCards += teamStats.yellowCards || 0;
      totalRedCards += teamStats.redCards || 0;
      totalPossession += teamStats.possession || 50;
      totalShotsOnTarget += teamStats.shotsOnTarget || 0;
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
      // Key players (main attackers/defenders) get higher adjustment
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
