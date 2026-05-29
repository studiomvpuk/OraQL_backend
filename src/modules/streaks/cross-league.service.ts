import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StreakAnalysisService } from './streak-analysis.service';

// ============================================================================
// TYPES
// ============================================================================

export interface TicketLeg {
  eventId: string;
  marketId: string | null;
  teamName: string;
  teamLogoUrl: string | null;
  leagueName: string;
  leagueCountry: string | null;
  opponent: string;
  kickoffAt: Date;
  marketName: string;
  line: number | null;
  probability: number;
  confidence: number;
  streakId: string;
  streakSummary: string;
  validationLevel?: string;
}

export interface SuggestedTicket {
  id: string;
  legs: TicketLeg[];
  combinedProbability: number;
  averageConfidence: number;
  averageHitRate: number;
  diversityScore: number; // how many different leagues/markets
  qualityScore: number;
  summary: string;
}

export interface CrossLeagueFilters {
  /** Max legs per ticket */
  maxLegs?: number;
  /** Min legs per ticket */
  minLegs?: number;
  /** Minimum combined probability */
  minCombinedProbability?: number;
  /** Maximum combined probability (avoid unrealistic tickets) */
  maxCombinedProbability?: number;
  /** Only include these sports */
  sports?: string[];
  /** Only include these league IDs */
  leagueIds?: string[];
  /** Maximum tickets to return */
  limit?: number;
}

// ============================================================================
// SERVICE
// ============================================================================

@Injectable()
export class CrossLeagueService {
  private readonly logger = new Logger(CrossLeagueService.name);

  private readonly DEFAULT_MAX_LEGS = 5;
  private readonly DEFAULT_MIN_LEGS = 2;
  private readonly DEFAULT_MIN_COMBINED_PROB = 0.08;
  private readonly DEFAULT_MAX_COMBINED_PROB = 0.55;
  private readonly DEFAULT_LIMIT = 10;

  constructor(
    private prisma: PrismaService,
    private streakAnalysisService: StreakAnalysisService,
  ) {}

  // ==========================================================================
  // MAIN: GENERATE SUGGESTED TICKETS
  // ==========================================================================

  /**
   * The PRESENT step of the pipeline.
   * Finds streak-backed picks across all upcoming events and assembles
   * optimal multi-leg tickets that span multiple leagues.
   */
  async generateSuggestedTickets(
    filters: CrossLeagueFilters = {},
  ): Promise<SuggestedTicket[]> {
    const maxLegs = filters.maxLegs || this.DEFAULT_MAX_LEGS;
    const minLegs = filters.minLegs || this.DEFAULT_MIN_LEGS;
    const minCombProb = filters.minCombinedProbability || this.DEFAULT_MIN_COMBINED_PROB;
    const maxCombProb = filters.maxCombinedProbability || this.DEFAULT_MAX_COMBINED_PROB;
    const limit = filters.limit || this.DEFAULT_LIMIT;

    // 1. Get all upcoming events (next 48 hours)
    const now = new Date();
    const cutoff = new Date(now.getTime() + 48 * 60 * 60 * 1000);

    const upcomingWhere: any = {
      status: { in: ['SCHEDULED', 'LINEUP_CONFIRMED'] },
      kickoffAt: { gte: now, lte: cutoff },
    };

    if (filters.leagueIds && filters.leagueIds.length > 0) {
      upcomingWhere.leagueId = { in: filters.leagueIds };
    }

    const upcomingEvents = await this.prisma.event.findMany({
      where: upcomingWhere,
      include: {
        homeTeam: true,
        awayTeam: true,
        league: true,
      },
      orderBy: { kickoffAt: 'asc' },
      take: 100,
    });

    if (upcomingEvents.length === 0) {
      return [];
    }

    // 2. For each event, get streak-backed suggestions
    const allLegs: TicketLeg[] = [];

    for (const event of upcomingEvents) {
      try {
        const suggestions =
          await this.streakAnalysisService.getStreakSuggestionsForEvent(event.id);

        for (const suggestion of suggestions) {
          if (suggestion.confidence < 0.5) continue; // skip low-confidence

          // Find the corresponding market in DB
          const market = await this.prisma.market.findFirst({
            where: {
              eventId: event.id,
              name: suggestion.marketName,
              line: suggestion.line,
            },
          });

          const isHome = suggestion.teamId === event.homeTeamId;
          const team = isHome ? event.homeTeam : event.awayTeam;
          const opponent = isHome ? event.awayTeam : event.homeTeam;

          allLegs.push({
            eventId: event.id,
            marketId: market?.id || null,
            teamName: team.name,
            teamLogoUrl: team.logoUrl,
            leagueName: event.league.name,
            leagueCountry: event.league.country,
            opponent: opponent.name,
            kickoffAt: event.kickoffAt,
            marketName: suggestion.marketName,
            line: suggestion.line,
            probability: market?.probability || suggestion.confidence,
            confidence: suggestion.confidence,
            streakId: suggestion.streakId,
            streakSummary: suggestion.summary,
            validationLevel: suggestion.validationLevel,
          });
        }
      } catch (error) {
        this.logger.warn(
          `Failed to get suggestions for event ${event.id}`,
          error,
        );
      }
    }

    if (allLegs.length < minLegs) {
      return [];
    }

    // 3. Sort legs by confidence (best first)
    allLegs.sort((a, b) => b.confidence - a.confidence);

    // 4. Assemble tickets using a greedy diversification strategy
    const tickets = this.assembleTickets(
      allLegs,
      minLegs,
      maxLegs,
      minCombProb,
      maxCombProb,
      limit,
    );

    return tickets;
  }

