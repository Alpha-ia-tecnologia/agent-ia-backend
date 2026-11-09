# Backlog — Alpha Agents Office

Itens planejados e adiados. Ordem dentro de cada bloco = prioridade sugerida.

## Motor de agentes (LangGraph + Hermes)

O Hermes roda um processo por empresa (~170–200 MB cada) e não escala além de
algumas dezenas de empresas ativas numa VPS de 11,7 GB. A proposta é um runtime
multiempresa em LangGraph, mantendo o Hermes só para o que exige ele.

### Fase 1 — motor LangGraph para o chat principal
- Runtime multiempresa em um processo, estado no Postgres (`PostgresSaver`).
- Ferramentas HTTP diretas (sem processo MCP), provedores por chave (OpenAI,
  Anthropic, Google, DeepSeek, OpenRouter, custom).
- Mesmo contrato NDJSON (`BridgeEvent`) — api e web quase não mudam.
- Flag por empresa (`engine: langgraph | hermes`) para migrar aos poucos.
- Hermes continua para assinaturas OAuth e modos com terminal.
- Começar por um documento de design aprovado antes de codar.

### Fase 2 — paridade com o Hermes
- Delegação entre agentes (supervisor/subgrafos).
- Skills e aprendizado no Postgres (ideias do langstage-hermes: skills sob
  demanda, revisão pós-turno, snapshot de memória fixo).
- Visão/arquivos e resumo de contexto longo.

### Fase 3 — resiliência e escala
- Turnos numa fila do Redis (BullMQ) e eventos por Redis Streams: api e runtime
  reiniciam sem perder turnos; api com várias réplicas (hoje o SSE é em memória).
- Métricas: fila, turnos ativos, tempo até o 1º token, 429 do provedor.

## Infra e operação
- Token do fork como *build secret* do Docker no bridge (hoje é `ARG` e aparece
  no log do build e no histórico da imagem).
- `UV_THREADPOOL_SIZE` na api para login em massa (bcrypt usa o pool de 4 threads).
- Rodar `scripts/loadtest.mjs` contra a VPS com uma chave de LLM real para medir
  o teto do chat (o teste de 2026-11-06 não mediu o chat: o provedor da empresa
  estava quebrado).

## Reuniões (aao-scribe)
- Validar a qualidade do `large-v3-turbo-q5_0` com áudio real em português.
- Validar entrada em reunião real de Meet/Teams e o login hospedado pelo
  domínio público (WebSocket).

## Contas e organizações (depois do recorte do workshop)
- **Agentes pessoais**: espaço pessoal de cada conta (como no GitHub), com
  agentes próprios e a chave/assinatura do próprio usuário; conversa da org
  podendo misturar agentes da org e pessoais.
- Remover as colunas legadas `User.role` e `User.departmentId` (e renomear
  `User.companyId` para `lastCompanyId`) depois de estabilizar.
- Cache de papéis do `OrgGuard` no Redis se a api tiver réplicas.
- Pendências menores da revisão final (2026-11-06):
  - admin escolhendo "Admin" no modal de adicionar vira Membro sem aviso;
  - admin de uma org altera o nome global da conta da pessoa;
  - membro removido fica no /office com 403 até trocar de org ou relogar;
  - papel exibido na web vem do token salvo (defasa após promoção);
  - "adicionar por e-mail" com conta existente: invalidar o cache de papel e
    tratar clique duplo (P2002 → 409);
  - `POST /orgs` aceita nome só com espaços;
  - testes de integração (`orgs.integration.spec.ts`) só rodam com
    `TEST_DATABASE_URL` — rodar num CI com Postgres.
