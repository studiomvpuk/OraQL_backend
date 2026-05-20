import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { EventsGateway } from './events.gateway';

@Module({
  imports: [PrismaModule],
  providers: [EventsService, EventsGateway],
  controllers: [EventsController],
  exports: [EventsService],
})
export class EventsModule {}
