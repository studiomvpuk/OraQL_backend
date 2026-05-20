import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

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

    const where: Prisma.PickWhereInput = {
      isActive: true,
      probability: {
        gte: minProbability,
      },
    };

    if (sport) {
      where.market = {
        event: {
          sport,
        },
      };
    }

    return this.prisma.pick.findMany({
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
      },
      orderBy: [{ rank: 'asc' }, { probability: 'desc' }],
    });
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
        oracleProbability: {
          gte: this.MIN_PROBABILITY,
        },
      },
      orderBy: { oracleProbability: 'desc' },
      take: this.MAX_PICKS_PER_EVENT,
    });

    // Step 3: Create ranked picks
    const picks = await Promise.all(
      topMarkets.map((market, index) =>
        this.prisma.pick.create({
          data: {
            eventId,
            marketId: market.id,
            probability: market.oracleProbability,
            odds: market.odds || 1.0,
            rank: index + 1,
            isActive: true,
            reason: `Oracle ML model prediction for ${market.name}`,
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
