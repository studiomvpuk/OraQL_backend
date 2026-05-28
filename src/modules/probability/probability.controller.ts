import { Controller, Post, Body, Logger, HttpCode } from '@nestjs/common';
import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';
import { ProbabilityService } from './probability.service';

class ComputeProbabilitiesDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(200)
  limit?: number;
}

@Controller('probability')
export class ProbabilityController {
  private readonly logger = new Logger(ProbabilityController.name);

  constructor(
    private probabilityService: ProbabilityService,
    private prisma: PrismaService,
  ) {}

  /**
   * Compute probabilities for upcoming SCHEDULED events.
   * POST /api/v1/probability/compute
   *
   * This fetches scheduled events, runs the probability engine on each,
   * creates Market records, and then generates Picks from the top markets.
   */
  @Post('compute')
  @HttpCode(200)
  async computeProbabilities(@Body() dto: ComputeProbabilitiesDto) {
    const limit = dto.limit || 50;
    this.logger.log(`Computing probabilities for up to ${limit} scheduled events`);

    // Get scheduled events that don't have markets yet
    const events = await this.prisma.event.findMany({
      where: {
        status: 'SCHEDULED',
        kickoffAt: {
          gte: new Date(),
        },
      },
      orderBy: { kickoffAt: 'asc' },
      take: limit,
      select: { id: true, externalId: true },
    });

    if (events.length === 0) {
      return { message: 'No scheduled upcoming events found', processed: 0 };
    }

    let processed = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const event of events) {
      try {
        await this.probabilityService.computeForEvent(event.id);
        processed++;
      } catch (error) {
        failed++;
        const msg = error instanceof Error ? error.message : 'Unknown error';
        errors.push(`Event ${event.id}: ${msg}`);
        this.logger.error(`Failed to compute for event ${event.id}: ${msg}`);
      }
    }

    // Generate picks from the computed markets
    let picksGenerated = 0;
    if (processed > 0) {
      try {
        const eventsWithMarkets = await this.prisma.event.findMany({
          where: {
            id: { in: events.map((e) => e.id) },
            markets: { some: {} },
          },
          select: { id: true },
        });

        for (const event of eventsWithMarkets) {
          try {
            // Deactivate old picks
            await this.prisma.pick.updateMany({
              where: { eventId: event.id },
              data: { isActive: false },
            });

            // Get markets with meaningful edge (55-95% range)
            // and pick the best from each category for variety
            const allMarkets = await this.prisma.market.findMany({
              where: {
                eventId: event.id,
                probability: { gte: 0.55, lte: 0.95 },
              },
              orderBy: { probability: 'desc' },
            });

            // Group by category, take best per category, then fill remaining slots
            const byCategory = new Map<string, typeof allMarkets>();
            for (const m of allMarkets) {
              const cat = m.category || 'OTHER';
              if (!byCategory.has(cat)) byCategory.set(cat, []);
              byCategory.get(cat)!.push(m);
            }

            const topMarkets: typeof allMarkets = [];
            // First pass: best market per category
            for (const [, markets] of byCategory) {
              if (markets.length > 0 && topMarkets.length < 5) {
                topMarkets.push(markets[0]);
              }
            }
            // Second pass: fill remaining slots with next-best overall
            for (const m of allMarkets) {
              if (topMarkets.length >= 5) break;
              if (!topMarkets.some((t) => t.id === m.id)) {
                topMarkets.push(m);
              }
            }

            for (let i = 0; i < topMarkets.length; i++) {
              await this.prisma.pick.upsert({
                where: {
                  eventId_rank: {
                    eventId: event.id,
                    rank: i + 1,
                  },
                },
                update: {
                  marketId: topMarkets[i].id,
                  probability: topMarkets[i].probability,
                  confidence: topMarkets[i].confidence,
                  rank: i + 1,
                  isActive: true,
                  explanation: topMarkets[i].explanation || `Oracle prediction for ${topMarkets[i].name}`,
                },
                create: {
                  eventId: event.id,
                  marketId: topMarkets[i].id,
                  probability: topMarkets[i].probability,
                  confidence: topMarkets[i].confidence,
                  rank: i + 1,
                  isActive: true,
                  explanation: topMarkets[i].explanation || `Oracle prediction for ${topMarkets[i].name}`,
                },
              });
              picksGenerated++;
            }
          } catch (error) {
            this.logger.error(`Failed to generate picks for event ${event.id}`, error);
          }
        }
      } catch (error) {
        this.logger.error('Failed to generate picks', error);
      }
    }

    return {
      processed,
      failed,
      picksGenerated,
      ...(errors.length > 0 && { errors: errors.slice(0, 10) }),
    };
  }
}
