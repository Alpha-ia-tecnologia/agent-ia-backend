# Plano de Implementação: Bot de Reuniões por Link (aao-scribe)

> Status: em desenvolvimento. Substitui o plano anterior (integração nativa via
> Microsoft Graph). Este documento é a referência viva.

## Objetivo

O usuário cola o **link de uma reunião** (Teams ou Google Meet). Um bot
(`aao-scribe`) entra na reunião, **grava o áudio**, transcreve com STT próprio
(com diarização), destaca os pontos importantes e dispara o agente do canal para
gerar as entregas pós-reunião (resumo, ata, action items, planilha, etc.), no
mesmo padrão dos canais existentes (inbox + tools de agente).

## Decisões fechadas com o usuário (jul/2026)

1. **Captura:** gravar áudio real + **STT próprio**. Habilita gravação real e
   destaques de qualquer idioma. **STT local (whisper.cpp), sem serviço de
   terceiros** (decisão revisada): roda offline na própria infra, custo só de
   CPU/armazenamento. O falante vem do alinhamento com as legendas raspadas
   (não há diarização por voz). Deepgram fica como alternativa opt-in.
2. **Plataformas:** **Teams + Google Meet** (reaproveita o bot Meet já pronto no
   Hermes). Zoom fica fora por ora.
3. **Graph nativo:** **removido**. O gatilho passa a ser o link; some o
   OAuth/admin-consent, webhook e subscriptions do Graph.
4. **Infra do bot:** **worker dedicado em container** (`aao-scribe`): Chromium
   headful + display virtual (Xvfb) + áudio (PulseAudio) + ffmpeg, orquestrado
   por fila (BullMQ/Redis). Escala por réplicas.

## O que é reaproveitado

- **Pipeline de processamento inteiro** (`teams-processing.service.ts` →
  renomeado `meeting-processing.service.ts`): reunião vira `Conversation` no
  inbox e o agente do canal gera as entregas com as tools existentes
  (`relatorio_pdf`, `exportar_dataset`, charts). **Não muda.**
- **Abstração `CaptureProvider`** (`capture-provider.interface.ts`): feita
  exatamente para trocar a fonte da transcrição. `BotCaptureProvider` substitui
  `GraphCaptureProvider` sem tocar no resto.
- **Fila durável** (BullMQ/Redis) e **StorageService (MinIO)** já existentes.
- **Bot Playwright do Hermes** (`hermes-agent/plugins/google_meet/`): join por
  URL, scraping de legendas via `MutationObserver`, detecção de lobby/admissão/
  negação, ciclo de vida do subprocesso. ~70% portável para o `aao-scribe`.

## Arquitetura alvo

```
Usuário cola link (+ agendamento opcional)
  → POST /meetings → MeetingSession (PENDING) → fila "meeting-bot" (BullMQ/Redis)
      → aao-scribe (worker container):
          Xvfb + PulseAudio + Chromium headful (Playwright)
          1. join Teams/Meet por URL (lobby/admissão)
          2. grava áudio da aba → sink Pulse → ffmpeg → .opus
          3. (paralelo) scraping de legendas p/ preview ao vivo
          4. ao sair: upload da gravação p/ MinIO
          5. STT + diarização → transcript (formato "Falante: fala")
      → BotCaptureProvider → MeetingProcessingService (JÁ EXISTE)
          → Conversation no inbox → agente do canal → entregas + highlights
```

## Modelo de dados (Prisma)

- **Feito (Fase 1, aditivo):** modelo `MeetingSession` + migration
  `20260713190417_add_meeting_session` (aplicada). Campos: `platform`,
  `joinUrl`, `scheduledAt`, `status` (PENDING|JOINING|LOBBY|RECORDING|LEFT|
  TRANSCRIBING|PROCESSING|DONE|FAILED), `botWorkerId`, `recordingKey`,
  `transcriptKey`, `durationSec`, `highlights` (JSON), `conversationId`, `error`.
- **Fase 3:** remover `TeamsConnection` e `TeamsMeeting` (legado Graph) numa
  migration própria, junto com a remoção do código TS.

## Serviço `aao-scribe/` (worker)

