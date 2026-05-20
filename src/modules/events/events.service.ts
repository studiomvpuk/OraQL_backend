import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Prisma } from '@prisma/client';

interface FindByDateFilters {
  sport?: string;
  leagueId?: string;
  date?: string;
  page?: number;
  limit?: number;
}

interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

interface FindByDateResponse {
  data: any[];
  meta: PaginationMeta;
}

@Injectable()
export class EventsService {
  constructor(private prisma: PrismaService) {}

  async findByDate(filters: FindByDateFilters): Promise<FindByDateResponse> {
    const {
      sport,
      leagueId,
      date,
      page = 1,
      limit = 20,
    } = filters;

    const skip = (page - 1) * limit;
    const where: Prisma.EventWhereInput = {};

    if (sport) {
      where.sport = sport;
    }

    if (leagueId) {
      where.leagueId = leagueId;
    }

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      where.startTime = {
        gte: startDate,
        lt: endDate,
      };
    }

    const [events, total] = await Promise.all([
      this.prisma.event.findMany({
        where,
        skip,
        take: limit,
        include: {
          league: true,
          homeTeam: true,
          awayTeam: true,
          picks: {
            where: { isActive: true },
          },
        },
        orderBy: { startTime: 'asc' },
      }),
      this.prisma.event.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      data: events,
      meta: {
        total,
        page,
        limit,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  async findById(id: string) {
    return this.prisma.event.findUnique({
      where: { id },
      include: {
        league: true,
        homeTeam: true,
        awayTeam: true,
        markets: {
          include: {
            picks: {
              where: { isActive: true },
            },
          },
          orderBy: [{ category: 'asc' }, { oracleProbability: 'desc' }],
        },
        picks: {
          where: { isActive: true },
        },
        lineups: {
          include: {
            entries: {
              include: {
                player: true,
              },
            },
          },
        },
        matchStats: true,
      },
    });
  }

  async findUpcoming(sport?: string, limit = 10) {
    const now = new Date();
    const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const where: Prisma.EventWhereInput = {
      startTime: {
        gte: now,
        lte: next24h,
      },
    };

    if (sport) {
      where.sport = sport;
    }

    return this.prisma.event.findMany({
      where,
      take: limit,
      include: {
        league: true,
        homeTeam: true,
        awayTeam: true,
      },
      orderBy: { startTime: 'asc' },
    });
  }

  async findLive(sport?: string) {
    const where: Prisma.EventWhereInput = {
      status: {
        in: ['LIVE', 'HALF_TIME'],
      },
    };

    if (sport) {
      where.sport = sport;
    }

    return this.prisma.event.findMany({
      where,
      include: {
        league: true,
        homeTeam: true,
        awayTeam: true,
        matchStats: true,
      },
      orderBy: { startTime: 'desc' },
    });
  }

  async getSportSummary(date?: string) {
    const where: Prisma.EventWhereInput = {};

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      where.startTime = {
        gte: startDate,
        lt: endDate,
      };
    }

    const results = await this.prisma.event.groupBy({
      by: ['sport'],
      where,
      _count: {
        id: true,
      },
    });

    return results.map((result) => ({
      sport: result.sport,
      count: result._count.id,
    }));
  }

  async getLeaguesForDate(sport: string, date?: string) {
    const where: Prisma.EventWhereInput = {
      sport,
    };

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      where.startTime = {
        gte: startDate,
        lt: endDate,
      };
    }

    const leagues = await this.prisma.event.groupBy({
      by: ['leagueId'],
      where,
      _count: {
        id: true,
      },
    });

    const leagueData = await Promise.all(
      leagues.map(async (league) => {
        const leagueInfo = await this.prisma.league.findUnique({
          where: { id: league.leagueId },
        });
        return {
          id: league.leagueId,
          name: leagueInfo?.name || 'Unknown',
          eventCount: league._count.id,
        };
      }),
    );

    return leagueData;
  }
}
