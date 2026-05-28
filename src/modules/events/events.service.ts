import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export interface FindByDateFilters {
  sport?: string;
  leagueId?: string;
  date?: string;
  page?: number;
  limit?: number;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

export interface FindByDateResponse {
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
    const where: any = {};

    if (sport) {
      where.sport = sport as any;
    }

    if (leagueId) {
      where.leagueId = leagueId;
    }

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      where.kickoffAt = {
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
        orderBy: { kickoffAt: 'asc' },
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
          orderBy: [{ category: 'asc' }, { probability: 'desc' }],
        },
        picks: {
          where: { isActive: true },
          include: {
            market: true,
          },
          orderBy: { rank: 'asc' },
        },
        lineups: {
          include: {
            team: true,
            entries: {
              include: {
                player: true,
              },
              orderBy: { isStarter: 'desc' },
            },
          },
        },
        bookmakerOdds: {
          orderBy: [{ marketName: 'asc' }, { bookmaker: 'asc' }],
        },
        matchStats: {
          include: {
            team: true,
          },
        },
      },
    });
  }

  async findUpcoming(sport?: string, limit = 10) {
    const now = new Date();
    const next24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);

    const where: any = {
      kickoffAt: {
        gte: now,
        lte: next24h,
      },
    };

    if (sport) {
      where.sport = sport as any;
    }

    return this.prisma.event.findMany({
      where,
      take: limit,
      include: {
        league: true,
        homeTeam: true,
        awayTeam: true,
      },
      orderBy: { kickoffAt: 'asc' },
    });
  }

  async findLive(sport?: string) {
    const where: any = {
      status: {
        in: ['LIVE', 'HALF_TIME'],
      },
    };

    if (sport) {
      where.sport = sport as any;
    }

    return this.prisma.event.findMany({
      where,
      include: {
        league: true,
        homeTeam: true,
        awayTeam: true,
        matchStats: true,
      },
      orderBy: { kickoffAt: 'desc' },
    });
  }

  async getSportSummary(date?: string) {
    const where: any = {};

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      where.kickoffAt = {
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

    return results.map((result: any) => ({
      sport: result.sport,
      eventCount: result._count.id,
    }));
  }

  async getLeaguesForDate(sport: string, date?: string) {
    const where: any = {
      sport: sport as any,
    };

    if (date) {
      const startDate = new Date(date);
      const endDate = new Date(date);
      endDate.setDate(endDate.getDate() + 1);

      where.kickoffAt = {
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
      leagues.map(async (league: any) => {
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
