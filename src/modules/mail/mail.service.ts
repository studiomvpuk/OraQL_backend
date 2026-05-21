import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);
  private readonly resend: Resend;
  private readonly fromAddress: string;
  private readonly frontendUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.resend = new Resend(this.configService.get<string>('RESEND_API_KEY'));
    this.fromAddress = this.configService.get<string>(
      'RESEND_FROM_ADDRESS',
      'OraQL_ <noreply@oraql.com>',
    );
    this.frontendUrl = this.configService.get<string>(
      'FRONTEND_URL',
      'http://localhost:3000',
    );
  }

  // ─── Email Verification ─────────────────────────────────────────────────

  async sendVerificationEmail(email: string, token: string): Promise<void> {
    const verifyUrl = `${this.frontendUrl}/auth/verify-email?token=${token}`;

    try {
      await this.resend.emails.send({
        from: this.fromAddress,
        to: email,
        subject: 'Verify your OraQL_ account',
        html: this.verificationTemplate(verifyUrl),
      });
      this.logger.log(`Verification email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send verification email to ${email}`, error);
      // Don't throw — registration should succeed even if email fails
    }
  }

  // ─── Password Reset ─────────────────────────────────────────────────────

  async sendPasswordResetEmail(email: string, token: string): Promise<void> {
    const resetUrl = `${this.frontendUrl}/auth/reset-password?token=${token}`;

    try {
      await this.resend.emails.send({
        from: this.fromAddress,
        to: email,
        subject: 'Reset your OraQL_ password',
        html: this.passwordResetTemplate(resetUrl),
      });
      this.logger.log(`Password reset email sent to ${email}`);
    } catch (error) {
      this.logger.error(`Failed to send password reset email to ${email}`, error);
    }
  }

  // ─── HTML Templates ─────────────────────────────────────────────────────

  private verificationTemplate(verifyUrl: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#F7F5F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;border:1px solid #E8E4DC;">
    <tr>
      <td style="padding:40px 32px 24px;">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#1A1917;">OraQL_</h1>
        <p style="margin:0;font-size:13px;color:#8A8680;letter-spacing:0.5px;">SPORTS INTELLIGENCE</p>
      </td>
    </tr>
    <tr>
      <td style="padding:0 32px;">
        <div style="border-top:1px solid #E8E4DC;"></div>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;font-size:18px;font-weight:500;color:#1A1917;">Verify your email</h2>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4A4844;">
          Thanks for signing up. Tap the button below to confirm your email address and unlock full access to OraQL_.
        </p>
        <a href="${verifyUrl}" style="display:inline-block;padding:12px 32px;background:#C4962C;color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">
          Verify Email
        </a>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#8A8680;">
          This link expires in 24 hours. If you didn't create an account, you can safely ignore this email.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:24px 32px 32px;">
        <p style="margin:0;font-size:12px;color:#B0ACA6;">
          If the button doesn't work, copy and paste this link into your browser:<br>
          <a href="${verifyUrl}" style="color:#C4962C;word-break:break-all;">${verifyUrl}</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }

  private passwordResetTemplate(resetUrl: string): string {
    return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:#F7F5F0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;margin:40px auto;background:#fff;border-radius:12px;border:1px solid #E8E4DC;">
    <tr>
      <td style="padding:40px 32px 24px;">
        <h1 style="margin:0 0 8px;font-size:22px;font-weight:600;color:#1A1917;">OraQL_</h1>
        <p style="margin:0;font-size:13px;color:#8A8680;letter-spacing:0.5px;">SPORTS INTELLIGENCE</p>
      </td>
    </tr>
    <tr>
      <td style="padding:0 32px;">
        <div style="border-top:1px solid #E8E4DC;"></div>
      </td>
    </tr>
    <tr>
      <td style="padding:32px;">
        <h2 style="margin:0 0 16px;font-size:18px;font-weight:500;color:#1A1917;">Reset your password</h2>
        <p style="margin:0 0 24px;font-size:15px;line-height:1.6;color:#4A4844;">
          We received a request to reset your password. Tap the button below to choose a new one.
        </p>
        <a href="${resetUrl}" style="display:inline-block;padding:12px 32px;background:#C4962C;color:#fff;font-size:14px;font-weight:600;text-decoration:none;border-radius:8px;">
          Reset Password
        </a>
        <p style="margin:24px 0 0;font-size:13px;line-height:1.5;color:#8A8680;">
          This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email — your password won't change.
        </p>
      </td>
    </tr>
    <tr>
      <td style="padding:24px 32px 32px;">
        <p style="margin:0;font-size:12px;color:#B0ACA6;">
          If the button doesn't work, copy and paste this link into your browser:<br>
          <a href="${resetUrl}" style="color:#C4962C;word-break:break-all;">${resetUrl}</a>
        </p>
      </td>
    </tr>
  </table>
</body>
</html>`;
  }
}
