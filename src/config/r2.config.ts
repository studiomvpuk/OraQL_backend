import { registerAs } from '@nestjs/config';

export const r2Config = registerAs('r2', () => ({
  accountId: process.env.R2_ACCOUNT_ID,
  accessKeyId: process.env.R2_ACCESS_KEY_ID,
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  bucketName: process.env.R2_BUCKET_NAME || 'oracle-assets',
  publicUrl: process.env.R2_PUBLIC_URL,
}));
