import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { PicksService } from './picks.service';
import { PicksController } from './picks.controller';

@Module({
  imports: [PrismaModule],
  providers: [PicksService],
  controllers: [PicksController],
  exports: [PicksService],
})
export class PicksModule {}