Node + TypeScript + Playwright (mesmo runtime do resto, BullMQ nativo).

- **Imagem:** base com `xvfb`, `pulseaudio`, `ffmpeg`, Chromium (Playwright),
  fontes. Escalável por réplicas; single-active por worker.
- **Loop:** consome a fila `meeting-bot`; atualiza `MeetingSession.status` e
  heartbeat direto no Postgres.
- **Join por plataforma:**
  - **Meet:** porte direto do `meet_bot.py` (`_is_safe_meet_url`,
    `_try_guest_name`, `_click_join`, `_detect_admission/_denied`).
  - **Teams (novo):** URLs `teams.microsoft.com/l/meetup-join/...` e
    `teams.live.com/meet/...`; entrar via web client ("Continue on this
    browser"), nome de convidado, "Join now", tratar lobby.
- **Gravação:** áudio da aba → sink Pulse → `ffmpeg` captura o monitor →
  `meeting.opus`. AV completo (via `getDisplayMedia`) fica opcional.
- **Legendas ao vivo:** `MutationObserver` (preview em tempo real na UI).

## STT + diarização + highlights

1. Upload da gravação → MinIO (`recordingKey`).
2. STT local **whisper.cpp** (padrão, sem terceiros): transcodifica o áudio
   (ffmpeg → WAV 16k) e roda o binário `whisper-cli` com um modelo GGML (baixado
   1x no build da imagem). Falante atribuído por alinhamento temporal com as
   legendas raspadas (`SpeakerHint`). Deepgram opt-in (`STT_PROVIDER=deepgram`).
3. Monta `CapturedTranscript.text` no formato `Falante: fala` (o `buildPrompt`
   existente não muda).
4. **Highlights** (decisões, action items, tópicos) com timestamp → salvos em
   `MeetingSession.highlights`, clicáveis para o instante da gravação.

## Mudanças no `aao-api`

**Remover (Fase 3, caminho Graph):** `teams-oauth.service.ts`, `graph.service.ts`,
`graph-capture.provider.ts`, `teams-subscription.service.ts`,
`teams-webhook.controller.ts`, campos Azure/Graph de `teams.config.ts`, rotas
`connect-url`/`callback`/`connection`, models `TeamsConnection`/`TeamsMeeting`.

**Manter/adaptar:**
- `capture-provider.interface.ts` — inalterado.
- **Novo** `bot-capture.provider.ts` (implementa `CaptureProvider`; lê o
  `transcriptKey` do MinIO ao fim do job do worker).
- `teams-processing.service.ts` → `meeting-processing.service.ts` (troca
  `TranscriptNotification` por `meetingSessionId`; corpo praticamente igual).
- `teams-queue.service.ts` → fila `meeting-bot` (API enfileira e escuta
  conclusão; o worker é outro processo).
- `teams.service.ts` — mantém CRUD de canal + deliveries (tipo lógico
  `MEETINGS`), perde a checagem de `TeamsConnection`.
- **Novo** `meetings.controller.ts`: `POST /meetings` (link + agendamento),
  `GET /meetings`, `GET /meetings/:id`, `DELETE /meetings/:id`. Guardado por
  `Roles(OWNER, ADMIN)`, `companyId` do usuário.
- **Agendamento:** cron `@nestjs/schedule` varre `scheduledAt <= now &&
  status=PENDING` e enfileira (substitui o cron de subscription do Graph).

## Frontend (`aao-web`)

- Remove o fluxo admin-consent/PowerShell do Teams em `SettingsPage.tsx`.
- **"Nova reunião":** link + toggle entrar agora/agendar, agente responsável,
  editor de entregas (reusa o existente).
- **Lista de reuniões:** status ao vivo (na fila / entrando / gravando /
  processando / pronto), preview de legenda, player da gravação, transcript,
  highlights clicáveis e entregas (tudo no inbox).

## Infra (`docker-compose.yml`)

- Novo serviço `aao-scribe` (imagem com Chromium/Xvfb/Pulse/ffmpeg), escalável.
- Redis e MinIO reutilizados. ~1 reunião por worker; dimensionar réplicas pela
  concorrência esperada.

## Consentimento e legal

- Bot entra com nome claro ("Assistente AAO (gravando)") e avisa no chat ao
  entrar. Config por empresa exige consentimento antes de gravar. Bot sai
  sozinho se removido/negado. Respeita a regra nunca-excluir dos artefatos.

## Ordem de entrega

1. **[FEITO]** Prisma: `MeetingSession` + migration aditiva.
2. **[SCAFFOLD]** `aao-scribe`: estrutura, fila, gravação Pulse/ffmpeg, upload
   MinIO, STT Deepgram, driver Meet portado. Falta validar join real.
3. **[FEITO]** Módulo `src/meetings/` no aao-api: `BotCaptureProvider`,
   `MeetingProcessingService`, `MeetingsQueueService` (produz `meeting-bot`,
   consome `meeting-process`), `POST /meetings` + CRUD, scheduler (setInterval).
   Módulo Graph (`src/teams/`) removido; models `TeamsConnection`/`TeamsMeeting`
   dropados (migration `20260713192450_remove_teams_graph`). Serviço `aao-scribe`
   no docker-compose raiz.
4. **[FEITO]** STT + diarização (aao-scribe/Deepgram) + **highlights
   estruturados com timestamp**: worker sobe transcrição carimbada
   ([HH:MM:SS]); `MeetingHighlightsService` (BYOK direto ou bridge, molde do
   ProjectAnalysisService) extrai decisões/ações/tópicos com `ts` em segundos e
   salva em `MeetingSession.highlights` (best-effort no processamento).
5. **[FEITO, a validar]** Join Teams no worker: driver reescrito e endurecido
   (dispensa cookies, força cliente web, silencia câmera/mic no pré-join,
   resiliente a iframe via `bot/dom.ts`, detecção de admissão/negação em pt/en).
   Helper `debug:join` para validar com reunião real. Seletores ainda precisam
   de confirmação contra uma reunião de verdade.
6. **[FEITO]** Frontend (`aao-web`): API migrada `/teams/*`→`/meetings/*`; seção
   "Reuniões (bot de gravação)" no SettingsPage (aba Canais) com config de
   agente+entregas, "Nova reunião" (link + entrar agora/agendar), lista com
   status ao vivo (polling só quando há reunião em andamento), player de áudio
   (`GET /meetings/:id/recording?token=`), highlights clicáveis que fazem seek no
   player, transcrição lazy e link para o inbox. Endpoints novos no aao-api:
   `GET /meetings/:id/recording` (stream) e `GET /meetings/:id/transcript`.
7. **[FEITO]** Consentimento + hardening + testes:
   - Consentimento: config por canal (`config.consent.announce/message` + `botName`),
     derivado no `enqueue` e postado no chat pelo bot após a admissão (drivers
     `announce`, best-effort; validar com reunião real). UI de consentimento no
     SettingsPage. Nome do bot deixa claro que está gravando.
   - Hardening: guard de concorrência por empresa (`MEETING_MAX_CONCURRENT`,
     ConflictException); tudo escopado por `companyId`; URL validada no servidor.
   - Testes (aao-api, 15 passam): `platform.spec` (detecção/rejeição de links),
     `meeting-highlights.parser.spec` (parse tolerante + ts), `meetings.service.spec`
     (link inválido, canal ausente, teto de concorrência, agendado não enfileira,
     imediato enfileira com botName/announce derivados).

> Pendências conhecidas para produção: validar seletores de join/announce contra
> reuniões reais (Teams e Meet) via `aao-scribe` `debug:join`; provisionar
> `DEEPGRAM_API_KEY`; teste de carga de concorrência real (fila + réplicas).

## Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Host não admite o bot (lobby) | Timeout de lobby + status LOBBY/FAILED na UI |
| Seletores do Teams/Meet mudam | Camada de detecção tolerante (ARIA + fallback), testes de fumaça |
| Custo/latência de STT | whisper.cpp local (sem terceiros); modelo base em CPU, subir p/ small/GPU se precisar de qualidade/velocidade |
| Concorrência (várias reuniões) | Fila + réplicas do worker; single-active por worker |
| Consentimento de gravação | Aviso no chat + config por empresa + nome do bot explícito |
