import { Controller, Get, Param, Query } from '@nestjs/common';
import { PicksService } from './picks.service';

@Controller('picks')
export class PicksController {
  constructor(private readonly picksService: PicksService) {}

  @Get('event/:eventId')
  async findByEvent(@Param('eventId') eventId: string) {
    return this.picksService.findByEvent(eventId);
  }

  @Get('top')
  async getTopPicks(
    @Query('sport') sport?: string,
    @Query('minProbability') minProbability?: string,
    @Query('limit') limit?: string,
  ) {
    return this.picksService.findTopPicks({
      sport,
      minProbability: minProbability ? parseFloat(minProbability) : undefined,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }
}
