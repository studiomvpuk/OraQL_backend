import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class BuilderService {
  constructor(private prisma: PrismaService) {}

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

    return {
      selections,
      count: selections.length,
      combinedProbability,
    };
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
      'OraQL_ BET SLIP',
      '='.repeat(40),
      '',
    ];

    state.selections.forEach((sel: any, i: number) => {
      const event = sel.market?.event;
      const eventName = event
        ? `${event.homeTeam?.shortName || event.homeTeam?.name || '?'} vs ${event.awayTeam?.shortName || event.awayTeam?.name || '?'}`
        : 'Event';
      lines.push(`${i + 1}. ${eventName}`);
      lines.push(`   ${sel.market.name}${sel.market.line != null ? ` (${sel.market.line})` : ''}`);
      lines.push(`   Probability: ${((sel.market.probability || 0) * 100).toFixed(1)}%`);
      lines.push('');
    });

    lines.push('='.repeat(40));
    lines.push(`Selections: ${state.count}`);
    lines.push(`Combined: ${(state.combinedProbability * 100).toFixed(2)}%`);
    lines.push(`Generated: ${new Date().toISOString()}`);

    return lines.join('\n');
  }
}
