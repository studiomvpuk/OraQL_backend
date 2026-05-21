import {
  Injectable,
  BadRequestException,
  UnauthorizedException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { randomBytes } from 'crypto';
import { authenticator } from 'otplib';
import * as QRCode from 'qrcode';
import { PrismaService } from '../prisma/prisma.service';
import { MailService } from '../mail/mail.service';

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly mailService: MailService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // REGISTRATION
  // ═══════════════════════════════════════════════════════════════════════════

  async register(
    email: string,
    password: string,
    firstName?: string,
    lastName?: string,
  ): Promise<{ user: any; tokenPair: TokenPair; message: string }> {
    const existingUser = await this.prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      throw new ConflictException('User with this email already exists');
    }

    if (!password || password.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }

    // Validate mixed case + number per PRD
    if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password)) {
      throw new BadRequestException(
        'Password must contain at least one uppercase letter, one lowercase letter, and one number',
      );
    }

    const hashedPassword = await bcrypt.hash(password, 12);

    // Generate email verification token (expires in 24 hours)
    const emailVerifyToken = randomBytes(32).toString('hex');
    const emailVerifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const user = await this.prisma.user.create({
      data: {
        email,
        passwordHash: hashedPassword,
        firstName: firstName || null,
        lastName: lastName || null,
        role: 'USER',
        emailVerified: false,
        emailVerifyToken,
        emailVerifyExpiry,
      },
    });

    const tokenPair = this.generateTokenPair(user.id, user.email, user.role);

    const hashedRefreshToken = await bcrypt.hash(tokenPair.refreshToken, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: hashedRefreshToken },
    });

    await this.mailService.sendVerificationEmail(email, emailVerifyToken);

    return {
      user: this.sanitizeUser(user),
      tokenPair,
      message: 'Registration successful. Please check your email to verify your account.',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EMAIL VERIFICATION
  // ═══════════════════════════════════════════════════════════════════════════

  async verifyEmail(token: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { emailVerifyToken: token },
    });

    if (!user) {
      throw new BadRequestException('Invalid verification token');
    }

    if (user.emailVerifyExpiry && user.emailVerifyExpiry < new Date()) {
      throw new BadRequestException('Verification token has expired. Please request a new one.');
    }

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerified: true,
        emailVerifyToken: null,
        emailVerifyExpiry: null,
      },
    });

    return { message: 'Email verified successfully' };
  }

  async resendVerificationEmail(email: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user) {
      // Don't reveal whether email exists
      return { message: 'If this email is registered, a verification link has been sent.' };
    }

    if (user.emailVerified) {
      throw new BadRequestException('Email is already verified');
    }

    const emailVerifyToken = randomBytes(32).toString('hex');
    const emailVerifyExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await this.prisma.user.update({
      where: { id: user.id },
      data: { emailVerifyToken, emailVerifyExpiry },
    });

    await this.mailService.sendVerificationEmail(email, emailVerifyToken);

    return { message: 'If this email is registered, a verification link has been sent.' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PASSWORD RESET
  // ═══════════════════════════════════════════════════════════════════════════

  async forgotPassword(email: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Always return same message to prevent email enumeration
    const genericMessage = 'If this email is registered, a password reset link has been sent.';

    if (!user) {
      return { message: genericMessage };
    }

    // Don't allow password reset for OAuth-only users
    if (user.authProvider !== 'LOCAL' && !user.passwordHash) {
      return { message: genericMessage };
    }

    const passwordResetToken = randomBytes(32).toString('hex');
    const passwordResetExpiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordResetToken, passwordResetExpiry },
    });

    await this.mailService.sendPasswordResetEmail(email, passwordResetToken);

    return { message: genericMessage };
  }

  async resetPassword(token: string, newPassword: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { passwordResetToken: token },
    });

    if (!user) {
      throw new BadRequestException('Invalid or expired reset token');
    }

    if (user.passwordResetExpiry && user.passwordResetExpiry < new Date()) {
      throw new BadRequestException('Password reset token has expired. Please request a new one.');
    }

    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException('Password must be at least 8 characters long');
    }

    if (!/[A-Z]/.test(newPassword) || !/[a-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      throw new BadRequestException(
        'Password must contain at least one uppercase letter, one lowercase letter, and one number',
      );
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await this.prisma.user.update({
      where: { id: user.id },
      data: {
        passwordHash: hashedPassword,
        passwordResetToken: null,
        passwordResetExpiry: null,
        refreshToken: null, // Invalidate all sessions
      },
    });

    return { message: 'Password reset successfully. Please log in with your new password.' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2FA / TOTP
  // ═══════════════════════════════════════════════════════════════════════════

  async setup2FA(userId: string): Promise<{ secret: string; qrCodeDataUrl: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new NotFoundException('User not found');
    }

    if (user.twoFactorEnabled) {
      throw new BadRequestException('2FA is already enabled');
    }

    const secret = authenticator.generateSecret();
    const otpAuthUrl = authenticator.keyuri(user.email, 'OraQL_', secret);
    const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl);

    // Store secret temporarily (not yet enabled until verified)
    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorSecret: secret },
    });

    return { secret, qrCodeDataUrl };
  }

  async verify2FA(userId: string, token: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.twoFactorSecret) {
      throw new BadRequestException('2FA setup not initiated');
    }

    const isValid = authenticator.verify({
      token,
      secret: user.twoFactorSecret,
    });

    if (!isValid) {
      throw new BadRequestException('Invalid 2FA code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: { twoFactorEnabled: true },
    });

    return { message: '2FA enabled successfully' };
  }

  async validate2FAToken(userId: string, token: string): Promise<boolean> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      return false;
    }

    return authenticator.verify({
      token,
      secret: user.twoFactorSecret,
    });
  }

  async disable2FA(userId: string, token: string): Promise<{ message: string }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new BadRequestException('2FA is not enabled');
    }

    const isValid = authenticator.verify({
      token,
      secret: user.twoFactorSecret,
    });

    if (!isValid) {
      throw new BadRequestException('Invalid 2FA code');
    }

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        twoFactorEnabled: false,
        twoFactorSecret: null,
      },
    });

    return { message: '2FA disabled successfully' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LOGIN & LOCAL VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════

  async validateLocal(email: string, password: string): Promise<any> {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    if (!user || !user.passwordHash) {
      throw new UnauthorizedException('Invalid email or password');
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      throw new UnauthorizedException('Invalid email or password');
    }

    return this.sanitizeUser(user);
  }

  async login(user: any): Promise<{
    user: any;
    tokenPair?: TokenPair;
    requires2FA?: boolean;
  }> {
    // Check if 2FA is enabled — if so, don't issue tokens yet
    const fullUser = await this.prisma.user.findUnique({
      where: { id: user.id },
    });

    if (fullUser?.twoFactorEnabled) {
      return {
        user: { id: user.id, email: user.email },
        requires2FA: true,
      };
    }

    const tokenPair = this.generateTokenPair(user.id, user.email, user.role);

    const hashedRefreshToken = await bcrypt.hash(tokenPair.refreshToken, 12);
    await this.prisma.user.update({
      where: { id: user.id },
      data: { refreshToken: hashedRefreshToken },
    });

    return {
      user: this.sanitizeUser(fullUser || user),
      tokenPair,
    };
  }

  async loginWith2FA(
    userId: string,
    totpToken: string,
  ): Promise<{ user: any; tokenPair: TokenPair }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user || !user.twoFactorEnabled || !user.twoFactorSecret) {
      throw new UnauthorizedException('2FA not enabled for this user');
    }

    const isValid = authenticator.verify({
      token: totpToken,
      secret: user.twoFactorSecret,
    });

    if (!isValid) {
      throw new UnauthorizedException('Invalid 2FA code');
    }

    const tokenPair = this.generateTokenPair(user.id, user.email, user.role);

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

  // ═══════════════════════════════════════════════════════════════════════════
  // GOOGLE AUTH
  // ═══════════════════════════════════════════════════════════════════════════

  async handleGoogleAuth(profile: any): Promise<{ user: any; tokenPair: TokenPair }> {
    const { emails, displayName, photos, id: googleId } = profile;
    const email = emails?.[0]?.value;

    if (!email) {
      throw new BadRequestException('Google profile does not contain email');
    }

    const nameParts = displayName?.split(' ') || [];
    const firstName = nameParts[0] || null;
    const lastName = nameParts.slice(1).join(' ') || null;
    const avatarUrl = photos?.[0]?.value || null;

    const user = await this.prisma.user.upsert({
      where: { email },
      update: {
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        avatarUrl: avatarUrl || undefined,
        googleId: googleId || undefined,
      },
      create: {
        email,
        firstName,
        lastName,
        avatarUrl,
        googleId,
        authProvider: 'GOOGLE',
        emailVerified: true, // Google emails are pre-verified
        role: 'USER',
      },
    });

    const tokenPair = this.generateTokenPair(user.id, user.email, user.role);

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

  // ═══════════════════════════════════════════════════════════════════════════
  // TOKEN REFRESH & LOGOUT
  // ═══════════════════════════════════════════════════════════════════════════

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

    const isValidRefreshToken = await bcrypt.compare(refreshToken, user.refreshToken);

    if (!isValidRefreshToken) {
      throw new UnauthorizedException('Invalid refresh token');
    }

    const newTokenPair = this.generateTokenPair(user.id, user.email, user.role);

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

  // ═══════════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════════

  generateTokenPair(userId: string, email: string, role: string): TokenPair {
    const payload = { sub: userId, email, role };

    const accessToken = this.jwtService.sign(payload, {
      expiresIn: '15m',
    });

    const refreshToken = this.jwtService.sign(payload, {
      expiresIn: '30d',
      secret: this.configService.get<string>('JWT_REFRESH_SECRET', 'your-refresh-secret-key'),
    });

    return { accessToken, refreshToken };
  }

  private sanitizeUser(user: any) {
    const { passwordHash, refreshToken, twoFactorSecret, emailVerifyToken, passwordResetToken, ...sanitized } = user;
    return sanitized;
  }
}
