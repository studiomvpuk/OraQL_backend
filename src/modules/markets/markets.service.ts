import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MarketsService {
  private readonly VALUE_BET_THRESHOLD = 0.1; // 10%

  constructor(private prisma: PrismaService) {}

  async findByEvent(eventId: string, category?: string) {
    const where: any = {
      eventId,
    };

    if (category) {
      where.category = category as any;
    }

    return this.prisma.market.findMany({
      where,
      include: {
        picks: {
          where: { isActive: true },
        },
      },
      orderBy: [{ category: 'asc' }, { probability: 'desc' }],
    });
  }

  async findById(id: string) {
    return this.prisma.market.findUnique({
      where: { id },
      include: {
        event: true,
        picks: {
          where: { isActive: true },
        },
      },
    });
  }

  async findValueBets(date?: string, sport?: string) {
    const where: any = {
      isValueBet: true,
    };

    if (sport) {
      where.event = {
        sport: sport as any,
      };
    }

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      where.event = {
        ...where.event,
        kickoffAt: {
          gte: startDate,
          lt: endDate,
        },
      };
    }

    return this.prisma.market.findMany({
      where,
      include: {
        event: {
          include: {
            league: true,
            homeTeam: true,
            awayTeam: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async upsertMany(
    eventId: string,
    markets: Array<{
      name: string;
      category: string;
      line?: number;
      probability: number;
      confidence: number;
      impliedProbability?: number;
      explanation?: string;
    }>,
  ) {
    const results = [];

    for (const market of markets) {
      // Try to find existing market by eventId + name + line
      const existing = await this.prisma.market.findFirst({
        where: {
          eventId,
          name: market.name,
          line: market.line ?? null,
        },
      });

      if (existing) {
        const updated = await this.prisma.market.update({
          where: { id: existing.id },
          data: {
            probability: market.probability,
            confidence: market.confidence,
            impliedProbability: market.impliedProbability,
            explanation: market.explanation,
          },
        });
        results.push(updated);
      } else {
        const created = await this.prisma.market.create({
          data: {
            eventId,
            name: market.name,
            category: market.category as any,
            line: market.line,
            probability: market.probability,
            confidence: market.confidence,
            impliedProbability: market.impliedProbability,
            explanation: market.explanation,
          },
        });
        results.push(created);
      }
    }

    return results;
  }

  async updateValueBetFlags(eventId: string) {
    const markets = await this.prisma.market.findMany({
      where: { eventId },
    });

    const updates = markets
      .filter((market: any) => {
        if (!market.probability || !market.impliedProbability) {
          return false;
        }

        const diff = Math.abs(
          market.probability - market.impliedProbability,
        );
        return diff >= this.VALUE_BET_THRESHOLD;
      })
      .map((market: any) =>
        this.prisma.market.update({
          where: { id: market.id },
          data: { isValueBet: true },
        }),
      );

    return Promise.all(updates);
  }
}
