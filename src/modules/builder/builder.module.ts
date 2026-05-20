import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { BuilderService } from './builder.service';
import { BuilderController } from './builder.controller';

@Module({
  imports: [PrismaModule],
  providers: [BuilderService],
  controllers: [BuilderController],
  exports: [BuilderService],
})
export class BuilderModule {}
