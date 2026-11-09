# Contas e organizações (recorte do workshop) — Plano de implementação

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** cada pessoa cria a própria conta e participa de uma ou mais organizações, entrando por convite (link, QR code ou código).

**Architecture:** `Membership` (usuário↔org com papel) vira a fonte da verdade. O JWT continua com `{companyId, role}`, agora = organização **ativa** + papel nela, então os ~144 pontos que usam `user.companyId` do JWT não mudam; só os 25 que consultam `prisma.user` por empresa/papel passam para `memberships`. Convites (`OrgInvite`) têm um código curto que vira link e QR.

**Tech Stack:** NestJS 11 + Prisma 6 (Postgres) em `atch-aao-api`; React + RTK Query + `qrcode.react` (já instalado) em `atch-aao-web`.

**Spec:** design aprovado no chat em 2026-11-06, transcrito abaixo.

> Dados: `Membership(userId, companyId, role OWNER|ADMIN|MEMBER, departmentId)`; `OrgInvite` com código de 8 caracteres sem ambíguos (ex.: `K7P2-9QXA`), validade e limite de usos opcionais, revogável; o mesmo código serve para link `<web>/join/<código>`, QR (aponta para o link) e digitação. A migração cria um vínculo por usuário existente com o papel de hoje; `User.companyId/role` ficam no banco mas não são mais lidos como vínculo (removidos depois do workshop). JWT `{companyId, role}` = org ativa + papel; login entra na última org usada; `POST /auth/switch-org` troca o token; sem org, só conta/convites/criar org. Cadastro: nome/e-mail/senha, depois "criar minha organização" (fluxo atual com onboarding) ou "tenho um código". Convites: dono e admins geram/listam/revogam; `/join/:código` mostra a org, sem conta faz cadastro e volta; aceitar = `MEMBER` e entra na org. Papéis: um dono por org; só o dono promove/rebaixa admin; remover tira o vínculo, não a conta; "adicionar funcionário" continua, vinculando à org. Web: seletor de organização no topo (lista, criar, entrar com código); tela Membros com painel de convite (link/QR/código) e modo apresentação (QR em tela cheia). Bridge não muda (tenant = org). Agentes pessoais: depois do workshop.

## Global Constraints

