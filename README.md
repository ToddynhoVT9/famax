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
| `CORS_ORIGIN` | não | Origens de fora liberadas no CORS, separadas por vírgula. Padrão: nenhuma (front e API têm a mesma origem) |
| `MIGRATE_ON_BOOT` | não | `false` desliga a aplicação de migrations no boot (padrão: ligado) |
| `MAIL_PROVIDER` | não | `console` (padrão: só log), `resend` ou `smtp` |
| `MAIL_FROM` | com resend/smtp | Remetente dos e-mails |
| `RESEND_API_KEY` | com resend | Chave da API do Resend |
| `SMTP_URL` | com smtp | `smtps://usuario:senha@host:465` |
| `TRUST_PROXY` | não | Proxies confiáveis à frente da API (`1`, `true`, `loopback`...). Padrão: nenhum |
| `DATABASE_SSL` | não | `false` desliga o SSL (Postgres local) |
| `DATABASE_CA` | em produção | Certificado (PEM) da CA do banco: com ele o certificado do servidor é verificado. Ver "Banco com TLS" |
| `DATABASE_CA_FILE` | não | Caminho do arquivo da CA, no lugar de `DATABASE_CA` |
| `CSP_REPORT_ONLY` | não | `false` faz a CSP bloquear de verdade. Padrão: `true` (só observa e registra) |
| `SUPABASE_URL` | não | Project URL — necessária para upload de capa |
| `SUPABASE_SERVICE_KEY` | não | Chave `service_role` — necessária para upload de capa |
| `SUPABASE_COVERS_BUCKET` | não | Bucket das capas (padrão `community-covers`) |
| `APP_URL` | em produção | Endereço público do site, para os links dos e-mails (verificação de e-mail) |
| `TWO_FACTOR_KEY` | para 2FA | 32 bytes em hex — cifra os segredos da verificação em duas etapas. Sem ela a 2FA fica indisponível |
| `REALTIME_BUS` | não | `postgres` (LISTEN/NOTIFY, várias instâncias) ou `memory` (uma instância). Padrão: `postgres` no external, `memory` no embedded |
| `REALTIME_DATABASE_URL` | não | Conexão de sessão para o LISTEN, se a `DATABASE_URL` for o pooler em modo transação |

### Rate limit e proxy

Login e cadastro têm rate limit em memória: login 10 tentativas falhas / 15 min
por IP e 5 / 15 min por email ou username; cadastro 5 / hora por IP. Acima disso
a API responde 429 com `Retry-After`.

O limite por IP depende do `req.ip` ser o IP real do cliente. Atrás de um proxy
reverso (o caso da hospedagem), defina `TRUST_PROXY` — normalmente `1`, o número
de proxies à frente. Sem isso todos os usuários aparecem com o IP do proxy e
dividem o mesmo limite. Rodando sem proxy, deixe vazio: confiar no
`X-Forwarded-For` deixaria qualquer cliente forjar o próprio IP.

### E-mail

A recuperação de senha envia um código de 6 dígitos por e-mail. Com
`MAIL_PROVIDER=console` (o padrão) o e-mail só aparece no log do servidor —
bom para desenvolver, mas **em produção ninguém recebe o código**: configure
`resend` ou `smtp`. Um provedor sem as variáveis que exige impede o servidor de
subir, para o erro aparecer no deploy e não quando alguém esquecer a senha.

Sem `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` o upload de capa é desativado: a
comunidade é criada sem imagem e o resto do fluxo continua funcionando.

O cadastro também manda um link de verificação de e-mail (vale 24 h). O link
usa `APP_URL`; sem ela, o host da requisição. Sem e-mail verificado a conta
navega, publica e comenta, mas não cria comunidade nem manda mensagem no chat.

### Conta e segurança

- **Verificação em duas etapas (TOTP):** exige `TWO_FACTOR_KEY`. O segredo de
  cada pessoa fica cifrado com ela no banco — guarde a chave junto com os
  outros segredos e não a troque depois que alguém ativar a 2FA.
- **Excluir conta:** o perfil é anonimizado na hora e a pessoa tem 30 dias
  para reativar entrando com a senha. Um job (no boot e a cada 6 h) faz a
  exclusão definitiva depois do prazo: troca e-mail e username, apaga
  vínculos e imagens. Posts, comentários e mensagens ficam como "Usuário
  removido". Durante os 30 dias o e-mail e o username continuam reservados.

### Banco com TLS

A conexão com o Supabase é sempre cifrada. Para o servidor também **verificar o
certificado** do banco (e não aceitar um intermediário na rede), configure a CA:

1. No Supabase: **Project Settings → Database → SSL Configuration → Download
   certificate**. Vem um arquivo `.crt` em PEM (começa com
   `-----BEGIN CERTIFICATE-----`).
2. No painel do Hostinger, nas variáveis de ambiente do app Node.js (onde já
   estão `DATABASE_URL` e `JWT_SECRET`), crie `DATABASE_CA` com o conteúdo do
   arquivo. Se o painel não aceitar várias linhas, use a versão numa linha só,
   com `\n` no lugar das quebras:

   ```bash
   node -e "console.log(require('fs').readFileSync('prod-ca-2021.crt','utf8').trim().replace(/\n/g,'\\n'))"
   ```

   Outra opção é subir o arquivo para uma pasta **fora** da pasta do app (o
   deploy substitui a pasta do app) e apontar `DATABASE_CA_FILE` para ele.
3. Reinicie o app. Se a CA estiver errada, o log mostra "Certificado do banco
   recusado" e a API fica em 503; remover a variável volta ao modo anterior.

Sem a CA em produção o servidor sobe normalmente, cifrado mas sem verificar, e
avisa no log. O `npm run migrate` usa as mesmas variáveis.

### Cabeçalhos de segurança, CSP e CORS

Toda resposta sai com os cabeçalhos do `helmet` (`server/lib/security-headers.ts`):
`X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`,
`X-Frame-Options: DENY` e, só com `NODE_ENV=production`, HSTS (180 dias).

A **CSP** só deixa rodar script do próprio site, mais o script de tema que
fica inline no `<head>` das páginas (liberado pelo hash, calculado na subida a
partir do HTML publicado). Estilo só de arquivo (nada de `style=""` nem
`<style>`; pelo JS, use `el.style.x = ...`). Imagens: o próprio site, `data:`,
`blob:` e a origem do `SUPABASE_URL`. Por enquanto ela está em
**report-only** (`CSP_REPORT_ONLY`, padrão `true`): nada é bloqueado, e cada
violação aparece no console do navegador e no log do servidor ("CSP
(report-only): ...", via `POST /api/csp-report`). Com o log limpo depois de um
tempo no ar, defina `CSP_REPORT_ONLY=false` para ela passar a bloquear.

**CORS:** front e API têm a mesma origem, então por padrão não há CORS (outro
site não lê a API pelo navegador). `CORS_ORIGIN` libera origens específicas.

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
