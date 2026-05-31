import { Injectable, BadRequestException, Optional, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CrossLeagueService, SuggestedTicket } from '../streaks/cross-league.service';

@Injectable()
export class BuilderService {
  private readonly logger = new Logger(BuilderService.name);

  constructor(
    private prisma: PrismaService,
    @Optional() private crossLeagueService?: CrossLeagueService,
  ) {}

  async getSelections(userId: string) {
    const selections = await this.prisma.builderSelection.findMany({
      where: { userId },
      include: {
        market: {
          include: {
            event: {
              include: {
                homeTeam: true,
                awayTeam: true,
                league: true,
              },
            },
            streak: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    const probabilities = selections.map(
      (s: any) => s.market?.probability || 0,
    );
    const combinedProbability =
      probabilities.length > 0
        ? probabilities.reduce((acc: number, p: number) => acc * p, 1)
        : 1;

    // Count how many selections have streak backing
    const streakBackedCount = selections.filter(
      (s: any) => s.market?.streakId != null,
    ).length;

    // Unique leagues in the builder
    const uniqueLeagues = new Set(
      selections.map((s: any) => s.market?.event?.league?.name).filter(Boolean),
    ).size;

    return {
      selections,
      count: selections.length,
      combinedProbability,
      streakBackedCount,
      uniqueLeagues,
    };
  }

  /**
   * Get AI-suggested multi-leg tickets based on active streaks
   * across all upcoming events and leagues.
   */
  async getSuggestedTickets(filters?: {
    maxLegs?: number;
    minLegs?: number;
    limit?: number;
    leagueIds?: string[];
  }): Promise<SuggestedTicket[]> {
    if (!this.crossLeagueService) {
      return [];
    }

    try {
      return await this.crossLeagueService.generateSuggestedTickets(filters);
    } catch (error) {
      this.logger.warn('Failed to generate ticket suggestions', error);
      return [];
    }
  }

  /**
   * Auto-populate the builder with a suggested ticket's legs.
   */
  async applySuggestedTicket(
    userId: string,
    legs: Array<{
      marketId?: string;
      eventId?: string;
      marketName?: string;
      line?: number | null;
      confidence?: number;
      streakId?: string;
      streakSummary?: string;
    }>,
  ) {
    // Clear existing selections
    await this.clearSelections(userId);

    // Add each leg — resolve or create markets from streak data
    for (const leg of legs) {
      try {
        let marketId = leg.marketId;

        // If no marketId, find or create the market from streak data
        if (!marketId && leg.eventId && leg.marketName) {
          const existing = await this.prisma.market.findFirst({
            where: {
              eventId: leg.eventId,
              name: leg.marketName,
              ...(leg.line != null ? { line: leg.line } : {}),
            },
          });

          if (existing) {
            marketId = existing.id;
          } else {
            // Create a streak-backed market
            const cat = leg.marketName.includes('CORNER') ? 'CORNERS'
              : leg.marketName.includes('CARD') ? 'CARDS'
              : leg.marketName.includes('MATCH_RESULT') ? 'MATCH_RESULT'
              : 'GOALS';
            const created = await this.prisma.market.create({
              data: {
                eventId: leg.eventId,
                category: cat,
                name: leg.marketName,
                shortName: leg.marketName.replace(/_/g, ' '),
                line: leg.line ?? undefined,
                probability: leg.confidence ?? 0.5,
                confidence: leg.confidence ?? 0.5,
                isActive: true,
                streakId: leg.streakId ?? undefined,
                streakSummary: leg.streakSummary ?? undefined,
              },
            });
            marketId = created.id;
          }
        }

        if (marketId) {
          await this.addSelection(userId, marketId);
        }
      } catch {
        // Skip invalid/conflicting legs
      }
    }

    return this.getSelections(userId);
  }

  async addSelection(userId: string, marketId: string) {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
    });

    if (!market) {
      throw new BadRequestException('Market not found');
    }

    // Check for duplicate
    const existing = await this.prisma.builderSelection.findUnique({
      where: { userId_marketId: { userId, marketId } },
    });
    if (existing) {
      throw new BadRequestException('Market already in bet builder');
    }

    // Check for conflicting selections in the same event + category
    const existingSelections = await this.prisma.builderSelection.findMany({
      where: { userId },
      include: { market: true },
    });

    const conflict = existingSelections.find(
      (sel: any) =>
        sel.market.eventId === market.eventId &&
        sel.market.category === market.category &&
        sel.market.name !== market.name,
    );

    if (conflict) {
      throw new BadRequestException(
        `You already have a ${market.category} selection for this event. Remove it first.`,
      );
    }

    await this.prisma.builderSelection.create({
      data: {
        userId,
        marketId,
        addedProbability: market.probability,
      },
    });

    return this.getSelections(userId);
  }

  async removeSelectionByMarket(userId: string, marketId: string) {
    const selection = await this.prisma.builderSelection.findUnique({
      where: { userId_marketId: { userId, marketId } },
    });

    if (!selection) {
      throw new BadRequestException('Selection not found');
    }

    await this.prisma.builderSelection.delete({
      where: { id: selection.id },
    });

    return this.getSelections(userId);
  }

  async clearSelections(userId: string) {
    return this.prisma.builderSelection.deleteMany({
      where: { userId },
    });
  }

  async exportSelections(userId: string): Promise<string> {
    const state = await this.getSelections(userId);

    const lines: string[] = [
      '🏟️ OraQL_ Bet Slip',
      '━'.repeat(36),
      '',
    ];

    state.selections.forEach((sel: any, i: number) => {
      const event = sel.market?.event;
      const home = event?.homeTeam?.shortName || event?.homeTeam?.name || '?';
      const away = event?.awayTeam?.shortName || event?.awayTeam?.name || '?';
      const league = event?.league?.name || '';

      // Build a readable pick description from the raw market name
      const pick = this.formatMarketName(sel.market.name, sel.market.line, sel.market.category);
      const prob = ((sel.market.probability || 0) * 100).toFixed(1);

      lines.push(`${i + 1}. ${home} vs ${away}`);
      if (league) lines.push(`   ${league}`);
      lines.push(`   Pick: ${pick}`);
      lines.push(`   Probability: ${prob}%`);
      if (sel.market.streakSummary) {
        lines.push(`   Streak: ${sel.market.streakSummary}`);
      }
      lines.push('');
    });

    lines.push('━'.repeat(36));
    lines.push(`📊 ${state.count} selection${state.count !== 1 ? 's' : ''}`);
    lines.push(`🎯 Combined probability: ${(state.combinedProbability * 100).toFixed(2)}%`);
    lines.push('');
    lines.push('Powered by OraQL_');

    return lines.join('\n');
  }

  /**
   * Convert raw market names like GOALS_OVER into readable text like "Over 2.5 Goals"
   */
  private formatMarketName(name: string, line?: number, category?: string): string {
    const lineStr = line != null ? ` ${line}` : '';

    const categoryLabel: Record<string, string> = {
      GOALS: 'Goals',
      CORNERS: 'Corners',
      CARDS: 'Cards',
    };
    const catName = (category && categoryLabel[category]) || category || '';

    if (name.includes('OVER')) return `Over${lineStr} ${catName}`.trim();
    if (name.includes('UNDER')) return `Under${lineStr} ${catName}`.trim();
    if (name === 'BTTS_YES') return 'Both Teams to Score — Yes';
    if (name === 'BTTS_NO') return 'Both Teams to Score — No';
    if (name === 'HOME_WIN') return 'Home Win';
    if (name === 'AWAY_WIN') return 'Away Win';
    if (name === 'DRAW') return 'Draw';

    // Fallback: replace underscores, title-case
    return name
      .replace(/_/g, ' ')
      .toLowerCase()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }
}
