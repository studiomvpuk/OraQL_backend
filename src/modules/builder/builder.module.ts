import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { StreaksModule } from '../streaks/streaks.module';
import { BuilderService } from './builder.service';
import { BuilderController } from './builder.controller';

@Module({
  imports: [PrismaModule, forwardRef(() => StreaksModule)],
  providers: [BuilderService],
  controllers: [BuilderController],
  exports: [BuilderService],
})
export class BuilderModule {}
