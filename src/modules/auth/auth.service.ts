import { Injectable, BadRequestException, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';

interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(
    email: string,
    password: string,
    firstName?: string,
    lastName?: string,
  ): Promise<{ user: any; tokenPair: TokenPair }> {
    // Check if user already exists
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    // Validate password strength
    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }

    // Hash password with bcrypt 12 rounds
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const user = await this.prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        firstName: firstName || null,
        lastName: lastName || null,
        role: 'USER', // Default role
      },
    });

    // Generate token pair
    const tokenPair = this.generateTokenPair(user.id, user.email, user.role);

    // Store hashed refresh token
    const hashedRefreshToken = await bcrypt.hash(tokenPair.refreshToken, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: hashedRefreshToken },
    });

    return {
      user: this.sanitizeUser(user),
      tokenPair,
    };
  }

  async validateLocal(email: string, password: string): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid email or password');
    }

    // Compare password with bcrypt
    const isPasswordValid = await bcrypt.compare(password, user.password);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.sanitizeUser(user);
  }

  async login(user: any): Promise<{ user: any; tokenPair: TokenPair }> {
    const tokenPair = this.generateTokenPair(user.id, user.email, user.role);

    // Store hashed refresh token
    const hashedRefreshToken = await bcrypt.hash(tokenPair.refreshToken, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: hashedRefreshToken },
    });

    return {
      user: this.sanitizeUser(user),
      tokenPair,
    };
  }

  async handleGoogleAuth(profile: any): Promise<{ user: any; tokenPair: TokenPair }> {
    const { emails, displayName, photos } = profile;
    const email = emails?.[0]?.value;

    if (!email) {
      throw new BadRequestException('Google profile does not contain email');
    }

    // Parse display name into firstName and lastName
    const nameParts = displayName?.split(' ') || [];
    const firstName = nameParts[0] || null;
    const lastName = nameParts.slice(1).join(' ') || null;
    const photoUrl = photos?.[0]?.value || null;

    // Upsert user
    const user = await this.prisma.user.upsert({
      where: { email },
      update: {
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        photoUrl: photoUrl || undefined,
      },
      create: {
        email,
        firstName,
        lastName,
        photoUrl,
        role: 'USER',
        // No password for OAuth users
        password: null,
      },
    });

    // Generate token pair
    const tokenPair = this.generateTokenPair(user.id, user.email, user.role);

    // Store hashed refresh token
    const hashedRefreshToken = await bcrypt.hash(tokenPair.refreshToken, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: hashedRefreshToken },
    });

    return {
      user: this.sanitizeUser(user),
      tokenPair,
    };
  }

  async refreshTokens(userId: string, refreshToken: string): Promise<TokenPair> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }

    if (!user.refreshToken) {
      throw new UnauthorizedException('Refresh token not found. Please login again');
    }

    // Validate refresh token hash
    const isValidRefreshToken = await bcrypt.compare(refreshToken, user.refreshToken);

    if (!isValidRefreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    // Generate new token pair
    const newTokenPair = this.generateTokenPair(user.id, user.email, user.role);

    // Store new hashed refresh token
    const hashedRefreshToken = await bcrypt.hash(newTokenPair.refreshToken, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: hashedRefreshToken },
    });

    return newTokenPair;
  }

  async logout(userId: string): Promise<void> {
    await this.prisma.user.update({
      where: { id: userId },
      data: { refreshToken: null },
    });
  }

  generateTokenPair(userId: string, email: string, role: string): TokenPair {
    const payload = {
      sub: userId,
      email,
      role,
    };

    // Access token: 15 minutes
    const accessToken = this.jwtService.sign(payload, {
      expiresIn: '15m',
    });

    // Refresh token: 30 days
    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: '30d',
      secret: this.configService.get<string>('JWT_REFRESH_SECRET', 'your-refresh-secret-key'),
    });

    return {
      accessToken,
      refreshToken,
    };
  }

  private sanitizeUser(user: any) {
    const { password, refreshToken, ...sanitized } = user;
    return sanitized;
  }
}
