import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.setGlobalPrefix('api');
  // túnel dos conectores locais (path /connector, fora do prefixo /api)
  app.useWebSocketAdapter(new WsAdapter(app));
  // CORS_ORIGIN aceita uma lista separada por vírgula (ex.: dev + domínio
  // deployado). "*" libera qualquer origem. Reflete a origem que casar — sem
  // isso, a web deployada bate numa origem diferente da default e o browser
  // bloqueia por falta do header Access-Control-Allow-Origin.
  const corsOrigins = (process.env.CORS_ORIGIN ?? 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.includes('*') ? true : corsOrigins,
    credentials: true,
  });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
