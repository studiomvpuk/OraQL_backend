import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private s3Client: S3Client;
  private readonly bucket: string;
  private readonly region: string;

  constructor() {
    this.region = process.env.CLOUDFLARE_R2_REGION || 'auto';
    this.bucket = process.env.CLOUDFLARE_R2_BUCKET || '';

    if (!this.bucket) {
      throw new Error('CLOUDFLARE_R2_BUCKET environment variable is required');
    }

    this.s3Client = new S3Client({
      region: this.region,
      credentials: {
        accessKeyId: process.env.CLOUDFLARE_R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY || '',
      },
      endpoint: process.env.CLOUDFLARE_R2_ENDPOINT || '',
    });

    this.validateConfig();
  }

  private validateConfig(): void {
    const requiredVars = [
      'CLOUDFLARE_R2_BUCKET',
      'CLOUDFLARE_R2_ACCESS_KEY_ID',
      'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
      'CLOUDFLARE_R2_ENDPOINT',
    ];

    const missing = requiredVars.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      this.logger.warn(
        `Missing R2 configuration: ${missing.join(', ')}. Storage operations may fail.`,
      );
    }
  }

  async upload(key: string, body: Buffer | string, contentType: string) {
    if (!key || key.length === 0) {
      throw new BadRequestException('Key cannot be empty');
    }

    const bufferBody = typeof body === 'string' ? Buffer.from(body) : body;

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: bufferBody,
        ContentType: contentType,
      });

      await this.s3Client.send(command);
      this.logger.log(`Successfully uploaded file to R2: ${key}`);

      return {
        key,
        size: bufferBody.length,
        contentType,
        uploadedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Failed to upload file to R2: ${key}`, error);
      throw new BadRequestException(`Failed to upload file: ${error.message}`);
    }
  }

  async download(key: string) {
    if (!key || key.length === 0) {
      throw new BadRequestException('Key cannot be empty');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.s3Client.send(command);
      const body = await response.Body?.transformToByteArray();

      this.logger.log(`Successfully downloaded file from R2: ${key}`);

      return {
        data: Buffer.from(body || []),
        contentType: response.ContentType,
        size: response.ContentLength,
      };
    } catch (error) {
      this.logger.error(`Failed to download file from R2: ${key}`, error);
      throw new BadRequestException(`Failed to download file: ${error.message}`);
    }
  }

  async delete(key: string) {
    if (!key || key.length === 0) {
      throw new BadRequestException('Key cannot be empty');
    }

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.s3Client.send(command);
      this.logger.log(`Successfully deleted file from R2: ${key}`);

      return {
        key,
        deletedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.logger.error(`Failed to delete file from R2: ${key}`, error);
      throw new BadRequestException(`Failed to delete file: ${error.message}`);
    }
  }

  async getSignedUrl(key: string, expiresIn = 3600) {
    if (!key || key.length === 0) {
      throw new BadRequestException('Key cannot be empty');
    }

    if (expiresIn < 60 || expiresIn > 604800) {
      throw new BadRequestException(
        'Expiration time must be between 60 and 604800 seconds',
      );
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const signedUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn,
      });

      this.logger.log(`Generated signed URL for R2 object: ${key}`);

      return {
        url: signedUrl,
        key,
        expiresIn,
        expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      };
    } catch (error) {
      this.logger.error(
        `Failed to generate signed URL for R2 object: ${key}`,
        error,
      );
      throw new BadRequestException(
        `Failed to generate signed URL: ${error.message}`,
      );
    }
  }
}
