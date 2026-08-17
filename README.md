# FAMAX

Backend Express + frontend Vite (MPA) num único projeto Node.js. O Express
serve a API em `/api` e o frontend compilado a partir de `dist/public`.

## Requisitos

- Node.js 20+
- npm
- Um banco Postgres (o projeto usa Supabase)

## Configuração

As credenciais vêm de variáveis de ambiente — **não há valor padrão** para
`DATABASE_URL` e `JWT_SECRET`, e o servidor recusa subir sem elas.

```bash
cp .env.example .env
# preencha DATABASE_URL e JWT_SECRET
```

Gerar um `JWT_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

> O `.env` é ignorado pelo git. Em produção, use as variáveis de ambiente do
> painel de hospedagem — o arquivo não é publicado no repositório.

### Variáveis

| Variável | Obrigatória | Descrição |
| --- | --- | --- |
| `DATABASE_URL` | sim | Connection string do Postgres |
| `JWT_SECRET` | sim | Segredo de assinatura dos tokens (32+ caracteres) |
| `PORT` | não | Porta da API (padrão `3000`) |
| `NODE_ENV` | não | `development` \| `production` |
| `JWT_EXPIRES_IN` | não | Validade do token (padrão `7d`) |
| `CORS_ORIGIN` | não | Origem liberada no CORS |
| `DATABASE_SSL` | não | `false` desliga o SSL (Postgres local) |
| `SUPABASE_URL` | não | Project URL — necessária para upload de capa |
| `SUPABASE_SERVICE_KEY` | não | Chave `service_role` — necessária para upload de capa |
| `SUPABASE_COVERS_BUCKET` | não | Bucket das capas (padrão `community-covers`) |

Sem `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` o upload de capa é desativado: a
comunidade é criada sem imagem e o resto do fluxo continua funcionando.

## Banco de dados

O schema base está em `server/sql/baseline/DB.psql` (17 tabelas). As alterações
posteriores são migrations numeradas em `server/sql/`.

```bash
npm run migrate -- --status     # o que está pendente
npm run migrate                 # aplica o pendente
npm run migrate -- --baseline   # aplica o schema base antes (banco vazio)
```

O runner registra o que já rodou em `schema_migrations`, então rodar de novo é
seguro. Migrations aplicadas cujo arquivo mudou depois aparecem com aviso.

## Desenvolvimento

```bash
npm run dev
```

Sobe o backend (`tsx watch`, porta 3000) e o Vite (porta 5173) em paralelo. O
Vite faz proxy de `/api` para o backend.

## Testes

```bash
npm test
```

Sobe um Postgres em processo (PGlite), aplica o schema base + todas as
migrations e exercita os endpoints dos três sistemas por HTTP. Não toca no
banco de produção.

## Build e produção

```bash
npm ci
npm run build        # vite build -> dist/public ; tsc -> dist/
npm run migrate      # aplica migrations pendentes
npm start            # node dist/server.js
```

O `dist/` não é versionado — o build roda no servidor após o `git pull`.

## Estrutura

```
client/            frontend (HTML + CSS + TS, sem framework)
  html/            páginas (entries do Vite, ver vite.config.ts)
  css/
  script/
    shared/        api, dom, sidebar, chat-widget
server/            API Express
  routes/          auth, communities, posts, comments, reactions, chat, users
  middleware/      auth, membership, error
  lib/             storage (Supabase Storage), rate-limit
  sql/             migrations + baseline/
scripts/           migrate.mjs
test/              integration.mjs
```
