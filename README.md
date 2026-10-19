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
| `MIGRATE_ON_BOOT` | não | `false` desliga a aplicação de migrations no boot (padrão: ligado) |
| `TRUST_PROXY` | não | Proxies confiáveis à frente da API (`1`, `true`, `loopback`...). Padrão: nenhum |
| `DATABASE_SSL` | não | `false` desliga o SSL (Postgres local) |
| `SUPABASE_URL` | não | Project URL — necessária para upload de capa |
| `SUPABASE_SERVICE_KEY` | não | Chave `service_role` — necessária para upload de capa |
| `SUPABASE_COVERS_BUCKET` | não | Bucket das capas (padrão `community-covers`) |

### Rate limit e proxy

Login e cadastro têm rate limit em memória: login 10 tentativas falhas / 15 min
por IP e 5 / 15 min por email ou username; cadastro 5 / hora por IP. Acima disso
a API responde 429 com `Retry-After`.

O limite por IP depende do `req.ip` ser o IP real do cliente. Atrás de um proxy
reverso (o caso da hospedagem), defina `TRUST_PROXY` — normalmente `1`, o número
de proxies à frente. Sem isso todos os usuários aparecem com o IP do proxy e
dividem o mesmo limite. Rodando sem proxy, deixe vazio: confiar no
`X-Forwarded-For` deixaria qualquer cliente forjar o próprio IP.

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

**O servidor aplica as migrations pendentes sozinho ao subir** (modo
`external`), antes de liberar a API — o deploy não depende de alguém lembrar
de rodar o comando. Se uma falhar, a API fica em 503 com o motivo no log. O
baseline nunca é aplicado no boot; banco vazio continua sendo
`npm run migrate -- --baseline`. Desligue com `MIGRATE_ON_BOOT=false`.

O runner registra o que já rodou em `schema_migrations`, então rodar de novo é
seguro. Migrations aplicadas cujo arquivo mudou depois aparecem com aviso.

> **`007_sessions.sql` desloga todo mundo uma vez.** A partir dela todo token
> precisa de uma sessão ativa em `user_sessions` (identificada pelo `jti`), e as
> sessões antigas não têm `jti` — são revogadas. Cada usuário entra de novo uma
> vez após o deploy.

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
npm run migrate      # opcional: o boot já aplica as pendentes
npm start            # node dist/server.js
```

O `dist/` não é versionado — o build roda no servidor após o `git pull`.

## Estrutura

```
client/            frontend (HTML + CSS + TS, sem framework)
  html/            páginas (entries do Vite, ver vite.config.ts)
  css/
  script/
    shared/        api, pages, auth-guard, dom, sidebar, chat-widget
server/            API Express
  routes/          auth, me, communities, posts, comments, reactions, chat, users
  middleware/      auth, membership, error
  lib/             session, storage (Supabase Storage), rate-limit
  sql/             migrations + baseline/
scripts/           migrate.mjs
test/              integration.mjs
```
