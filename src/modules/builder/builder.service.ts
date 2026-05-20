import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

interface SelectionItem {
  id: string;
  marketId: string;
  marketName: string;
  eventId: string;
  eventName: string;
  probability: number;
  odds: number;
  selectedOutcome: string;
}

interface SelectionsResponse {
  selections: SelectionItem[];
  combinedProbability: number;
  combinedOdds: number;
}

@Injectable()
export class BuilderService {
  constructor(private prisma: PrismaService) {}

  private calculateCombinedProbability(probabilities: number[]): number {
    if (probabilities.length === 0) return 0;
    return probabilities.reduce((acc, prob) => acc * prob, 1);
  }

  private calculateCombinedOdds(odds: number[]): number {
    if (odds.length === 0) return 1;
    return odds.reduce((acc, odd) => acc * odd, 1);
  }

  async getSelections(userId: string): Promise<SelectionsResponse> {
    const selections = await this.prisma.selection.findMany({
      where: { userId },
      include: {
        market: {
          include: {
            event: true,
          },
        },
      },
    });

    const formattedSelections = selections.map((sel) => ({
      id: sel.id,
      marketId: sel.marketId,
      marketName: sel.market.name,
      eventId: sel.market.eventId,
      eventName: `${sel.market.event.homeTeam} vs ${sel.market.event.awayTeam}`,
      probability: sel.market.oracleProbability || 0,
      odds: sel.market.odds || 1,
      selectedOutcome: sel.selectedOutcome,
    }));

    const probabilities = formattedSelections.map((s) => s.probability);
    const odds = formattedSelections.map((s) => s.odds);

    return {
      selections: formattedSelections,
      combinedProbability: this.calculateCombinedProbability(probabilities),
      combinedOdds: this.calculateCombinedOdds(odds),
    };
  }

  async addSelection(
    userId: string,
    marketId: string,
    selectedOutcome: string,
  ) {
    const market = await this.prisma.market.findUnique({
      where: { id: marketId },
      include: {
        event: true,
      },
    });

    if (!market) {
      throw new BadRequestException('Market not found');
    }

    // Check for Over/Under conflicts
    const existingSelections = await this.prisma.selection.findMany({
      where: { userId },
      include: {
        market: true,
      },
    });

    const sameEventSelections = existingSelections.filter(
      (sel) => sel.market.eventId === market.eventId,
    );

    for (const sel of sameEventSelections) {
      if (
        (sel.market.category === 'OVER_UNDER' &&
          market.category === 'OVER_UNDER') ||
        (sel.selectedOutcome === 'OVER' && selectedOutcome === 'UNDER') ||
        (sel.selectedOutcome === 'UNDER' && selectedOutcome === 'OVER')
      ) {
        throw new BadRequestException(
          'Cannot add both Over and Under selections for the same event',
        );
      }
    }

    return this.prisma.selection.create({
      data: {
        userId,
        marketId,
        selectedOutcome,
      },
      include: {
        market: {
          include: {
            event: true,
          },
        },
      },
    });
  }

  async removeSelection(userId: string, selectionId: string) {
    const selection = await this.prisma.selection.findUnique({
      where: { id: selectionId },
    });

    if (!selection || selection.userId !== userId) {
      throw new BadRequestException('Selection not found');
    }

    return this.prisma.selection.delete({
      where: { id: selectionId },
    });
  }

  async clearSelections(userId: string) {
    return this.prisma.selection.deleteMany({
      where: { userId },
    });
  }

  async exportSelections(userId: string): Promise<string> {
    const response = await this.getSelections(userId);

    let exportText = 'ORACLE SPORTS BET SLIP\n';
    exportText += '='.repeat(50) + '\n\n';

    response.selections.forEach((sel, index) => {
      exportText += `${index + 1}. ${sel.eventName}\n`;
      exportText += `   Market: ${sel.marketName}\n`;
      exportText += `   Outcome: ${sel.selectedOutcome}\n`;
      exportText += `   Probability: ${(sel.probability * 100).toFixed(2)}%\n`;
      exportText += `   Odds: ${sel.odds.toFixed(2)}\n\n`;
    });

    exportText += '='.repeat(50) + '\n';
    exportText += `Combined Probability: ${(response.combinedProbability * 100).toFixed(2)}%\n`;
    exportText += `Combined Odds: ${response.combinedOdds.toFixed(2)}\n`;
    exportText += `Generated: ${new Date().toISOString()}\n`;

    return exportText;
  }
}
