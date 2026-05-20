import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  UseGuards,
  Request,
} from '@nestjs/common';
import { BuilderService } from './builder.service';

interface AddSelectionDto {
  selectedOutcome: string;
}

@Controller('builder')
export class BuilderController {
  constructor(private readonly builderService: BuilderService) {}

  @Get()
  async getSelections(@Request() req: any) {
    const userId = req.user?.id || 'anonymous';
    return this.builderService.getSelections(userId);
  }

  @Post('add/:marketId')
  async addSelection(
    @Param('marketId') marketId: string,
    @Body() dto: AddSelectionDto,
    @Request() req: any,
  ) {
    const userId = req.user?.id || 'anonymous';
    return this.builderService.addSelection(
      userId,
      marketId,
      dto.selectedOutcome,
    );
  }

  @Delete('remove/:selectionId')
  async removeSelection(
    @Param('selectionId') selectionId: string,
    @Request() req: any,
  ) {
    const userId = req.user?.id || 'anonymous';
    return this.builderService.removeSelection(userId, selectionId);
  }

  @Delete('clear')
  async clearSelections(@Request() req: any) {
    const userId = req.user?.id || 'anonymous';
    await this.builderService.clearSelections(userId);
    return { message: 'All selections cleared' };
  }

  @Get('export')
  async exportSelections(@Request() req: any) {
    const userId = req.user?.id || 'anonymous';
    const exportText = await this.builderService.exportSelections(userId);
    return {
      data: exportText,
      contentType: 'text/plain',
      filename: `betslip-${new Date().toISOString()}.txt`,
    };
  }
}
