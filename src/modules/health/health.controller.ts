import { Controller, Get } from '@nestjs/common';
import { Public } from '../../decorators/public.decorator';
import { PrismaService } from '../../prisma/prisma.service';

interface HealthResponse {
  status: 'ok' | 'error';
  database: 'ok' | 'error';
  timestamp: string;
  uptime: number;
}

@Controller('health')
export class HealthController {
  private startTime = Date.now();

  constructor(private prisma: PrismaService) {}

  @Public()
  @Get()
  async check(): Promise<HealthResponse> {
    let databaseStatus: 'ok' | 'error' = 'ok';

    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (error) {
      databaseStatus = 'error';
    }

    const status = databaseStatus === 'ok' ? 'ok' : 'error';
    const uptime = Math.floor((Date.now() - this.startTime) / 1000);

    return {
      status,
      database: databaseStatus,
      timestamp: new Date().toISOString(),
      uptime,
    };
  }
}
