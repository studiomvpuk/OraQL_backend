import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { ProbabilityService } from './probability.service';
import { ExplanationService } from './explanation.service';

@Module({
  imports: [PrismaModule],
  providers: [ProbabilityService, ExplanationService],
  exports: [ProbabilityService, ExplanationService],
})
export class ProbabilityModule {}
