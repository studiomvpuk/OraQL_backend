import { Controller, Get, Param, Query } from '@nestjs/common';
import { EventsService } from './events.service';

@Controller('events')
export class EventsController {
  constructor(private readonly eventsService: EventsService) {}

  @Get()
  async findByDate(
    @Query('sport') sport?: string,
    @Query('leagueId') leagueId?: string,
    @Query('date') date?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.eventsService.findByDate({
      sport,
      leagueId,
      date,
      page: page ? parseInt(page, 10) : 1,
      limit: limit ? parseInt(limit, 10) : 20,
    });
  }

  @Get('sports-summary')
  async getSportsSummary(@Query('date') date?: string) {
    return this.eventsService.getSportSummary(date);
  }

  @Get('leagues')
  async getLeagues(
    @Query('sport') sport: string,
    @Query('date') date?: string,
  ) {
    return this.eventsService.getLeaguesForDate(sport, date);
  }

  @Get('upcoming')
  async getUpcoming(
    @Query('sport') sport?: string,
    @Query('limit') limit?: string,
  ) {
    return this.eventsService.findUpcoming(
      sport,
      limit ? parseInt(limit, 10) : 10,
    );
  }

  @Get('live')
  async getLive(@Query('sport') sport?: string) {
    return this.eventsService.findLive(sport);
  }

  @Get('team/:teamId/context')
  async getTeamContext(@Param('teamId') teamId: string) {
    return this.eventsService.getTeamContext(teamId);
  }

  @Get(':id')
  async findById(@Param('id') id: string) {
    return this.eventsService.findById(id);
  }
}
