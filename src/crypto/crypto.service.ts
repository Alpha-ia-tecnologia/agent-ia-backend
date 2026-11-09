import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

export interface EncryptedPayload {
  encrypted: string;
  iv: string;
  authTag: string;
}

@Injectable()
export class CryptoService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const hex = config.getOrThrow<string>('MASTER_ENCRYPTION_KEY');
    this.key = Buffer.from(hex, 'hex');
    if (this.key.length !== 32) {
      throw new Error(
        'MASTER_ENCRYPTION_KEY deve ter 32 bytes em hex (64 chars)',
      );
    }
  }

  encrypt(plaintext: string): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    return {
      encrypted: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: cipher.getAuthTag().toString('base64'),
    };
  }

  decrypt(payload: EncryptedPayload): string {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      this.key,
      Buffer.from(payload.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(payload.authTag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(payload.encrypted, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  }
}