- Idioma do produto: PT-BR (mensagens de erro, textos de UI, comentários).
- Código do convite: 8 caracteres do alfabeto `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (sem `0 O 1 I`), exibido como `XXXX-XXXX`; a busca ignora hífen, espaços e caixa.
- Exatamente um `OWNER` por organização; nenhum endpoint muda papel para/de `OWNER`.
- Remover membro apaga só o `Membership`; a conta continua.
- Nenhuma migração destrutiva: `User.companyId`, `User.role`, `User.departmentId` permanecem (nullable).
- `User.companyId` passa a significar "última organização ativa" (usada no login).
- Rotas sem organização ativa permitidas: `auth/*`, `orgs` (listar/criar), `invites/*`. As demais respondem 403 `Entre em uma organização ou crie a sua.`
- Bridge, fork e scribe: sem mudanças.

## Review Focus

- Pessoa que já é membro abre o mesmo convite de novo → entra na org sem erro e sem duplicar vínculo.
- Convite revogado, vencido ou esgotado → 410 com mensagem clara; código inexistente → 404.
- Membro removido com token antigo ainda na mão → próximas chamadas daquela org dão 403 (vínculo checado ao trocar/usar org), não continuam funcionando até o JWT expirar.
- "Adicionar funcionário" com e-mail de conta que já existe → vincula a conta à org (não dá "e-mail já cadastrado").
- Usuário novo, sem org, abre `/office` → vai para a tela de boas-vindas (criar org / entrar com código), não quebra em telas que dependem de `companyId`.

---

### Task 1: Esquema e migração (Membership, OrgInvite)

**Files:**
- Modify: `prisma/schema.prisma` (models `User`, `Company`, `Department`; novos `Membership`, `OrgInvite`)
- Create: `prisma/migrations/20261106230000_memberships_invites/migration.sql`

**Interfaces:**
- Produces: `Membership { id, userId, companyId, role: UserRole, departmentId?: string, createdAt }` com `@@unique([userId, companyId])`, `@@index([companyId])`; relações `User.memberships`, `Company.memberships`, `Department.memberships`.
- Produces: `OrgInvite { id, companyId, code @unique, createdById, expiresAt?, maxUses?, uses Int @default(0), revokedAt?, createdAt }`, `@@index([companyId])`.
- `User.companyId String?`, `User.role UserRole?` (legado), `User.departmentId` mantido.

- [ ] **Step 1:** editar o schema e gerar a migração com `npx prisma migrate dev --create-only --name memberships_invites` contra um Postgres local (`docker run -d --name aao-pg-test -e POSTGRES_PASSWORD=aao -p 55432:5432 postgres:16`).
- [ ] **Step 2:** acrescentar ao SQL gerado o backfill: `INSERT INTO "Membership"(id,"userId","companyId",role,"departmentId","createdAt") SELECT 'm_'||id, id, "companyId", COALESCE(role,'MEMBER'), "departmentId", "createdAt" FROM "User" WHERE "companyId" IS NOT NULL;` (depois do `CREATE TABLE`, antes dos `ALTER ... DROP NOT NULL`).
- [ ] **Step 3:** aplicar num banco com dados (migrations atuais + 1 empresa com 2 usuários via `psql`) e conferir `SELECT count(*) FROM "Membership"` = nº de usuários. Expected: 2.
- [ ] **Step 4:** `npx prisma generate && npx tsc --noEmit` — Expected: erros de tipo apenas onde `User.companyId/role` viraram opcionais (resolvidos nas Tasks 2–5).

### Task 2: Autenticação com organização ativa

**Files:**
- Modify: `src/auth/auth.service.ts`, `src/auth/auth.controller.ts`, `src/auth/dto/auth.dto.ts`, `src/auth/jwt.strategy.ts`, `src/auth/decorators/current-user.decorator.ts`
- Create: `src/auth/decorators/no-org.decorator.ts`, `src/auth/guards/org.guard.ts` (registrado em `app.module.ts` depois do `RolesGuard`)
- Create: `src/orgs/orgs.module.ts`, `src/orgs/orgs.controller.ts`, `src/orgs/orgs.service.ts`
- Test: `src/auth/auth.service.spec.ts`, `src/auth/guards/org.guard.spec.ts`

**Interfaces:**
- `JwtPayload/AuthUser { sub|userId, companyId: string | null, role: UserRole | null, email }`.
- `AuthService.buildAuthResponse(userId, membership | null)` → `{ token, user: { id, email, name, role, companyId, companyName, onboardingStatus }, orgs: OrgSummary[] }`, `OrgSummary = { id, name, role, onboardingStatus }`.
- `AuthService.login(dto)`: escolhe a membership de `User.companyId` (última ativa) se ainda existir, senão a mais antiga; sem nenhuma → token com `companyId: null`.
- `AuthService.signup(dto)`: `companyName` opcional; com ele cria `Company` + `Membership(OWNER)` (fluxo atual); sem ele só o `User`.
- `AuthService.switchOrg(userId, companyId)` → mesmo formato de resposta; 403 se não for membro; grava `User.companyId`.
- `OrgsService.listMine(userId): OrgSummary[]`; `OrgsService.create(userId, dto: { name, businessDescription?, industry? })` → cria org + OWNER e devolve `switchOrg`.
- Rotas: `POST /auth/switch-org {companyId}`, `GET /orgs`, `POST /orgs` — todas `@NoOrg()`; `auth/login|signup|me` também `@NoOrg()`.
- `OrgGuard`: rota sem `@NoOrg()`/`@Public()` e `user.companyId` nulo → 403 com a mensagem da Global Constraint; também confere que a membership ainda existe (cache de 30 s por `userId:companyId` em memória) — senão 403 `Você não faz mais parte desta organização.`
- `deleteAccount`: para cada membership OWNER apaga a `Company` (comportamento atual); depois apaga o `User`.

- [ ] **Step 1:** testes (falhando): login escolhe a última org; login sem membership devolve `companyId: null`; `switchOrg` para org alheia → `ForbiddenException`; signup sem `companyName` não cria empresa; `OrgGuard` bloqueia sem org e libera `@NoOrg()`; `OrgGuard` bloqueia membership removida.
- [ ] **Step 2:** implementar; `npx jest src/auth` → PASS.
- [ ] **Step 3:** commit `feat(auth): organização ativa no JWT, troca de org e conta sem org`.

### Task 3: Convites (link, QR, código)

**Files:**
- Create: `src/invites/invites.module.ts`, `src/invites/invites.controller.ts`, `src/invites/invites.service.ts`, `src/invites/invite-code.ts`
- Test: `src/invites/invite-code.spec.ts`, `src/invites/invites.service.spec.ts`

**Interfaces:**
- `generateInviteCode(): string` (8 chars do alfabeto da constraint, `crypto.randomInt`); `normalizeInviteCode(input: string): string` (maiúsculas, remove não-alfanuméricos); `formatInviteCode(code): string` → `XXXX-XXXX`.
- `InvitesService.create(companyId, createdById, { expiresInHours?: number, maxUses?: number })` → `{ id, code, expiresAt, maxUses, uses }` (OWNER/ADMIN).
- `InvitesService.list(companyId)`, `InvitesService.revoke(companyId, id)` (OWNER/ADMIN).
- `InvitesService.preview(code)` → `{ companyName, code }` — `@Public()`; 404 inexistente; 410 revogado/vencido/esgotado.
- `InvitesService.accept(code, userId)` → `AuthService.switchOrg(userId, companyId)`; cria `Membership(MEMBER)` se não existir (idempotente, sem consumir uso de novo); incrementa `uses` na mesma transação, com `uses < maxUses` no `WHERE` (corrida de dois aceites no último uso).
- Rotas: `POST/GET /org/invites`, `DELETE /org/invites/:id` (`@Roles(OWNER, ADMIN)`); `GET /invites/:code` (`@Public()`); `POST /invites/:code/accept` (`@NoOrg()`).

- [ ] **Step 1:** testes: código tem 8 chars do alfabeto; `normalize('k7p2 9qxa')` = `'K7P29QXA'`; aceitar 2x não duplica vínculo nem uso; revogado → 410; vencido → 410; `maxUses: 1` com dois aceites → o segundo 410.
- [ ] **Step 2:** implementar; `npx jest src/invites` → PASS.
- [ ] **Step 3:** commit `feat(invites): convites por link, QR e código`.

### Task 4: Membros e papéis

**Files:**
- Modify: `src/users/users.service.ts`, `src/users/users.controller.ts`
- Test: `src/users/users.service.spec.ts`

**Interfaces:**
- `findAll(companyId)` → lista de `{ id, email, name, role, createdAt, departmentId, department }` a partir de `Membership` (mesmo formato de hoje: a web não muda o tipo `User`).
- `invite(companyId, name, email, role?)`: e-mail existente → cria só o `Membership` (409 se já membro) e devolve `{ ..., temporaryPassword: null }`; novo → cria `User` + `Membership` como hoje.
- `update(companyId, actor: AuthUser, id, { name?, role?, departmentId? })`: `role` só se `actor.role === OWNER`; `role` nunca `OWNER` e nunca no próprio dono → 403; `name` só do próprio usuário ou por OWNER/ADMIN; `departmentId` grava no `Membership`.
- `remove(companyId, id)`: apaga o `Membership`; dono → 400 `O dono não pode ser removido da organização.`

- [ ] **Step 1:** testes: admin tenta promover → 403; dono promove membro a ADMIN → ok; ninguém vira OWNER; remover apaga vínculo e mantém `User`; convidar e-mail existente vincula.
- [ ] **Step 2:** implementar; `npx jest src/users` → PASS.
- [ ] **Step 3:** commit `feat(users): membros por organização e papéis com dono único`.

### Task 5: Consultas restantes por organização

**Files:**
- Modify: `src/agents/agents.service.ts:150`, `src/channels/whatsapp.service.ts:113`, `src/channels/telegram.service.ts:155`, `src/channels/email.service.ts:290`, `src/meetings/meeting-processing.service.ts:122`, `src/company/internal-company.controller.ts:54`, `src/company/internal-admin.controller.ts:133` (e o `create` de usuário em `:56-80`), `src/conversations/conversations.service.ts:317,526`, `src/projects/internal-projects.controller.ts:219`, `src/projects/tasks.service.ts:242`, `src/onboarding/onboarding.service.ts:247-265`

**Interfaces:**
- Filtro de pertencimento: `where: { memberships: { some: { companyId } } }`.
- Dono da org: `prisma.membership.findFirst({ where: { companyId, role: OWNER }, include: { user: true } })`.
- Papel de alguém numa org: `prisma.membership.findUnique({ where: { userId_companyId: { userId, companyId } } })`.

- [ ] **Step 1:** trocar cada ponto; `npx tsc --noEmit` → 0 erros; `npx jest` → todos PASS; `npx eslint "{src,apps,libs,test}/**/*.ts"` → 0.
- [ ] **Step 2:** commit `refactor: consultas de usuários por vínculo com a organização`.

