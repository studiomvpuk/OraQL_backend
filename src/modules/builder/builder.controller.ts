import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
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
