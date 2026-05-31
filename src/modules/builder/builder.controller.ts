import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Query,
  Body,
  Request,
} from '@nestjs/common';
import { BuilderService } from './builder.service';

@Controller('builder')
export class BuilderController {
  constructor(private readonly builderService: BuilderService) {}

  @Get()
  async getSelections(@Request() req: any) {
    const userId = this.getUserId(req);
    return this.builderService.getSelections(userId);
  }

  @Post('add/:marketId')
  async addSelection(
    @Param('marketId') marketId: string,
    @Request() req: any,
  ) {
    const userId = this.getUserId(req);
    return this.builderService.addSelection(userId, marketId);
  }

  @Delete('remove/:marketId')
  async removeSelection(
    @Param('marketId') marketId: string,
    @Request() req: any,
  ) {
    const userId = this.getUserId(req);
    return this.builderService.removeSelectionByMarket(userId, marketId);
  }

  @Delete('clear')
  async clearSelections(@Request() req: any) {
    const userId = this.getUserId(req);
    await this.builderService.clearSelections(userId);
    return { message: 'All selections cleared' };
  }

  @Get('export')
  async exportSelections(@Request() req: any) {
    const userId = this.getUserId(req);
    const text = await this.builderService.exportSelections(userId);
    return { text };
  }

  /**
   * GET /api/v1/builder/suggestions
   * Get AI-suggested multi-leg tickets based on active streaks
   * across all upcoming events and leagues.
   */
  @Get('suggestions')
  async getSuggestedTickets(
    @Query('maxLegs') maxLegs?: string,
    @Query('minLegs') minLegs?: string,
    @Query('limit') limit?: string,
  ) {
    const tickets = await this.builderService.getSuggestedTickets({
      maxLegs: maxLegs ? parseInt(maxLegs, 10) : undefined,
      minLegs: minLegs ? parseInt(minLegs, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
    return { tickets, total: tickets.length };
  }

  /**
   * POST /api/v1/builder/apply-suggestion
   * Apply a suggested ticket — clears builder and adds the ticket's legs.
   * Accepts marketId (existing market) or eventId+marketName+line (auto-creates from streak).
   */
  @Post('apply-suggestion')
  async applySuggestion(
    @Body() body: {
      legs: Array<{
        marketId?: string;
        eventId?: string;
        marketName?: string;
        line?: number | null;
        confidence?: number;
        streakId?: string;
        streakSummary?: string;
      }>;
    },
    @Request() req: any,
  ) {
    const userId = this.getUserId(req);
    return this.builderService.applySuggestedTicket(userId, body.legs || []);
  }

  /**
   * Get user ID from request, falling back to session-based anonymous ID.
   * Uses IP + user-agent hash for anonymous users so the builder persists
   * across page refreshes without requiring login.
   */
  private getUserId(req: any): string {
    if (req.user?.id) return req.user.id;
    // For anonymous/guest users, use a stable identifier from headers
    const ip = req.ip || req.headers['x-forwarded-for'] || 'unknown';
    const ua = req.headers['user-agent'] || '';
    // Simple hash for session stability
    let hash = 0;
    const str = `${ip}:${ua}`;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `anon_${Math.abs(hash).toString(36)}`;
  }
}
