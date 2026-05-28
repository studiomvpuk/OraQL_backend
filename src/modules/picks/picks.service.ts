import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface FindTopPicksFilters {
  sport?: string;
  minProbability?: number;
  limit?: number;
}

@Injectable()
export class PicksService {
  private readonly MIN_PROBABILITY = 0.55;
  private readonly MAX_PICKS_PER_EVENT = 5;

  constructor(private prisma: PrismaService) {}

  async findByEvent(eventId: string) {
    return this.prisma.pick.findMany({
      where: {
        eventId,
        isActive: true,
      },
      include: {
        market: {
          include: {
            event: true,
          },
        },
      },
      orderBy: { rank: 'asc' },
    });
  }

  async findTopPicks(filters: FindTopPicksFilters) {
    const {
      sport,
      minProbability = this.MIN_PROBABILITY,
      limit = 20,
    } = filters;

    const where: any = {
      isActive: true,
      probability: {
        gte: minProbability,
      },
    };

    if (sport) {
      where.market = {
        event: {
          sport: sport as any,
        },
      };
    }

    const picks = await this.prisma.pick.findMany({
      where,
      take: limit,
      include: {
        market: {
          include: {
            event: {
              include: {
                league: true,
                homeTeam: true,
                awayTeam: true,
              },
            },
          },
        },
        event: {
          include: {
            league: true,
            homeTeam: true,
            awayTeam: true,
          },
        },
      },
      orderBy: [{ rank: 'asc' }, { probability: 'desc' }],
    });

    return picks;
  }

  async generateForEvent(eventId: string) {
    // Step 1: Deactivate old picks
    await this.prisma.pick.updateMany({
      where: { eventId },
      data: { isActive: false },
    });

    // Step 2: Get top markets above MIN_PROBABILITY
    const topMarkets = await this.prisma.market.findMany({
      where: {
        eventId,
        probability: {
          gte: this.MIN_PROBABILITY,
        },
      },
      orderBy: { probability: 'desc' },
      take: this.MAX_PICKS_PER_EVENT,
    });

    // Step 3: Create ranked picks
    const picks = await Promise.all(
      topMarkets.map((market: any, index: number) =>
        this.prisma.pick.create({
          data: {
            eventId,
            marketId: market.id,
            probability: market.probability,
            confidence: market.confidence,
            rank: index + 1,
            isActive: true,
            explanation: `Oracle ML model prediction for ${market.name}`,
          },
          include: {
            market: true,
          },
        }),
      ),
    );

    return picks;
  }
}
