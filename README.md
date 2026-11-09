# aao-api

API do **Alpha Agents Office** — backend NestJS + Prisma (PostgreSQL/pgvector).

Responsável por: autenticação e RBAC multi-tenant, agentes e setores, conversas
(SSE), base de conhecimento (RAG híbrido), dados estruturados (datasets),
projetos/kanban, canais (Telegram, e-mail, WhatsApp via bridge Baileys),
conector local (túnel WS), assinaturas de provider, auditoria e consumo de tokens.

## Rodando

```bash
npm install
cp .env.example .env   # preencha as variáveis
npx prisma migrate deploy
npm run start:dev      # http://localhost:3000/api
```

Requer PostgreSQL com extensão `vector` e um storage S3-compatível (MinIO).
O serviço conversa com o `aao-hermes-bridge` (orquestração dos agentes) via
`BRIDGE_URL`/`BRIDGE_API_KEY` e compartilha filesystem com ele
(`BRIDGE_SHARED_DATA_DIR`).
