# aao-api — NestJS + Prisma + bridge de WhatsApp (Node)
FROM node:22-slim AS build
# git: o Baileys (bridge de WhatsApp) é dependência via GitHub; e o lockfile
# usa ssh:// — reescreve para https (containers não têm chave SSH)
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && git config --global url."https://github.com/".insteadOf ssh://git@github.com/
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npx prisma generate && npm run build
# deps do bridge Baileys (subprocess de WhatsApp)
RUN cd whatsapp-bridge && npm ci --omit=dev

FROM node:22-slim
# openssl: exigido pelo Prisma em imagens slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/whatsapp-bridge ./whatsapp-bridge
COPY package*.json ./

# sessões de WhatsApp e dados de runtime (montar volume em /app/data)
RUN mkdir -p /app/data

EXPOSE 3000
# migrations no boot: idempotente e garante schema em dia
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main"]