  // ==========================================================================
  // TICKET FOR A SPECIFIC EVENT
  // ==========================================================================

  /**
   * Get all streak-backed suggestions for a specific event,
   * formatted as potential ticket legs.
   */
  async getLegsForEvent(eventId: string): Promise<TicketLeg[]> {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: {
        homeTeam: true,
        awayTeam: true,
        league: true,
      },
    });

    if (!event) return [];

    const suggestions =
      await this.streakAnalysisService.getStreakSuggestionsForEvent(eventId);

    const legs: TicketLeg[] = [];

    for (const s of suggestions) {
      const market = await this.prisma.market.findFirst({
        where: {
          eventId,
          name: s.marketName,
          line: s.line,
        },
      });

      const isHome = s.teamId === event.homeTeamId;
      const team = isHome ? event.homeTeam : event.awayTeam;
      const opponent = isHome ? event.awayTeam : event.homeTeam;

      legs.push({
        eventId,
        marketId: market?.id || null,
        teamName: team.name,
        teamLogoUrl: team.logoUrl,
        leagueName: event.league.name,
        leagueCountry: event.league.country,
        opponent: opponent.name,
        kickoffAt: event.kickoffAt,
        marketName: s.marketName,
        line: s.line,
        probability: market?.probability || s.confidence,
        confidence: s.confidence,
        streakId: s.streakId,
        streakSummary: s.summary,
        validationLevel: s.validationLevel,
      });
    }

    return legs.sort((a, b) => b.confidence - a.confidence);
  }

  // ==========================================================================
  // TICKET ASSEMBLY
  // ==========================================================================

  /**
   * Assemble multi-leg tickets from available legs using a greedy approach
   * that maximizes diversity (different leagues, different market types).
   */
  private assembleTickets(
    allLegs: TicketLeg[],
    minLegs: number,
    maxLegs: number,
    minCombProb: number,
    maxCombProb: number,
    limit: number,
  ): SuggestedTicket[] {
    const tickets: SuggestedTicket[] = [];
    const usedCombinations = new Set<string>();

    // Strategy 1: Best-confidence tickets (pure quality)
    this.buildTicketVariant(
      allLegs,
      minLegs,
      maxLegs,
      minCombProb,
      maxCombProb,
      tickets,
      usedCombinations,
      'confidence',
      Math.ceil(limit / 3),
    );

    // Strategy 2: Max-diversity tickets (different leagues)
    this.buildTicketVariant(
      allLegs,
      minLegs,
      maxLegs,
      minCombProb,
      maxCombProb,
      tickets,
      usedCombinations,
      'diversity',
      Math.ceil(limit / 3),
    );

    // Strategy 3: Value tickets (high probability legs)
    this.buildTicketVariant(
      allLegs,
      minLegs,
      maxLegs,
      minCombProb,
      maxCombProb,
      tickets,
      usedCombinations,
      'probability',
      Math.ceil(limit / 3),
    );

    // Sort by quality score
    tickets.sort((a, b) => b.qualityScore - a.qualityScore);

    return tickets.slice(0, limit);
  }

  /**
   * Build tickets with a specific optimization strategy.
   */
  private buildTicketVariant(
    allLegs: TicketLeg[],
    minLegs: number,
    maxLegs: number,
    minCombProb: number,
    maxCombProb: number,
    tickets: SuggestedTicket[],
    usedCombinations: Set<string>,
    strategy: 'confidence' | 'diversity' | 'probability',
    targetCount: number,
  ): void {
    // Sort legs by the chosen strategy
    let sortedLegs: TicketLeg[];
    if (strategy === 'diversity') {
      // Interleave legs from different leagues
      sortedLegs = this.interleaveByLeague(allLegs);
    } else if (strategy === 'probability') {
      sortedLegs = [...allLegs].sort((a, b) => b.probability - a.probability);
    } else {
      sortedLegs = [...allLegs]; // already sorted by confidence
    }

    // Try different leg counts
    for (let legCount = maxLegs; legCount >= minLegs; legCount--) {
      if (tickets.length >= targetCount) break;

      // Greedy selection: pick legs avoiding same-event duplicates
      const selectedLegs: TicketLeg[] = [];
      const usedEvents = new Set<string>();
      const usedLeagues = new Set<string>();

      for (const leg of sortedLegs) {
        if (selectedLegs.length >= legCount) break;
        if (usedEvents.has(leg.eventId)) continue;

        // For diversity strategy, prefer different leagues
        if (strategy === 'diversity' && usedLeagues.has(leg.leagueName)) {
          continue;
        }

        selectedLegs.push(leg);
        usedEvents.add(leg.eventId);
        usedLeagues.add(leg.leagueName);
      }

      if (selectedLegs.length < minLegs) continue;

      // Check combined probability
      const combinedProb = selectedLegs.reduce(
        (acc, leg) => acc * leg.probability,
        1,
      );

      if (combinedProb < minCombProb || combinedProb > maxCombProb) continue;

      // Check uniqueness
      const comboKey = selectedLegs
        .map((l) => `${l.eventId}:${l.marketName}:${l.line}`)
        .sort()
        .join('|');
      if (usedCombinations.has(comboKey)) continue;
      usedCombinations.add(comboKey);

      // Score the ticket
      const ticket = this.scoreTicket(selectedLegs, tickets.length);
      tickets.push(ticket);
    }
  }

  /**
   * Interleave legs from different leagues for diversity.
   */
  private interleaveByLeague(legs: TicketLeg[]): TicketLeg[] {
    const byLeague = new Map<string, TicketLeg[]>();
    for (const leg of legs) {
      const arr = byLeague.get(leg.leagueName) || [];
      arr.push(leg);
      byLeague.set(leg.leagueName, arr);
    }

    const result: TicketLeg[] = [];
    const queues = Array.from(byLeague.values());
    let i = 0;

    while (result.length < legs.length) {
      let added = false;
      for (const queue of queues) {
        if (i < queue.length) {
          result.push(queue[i]);
          added = true;
        }
      }
      if (!added) break;
      i++;
    }

    return result;
  }

  /**
   * Score a ticket and build summary.
   */
  private scoreTicket(legs: TicketLeg[], index: number): SuggestedTicket {
    const combinedProbability = legs.reduce(
      (acc, leg) => acc * leg.probability,
      1,
    );

    const averageConfidence =
      legs.reduce((acc, leg) => acc + leg.confidence, 0) / legs.length;

    const averageHitRate = averageConfidence; // proxy via confidence

    // Diversity: unique leagues and market types
    const uniqueLeagues = new Set(legs.map((l) => l.leagueName)).size;
    const uniqueMarkets = new Set(legs.map((l) => l.marketName)).size;
    const diversityScore =
      (uniqueLeagues / legs.length) * 0.6 +
      (uniqueMarkets / legs.length) * 0.4;

    const qualityScore =
      averageConfidence * 0.35 +
      combinedProbability * 2 * 0.25 + // scale up since combined prob is small
      diversityScore * 0.25 +
      Math.min(legs.length / 5, 1) * 0.15;

    // Build summary like "3-leg: Arsenal O1.5 Goals + Rotterdam CS + Napoli O7.5 Corners"
    const legSummaries = legs.map((l) => {
      const shortTeam = l.teamName.length > 12 ? l.teamName.substring(0, 12) : l.teamName;
      const marketShort = this.shortMarketLabel(l.marketName, l.line);
      return `${shortTeam} ${marketShort}`;
    });

    const summary = `${legs.length}-leg: ${legSummaries.join(' + ')} (${(combinedProbability * 100).toFixed(1)}%)`;

    return {
      id: `ticket_${Date.now()}_${index}`,
      legs,
      combinedProbability,
      averageConfidence,
      averageHitRate,
      diversityScore,
      qualityScore,
      summary,
    };
  }

  /**
   * Short market label for ticket summaries.
   */
  private shortMarketLabel(marketName: string, line: number | null): string {
    const labels: Record<string, string> = {
      GOALS_OVER: `O${line}G`,
      GOALS_UNDER: `U${line}G`,
      TEAM_GOALS_OVER: `TO${line}G`,
      TEAM_GOALS_UNDER: `TU${line}G`,
      CORNERS_OVER: `O${line}C`,
      CORNERS_UNDER: `U${line}C`,
      CARDS_OVER: `O${line}Cd`,
      CARDS_UNDER: `U${line}Cd`,
      BTTS_YES: 'BTTS',
      BTTS_NO: 'NoBTTS',
      CLEAN_SHEET: 'CS',
      MATCH_RESULT_HOME: 'Win',
    };

    return labels[marketName] || marketName;
  }
}
