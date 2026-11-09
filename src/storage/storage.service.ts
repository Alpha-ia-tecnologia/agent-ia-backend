import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Minio from 'minio';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private client: Minio.Client;
  readonly bucket: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('MINIO_BUCKET') ?? 'aao-files';
    this.client = new Minio.Client({
      endPoint: this.config.get<string>('MINIO_ENDPOINT') ?? 'localhost',
      port: parseInt(this.config.get<string>('MINIO_PORT') ?? '9000', 10),
      useSSL: this.config.get<string>('MINIO_USE_SSL') === 'true',
      accessKey: this.config.get<string>('MINIO_ACCESS_KEY') ?? '',
      secretKey: this.config.get<string>('MINIO_SECRET_KEY') ?? '',
    });
  }

  async onModuleInit() {
    try {
      const exists = await this.client.bucketExists(this.bucket);
      if (!exists) {
        await this.client.makeBucket(this.bucket);
        this.logger.log(`Bucket "${this.bucket}" criado`);
      }
    } catch (err) {
      this.logger.warn(
        `MinIO indisponível no bootstrap: ${(err as Error).message}`,
      );
    }
  }

  async upload(objectName: string, buffer: Buffer, contentType?: string) {
    await this.client.putObject(
      this.bucket,
      objectName,
      buffer,
      buffer.length,
      {
        'Content-Type': contentType ?? 'application/octet-stream',
      },
    );
    return { bucket: this.bucket, objectName };
  }

  async remove(objectName: string) {
    await this.client.removeObject(this.bucket, objectName);
  }

  /** Abre um stream de leitura do objeto (usado p/ servir a gravação). */
  async getStream(objectName: string): Promise<NodeJS.ReadableStream> {
    return this.client.getObject(this.bucket, objectName);
  }

  /** Baixa um objeto inteiro para memória (usado p/ ler transcrições do bot). */
  async download(objectName: string): Promise<Buffer> {
    const stream = await this.client.getObject(this.bucket, objectName);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(chunk as Buffer);
    }
    return Buffer.concat(chunks);
  }
}
