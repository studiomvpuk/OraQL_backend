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
      orderBy: [{ category: 'asc' }, { oracleProbability: 'desc' }],
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
      externalId: string;
      name: string;
      category: string;
      options: any[];
      oracleProbability: number;
      impliedProbability?: number;
      odds?: number;
    }>,
  ) {
    const upserts = markets.map((market) =>
      this.prisma.market.upsert({
        where: {
          externalId_eventId: {
            externalId: market.externalId,
            eventId,
          },
        },
        update: {
          name: market.name,
          oracleProbability: market.oracleProbability,
          impliedProbability: market.impliedProbability,
          odds: market.odds,
          options: market.options,
        },
        create: {
          externalId: market.externalId,
          eventId,
          name: market.name,
          category: market.category,
          options: market.options,
          oracleProbability: market.oracleProbability,
          impliedProbability: market.impliedProbability,
          odds: market.odds,
        },
      }),
    );

    return Promise.all(upserts);
  }

  async updateValueBetFlags(eventId: string) {
    const markets = await this.prisma.market.findMany({
      where: { eventId },
    });

    const updates = markets
      .filter((market: any) => {
        if (!market.oracleProbability || !market.impliedProbability) {
          return false;
        }

        const diff = Math.abs(
          market.oracleProbability - market.impliedProbability,
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
