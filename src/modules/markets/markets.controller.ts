import { Controller, Get, Param, Query } from '@nestjs/common';
import { MarketsService } from './markets.service';

@Controller('markets')
export class MarketsController {
  constructor(private readonly marketsService: MarketsService) {}

  @Get('event/:eventId')
  async findByEvent(
    @Param('eventId') eventId: string,
    @Query('category') category?: string,
  ) {
    return this.marketsService.findByEvent(eventId, category);
  }

  @Get('value-bets')
  async findValueBets(
    @Query('date') date?: string,
    @Query('sport') sport?: string,
  ) {
    return this.marketsService.findValueBets(date, sport);
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.marketsService.findById(id);
  }
}
