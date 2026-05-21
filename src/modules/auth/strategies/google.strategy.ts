import { Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy, VerifyCallback } from 'passport-google-oauth20';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class GoogleStrategy extends PassportStrategy(Strategy, 'google') {
  private readonly logger = new Logger(GoogleStrategy.name);

  constructor(configService: ConfigService) {
    const clientID = configService.get<string>('GOOGLE_CLIENT_ID') || 'not-configured';
    const clientSecret = configService.get<string>('GOOGLE_CLIENT_SECRET') || 'not-configured';

    super({
      clientID,
      clientSecret,
      callbackURL: configService.get<string>('GOOGLE_CALLBACK_URL', 'http://localhost:3000/auth/google/callback'),
      scope: ['profile', 'email'],
    });

    if (clientID === 'not-configured') {
      this.logger.warn('GOOGLE_CLIENT_ID not set — Google OAuth will be unavailable');
    }
  }

  async validate(
    accessToken: string,
    refreshToken: string,
    profile: any,
    done: VerifyCallback,
  ): Promise<any> {
    // Extract profile information
    const profileData = {
      id: profile.id,
      displayName: profile.displayName,
      emails: profile.emails,
      photos: profile.photos,
      provider: profile.provider,
    };

    done(null, profileData);
  }
}
