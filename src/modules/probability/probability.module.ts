import { Module, forwardRef } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ProbabilityService } from './probability.service';
import { ExplanationService } from './explanation.service';
import { ProbabilityController } from './probability.controller';
import { StreaksModule } from '../streaks/streaks.module';

@Module({
  imports: [PrismaModule, forwardRef(() => StreaksModule)],
  controllers: [ProbabilityController],
  providers: [ProbabilityService, ExplanationService],
  exports: [ProbabilityService, ExplanationService],
})
export class ProbabilityModule {}