### Task 6: Web — conta, organização ativa e convites

**Files:**
- Modify: `atch-aao-web/src/types/index.ts`, `src/api/api.ts`, `src/store/authSlice.ts`, `src/App.tsx`, `src/pages/auth/SignupPage.tsx`, `src/pages/office/OfficeLayout.tsx`, `src/pages/office/OrganizationPage.tsx` (aba de membros, ~linha 520)
- Create: `src/pages/WelcomePage.tsx` (sem org: criar / entrar com código), `src/pages/JoinPage.tsx` (`/join/:code`), `src/components/OrgSwitcher.tsx`, `src/components/InvitePanel.tsx` (link, QR, código, modo apresentação)

**Interfaces:**
- `AuthResponse` ganha `orgs: OrgSummary[]`; `authSlice` guarda `orgs`; `user.companyId` pode ser `null`.
- RTK: `switchOrg`, `getMyOrgs`, `createOrg`, `getInvites`, `createInvite`, `revokeInvite`, `previewInvite`, `acceptInvite`; após `switchOrg/createOrg/acceptInvite`: `setCredentials` + `api.util.resetApiState()` (cache da org anterior não pode vazar).
- Rotas: `/welcome` e `/join/:code` (logado ou não; sem login guarda o código em `sessionStorage('aao.pendingInvite')` e volta depois do login/cadastro). Guard: logado sem `companyId` → `/welcome`.
- Modo apresentação: QR do link em tela cheia + código grande + nome da org; `Esc` fecha.

- [ ] **Step 1:** implementar; `npm run build` → ok; `npx oxlint` → sem warnings novos.
- [ ] **Step 2:** commit `feat(web): organizações, convites com QR e seletor de organização`.

### Task 7: Verificação de ponta a ponta (local)

- [ ] **Step 1:** subir a api local (Postgres do Task 1, `REDIS_URL` vazio) e rodar um script que: cadastra A com `companyName` (dono), A cria convite, B se cadastra sem org (recebe `companyId: null`; `GET /agents` → 403), B aceita o código (entra como MEMBER; `GET /agents` → 200), B aceita de novo (sem duplicar), A promove B a ADMIN, B tenta rebaixar A → 403, A remove B → B com token antigo leva 403 em `GET /agents`, B cria a própria org e troca entre as duas.
- [ ] **Step 2:** builds e testes de api e web limpos; resumo para o usuário.
