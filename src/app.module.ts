import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bull';
import * as Joi from 'joi';
import { appConfig } from './config/app.config';
import { databaseConfig } from './config/database.config';
import { redisConfig } from './config/redis.config';
import { jwtConfig } from './config/jwt.config';
import { googleConfig } from './config/google.config';
import { r2Config } from './config/r2.config';
import { dataProviderConfig } from './config/data-providers.config';
import { throttleConfig } from './config/throttle.config';
import { PrismaModule } from './common/prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { EventsModule } from './modules/events/events.module';
import { MarketsModule } from './modules/markets/markets.module';
import { PicksModule } from './modules/picks/picks.module';
import { BuilderModule } from './modules/builder/builder.module';
import { IngestModule } from './modules/ingest/ingest.module';
import { ProbabilityModule } from './modules/probability/probability.module';
import { StorageModule } from './modules/storage/storage.module';
import { HealthModule } from './modules/health/health.module';
import { MailModule } from './modules/mail/mail.module';

@Module({
  imports: [
    // Configuration
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env.local', '.env'],
      validationSchema: Joi.object({
        NODE_ENV: Joi.string()
          .valid('development', 'production', 'test')
          .default('development'),
        PORT: Joi.number().default(4000),
        CORS_ORIGINS: Joi.string().default('http://localhost:3000'),
        REDIS_HOST: Joi.string().default('localhost'),
        REDIS_PORT: Joi.number().default(6379),
        DATABASE_URL: Joi.string().required(),
        REDIS_URL: Joi.string().optional(),
        JWT_SECRET: Joi.string().required(),
        JWT_EXPIRATION: Joi.string().default('24h'),
        GOOGLE_CLIENT_ID: Joi.string(),
        GOOGLE_CLIENT_SECRET: Joi.string(),
        R2_ACCOUNT_ID: Joi.string(),
        R2_ACCESS_KEY_ID: Joi.string(),
        R2_SECRET_ACCESS_KEY: Joi.string(),
        R2_BUCKET_NAME: Joi.string(),
        RESEND_API_KEY: Joi.string().optional(),
        RESEND_FROM_ADDRESS: Joi.string().default('OraQL_ <noreply@oraql.com>'),
        FRONTEND_URL: Joi.string().default('http://localhost:3000'),
        THROTTLE_TTL: Joi.number().default(60000),
        THROTTLE_LIMIT: Joi.number().default(10),
      }),
      load: [
        appConfig,
        databaseConfig,
        redisConfig,
        jwtConfig,
        googleConfig,
        r2Config,
        dataProviderConfig,
        throttleConfig,
      ],
    }),

    // Rate limiting
    ThrottlerModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        ttl: configService.get<number>('throttle.ttl', 60000),
        limit: configService.get<number>('throttle.limit', 10),
      }),
      inject: [ConfigService],
    }),

    // Scheduling
    ScheduleModule.forRoot(),

    // Job queue
    BullModule.forRootAsync({
      useFactory: (configService: ConfigService) => ({
        redis: configService.get<string>('redis.url'),
        defaultJobOptions: {
          removeOnComplete: true,
          removeOnFail: false,
          attempts: 3,
          backoff: {
            type: 'exponential',
            delay: 2000,
          },
        },
      }),
      inject: [ConfigService],
    }),

    // Core modules
    MailModule,
    PrismaModule,
    AuthModule,
    EventsModule,
    MarketsModule,
    PicksModule,
    BuilderModule,
    IngestModule,
    ProbabilityModule,
    StorageModule,
    HealthModule,
  ],
})
export class AppModule {}
