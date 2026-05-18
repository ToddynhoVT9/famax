{
"name": "your-app",
"dependencies": {
"next": "^14.0.0",
"react": "^18.0.0",

<div class="node-database-code-snippet__highlighted-text">"@supabase/supabase-js": "^2.0.0"</div>
}
}

---

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
process.env.SUPABASE_URL,
process.env.SUPABASE_ANON_KEY
);

// Test the connection
supabase
.from('your_table')
.select('\*')
.limit(1)
.then(({ data, error }) => {
if (error) console.error('Connection error:', error);
else console.log('Connected:', data);
});

module.exports = supabase;

# FAMAX — Migrando para Supabase (Guia para Iniciantes)

Guia completo, do zero, para migrar seu backend (que hoje usa MySQL no Railway) para **PostgreSQL no Supabase** — que é o que o Hostinger Node.js Web App aceita nativamente.

> **Tempo estimado:** 30–45 minutos.
> **Pré-requisitos:** o backend que você já tem (Express + TypeScript) e o `famax_schema.postgres.sql` que acompanha este guia.

---

## Sumário

1. [Criar projeto no Supabase](#1-criar-projeto-no-supabase)
2. [Rodar o schema](#2-rodar-o-schema)
3. [Pegar a connection string](#3-pegar-a-connection-string)
4. [Atualizar o backend (mysql2 → pg)](#4-atualizar-o-backend-mysql2--pg)
5. [Testar localmente](#5-testar-localmente)
6. [Subir para o Hostinger](#6-subir-para-o-hostinger)
7. [Próximos passos](#7-próximos-passos)

---

## 1. Criar projeto no Supabase

### 1.1. Criar conta

1. Vá em **https://supabase.com**
2. Clique em **Start your project** (ou **Sign up**)
3. Faça login com **GitHub** (recomendado — mais rápido) ou email/senha
4. Aceite os termos

### 1.2. Criar uma organização e um projeto

Depois do login, você vai cair no dashboard. Se for sua primeira vez:

1. Clique em **New project** (ou **Create a new project**)
2. Vai pedir pra escolher/criar uma **organização**. Pode usar o nome que quiser (ex: `famax-org`). Plano: **Free**.
3. Preencha o formulário do projeto:
   - **Name:** `famax` (ou o nome que preferir)
   - **Database Password:** **gere uma senha forte e SALVE EM ALGUM LUGAR**. Você vai precisar dela na próxima seção. Pode usar o botão **Generate a password** que o Supabase oferece — ele cria uma forte automaticamente.
   - **Region:** escolha a mais próxima de você. Para Brasil, **South America (São Paulo)** é a melhor opção. Se não tiver, **US East** funciona bem.
4. Clique em **Create new project**

### 1.3. Esperar o provisionamento

O Supabase leva ~2 minutos para provisionar tudo (banco, API, dashboard). Você vai ver uma barra de progresso. **Não feche a aba.**

Quando terminar, você verá o dashboard com o nome do projeto no topo. Pronto para o próximo passo.

> **Pegadinha do Free Tier:** projetos no plano gratuito **pausam após 7 dias sem nenhuma requisição**. Não é problema durante o desenvolvimento (basta clicar em "Restore" pra despausar), mas tenha em mente.

---

## 2. Rodar o schema

Agora vamos criar as 17 tabelas do FAMAX.

### 2.1. Abrir o SQL Editor

No dashboard do Supabase (com seu projeto aberto):

1. Na barra lateral esquerda, clique no ícone do **SQL Editor** (parece `</>` ou um terminal)
2. Você verá um editor vazio com botões **Run** no canto

### 2.2. Colar e executar o schema

1. Abra o arquivo **`famax_schema.postgres.sql`** no seu editor de texto
2. Copie **todo o conteúdo** (Ctrl+A, Ctrl+C)
3. Cole no SQL Editor do Supabase
4. Clique em **Run** (botão verde no canto inferior direito) ou aperte **Ctrl+Enter**

Você deve ver uma mensagem **"Success. No rows returned"**. Se aparecer algum erro, copia o erro aqui que eu te ajudo a debugar.

### 2.3. Verificar

Para confirmar que tudo subiu:

1. Na barra lateral, clique no **Table Editor** (ícone de tabela)
2. Você deve ver as **17 tabelas** listadas na coluna esquerda: `users`, `user_profiles`, `user_settings`, ..., `terms_acceptance`

Ou, ainda no SQL Editor, rode:

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public'
ORDER BY table_name;
```

Você verá as 17 tabelas.

---

## 3. Pegar a connection string

Esta é a "URL do banco" que o backend vai usar para conectar — equivalente à URL do Railway que você usava antes.

### 3.1. Onde encontrar

No dashboard do Supabase:

1. No topo da página, procure o botão **Connect** (geralmente no header, ou em **Settings** → **Database**)
2. Uma janela vai abrir com várias opções de conexão. As principais:
   - **Direct connection** — porta 5432, mais simples
   - **Transaction pooler** — porta 6543, para serverless
   - **Session pooler** — porta 5432, para servidores tradicionais
3. **Use a opção "Session pooler"**. Razões:
   - Suporta IPv4 nativamente (a Direct connection só funciona com IPv6 ou requer add-on pago)
   - Funciona perfeitamente com servidores Express
   - Suporta prepared statements (que o driver `pg` usa)
4. Copie a string que aparece. Ela tem este formato:

```
postgresql://postgres.abcdefghijklmnop:[YOUR-PASSWORD]@aws-0-sa-east-1.pooler.supabase.com:5432/postgres
```

5. **Substitua `[YOUR-PASSWORD]`** pela senha que você gerou na seção 1.2.

> Se você esqueceu a senha, vá em **Settings → Database → Database Password** e clique em **Reset database password**. Você terá que atualizar onde quer que ela esteja usada (config.ts, painel da Hostinger, etc.).

### 3.2. Anote essa URL completa

Você vai usar ela em dois lugares:

1. No **`config.ts`** local (para desenvolvimento)
2. Como **variável de ambiente** no painel da Hostinger (para produção/deploy)

---

## 4. Atualizar o backend (mysql2 → pg)

O driver MySQL e o driver PostgreSQL têm APIs **parecidas mas não idênticas**. Vamos atualizar os 5 arquivos: `package.json`, `config.ts`, `db.ts`, `auth.routes.ts`, `posts.routes.ts`.

### 4.1. Trocar as dependências

Na pasta `backend/`:

```bash
npm uninstall mysql2
npm install pg
npm install -D @types/pg
```

### 4.2. Atualizar `src/config.ts`

Substitua o conteúdo inteiro por:

```typescript
/**
 * Configuração central da aplicação (MVP).
 *
 * ⚠️ MODO MVP DE TESTE
 * Credenciais hardcoded. Quando for para produção:
 *   1. Substitua os valores por `process.env.X`.
 *   2. Configure as env vars no painel da Hostinger.
 */

export const config = {
  PORT: 3000,
  NODE_ENV: "development" as "development" | "production",

  // Supabase Postgres — connection string completa (Session pooler)
  // Cole aqui a URL que você copiou na seção 3, com a senha real no lugar de [YOUR-PASSWORD]
  DATABASE_URL:
    "postgresql://postgres.abcdefghijklmnop:SUA_SENHA_AQUI@aws-0-sa-east-1.pooler.supabase.com:5432/postgres",

  JWT_SECRET: "famax-mvp-secret-trocar-em-producao-pelo-menos-32-caracteres-ok",
  JWT_EXPIRES_IN: "7d" as const,

  CORS_ORIGIN: "http://localhost:5173",
};
```

### 4.3. Atualizar `src/db.ts`

Substitua o conteúdo inteiro por:

```typescript
import pg from "pg";
import { config } from "./config.js";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 10, // pool size
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,

  // SSL obrigatório no Supabase
  ssl: { rejectUnauthorized: false },
});

// Testa a conexão no boot
export async function pingDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("SELECT 1");
    console.log("✅ Postgres (Supabase) conectado");
  } finally {
    client.release();
  }
}
```

### 4.4. Atualizar `src/routes/auth.routes.ts`

Aqui estão as mudanças mais importantes — leia o quadro de equivalências antes:

| MySQL (mysql2)                           | PostgreSQL (pg)                           |
| ---------------------------------------- | ----------------------------------------- |
| `pool.execute(sql, params)`              | `pool.query(sql, params)`                 |
| Placeholders `?`                         | Placeholders `$1, $2, $3, ...`            |
| `const [rows] = await pool.execute(...)` | `const { rows } = await pool.query(...)`  |
| `pool.getConnection()`                   | `pool.connect()`                          |
| `connection.beginTransaction()`          | `client.query('BEGIN')`                   |
| `connection.commit()`                    | `client.query('COMMIT')`                  |
| `connection.rollback()`                  | `client.query('ROLLBACK')`                |
| `DATE_ADD(NOW(), INTERVAL 7 DAY)`        | `NOW() + INTERVAL '7 days'`               |
| `INSERT ... VALUES ... (sem RETURNING)`  | mesmo, mas Postgres permite `RETURNING *` |

Conteúdo novo completo do arquivo:

```typescript
import { Router } from "express";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { pool } from "../db.js";
import { config } from "../config.js";

const router = Router();

// ===========================================================================
// POST /api/auth/register
// ===========================================================================

const registerSchema = z.object({
  email: z.string().email("Email inválido"),
  username: z
    .string()
    .min(3, "Username deve ter no mínimo 3 caracteres")
    .max(50)
    .regex(/^[a-zA-Z0-9_]+$/, "Username só pode conter letras, números e _"),
  password: z
    .string()
    .min(8, "Senha deve ter no mínimo 8 caracteres")
    .refine(
      (pwd) => (pwd.match(/\d/g) ?? []).length >= 3,
      "Senha precisa de pelo menos 3 números",
    )
    .refine(
      (pwd) => /[^A-Za-z0-9]/.test(pwd),
      "Senha precisa de pelo menos 1 caractere especial",
    ),
  displayName: z.string().min(1, "Display name obrigatório"),
  termsAccepted: z.literal(true, {
    errorMap: () => ({ message: "Você precisa aceitar os termos" }),
  }),
  termsVersion: z.string().default("2026-03"),
});

router.post("/register", async (req, res, next) => {
  try {
    const data = registerSchema.parse(req.body);

    // Verificar duplicata
    const { rows: existing } = await pool.query(
      "SELECT user_id FROM users WHERE email = $1 OR username = $2 LIMIT 1",
      [data.email, data.username],
    );
    if (existing.length > 0) {
      return res.status(409).json({ error: "Email ou username já cadastrado" });
    }

    const passwordHash = await bcrypt.hash(data.password, 12);

    const userId = randomUUID();
    const profileId = randomUUID();
    const settingsId = randomUUID();
    const acceptanceId = randomUUID();

    // Transação — todas inserções ou nenhuma
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO users
         (user_id, email, username, password_hash, terms_accepted)
         VALUES ($1, $2, $3, $4, TRUE)`,
        [userId, data.email, data.username, passwordHash],
      );

      await client.query(
        `INSERT INTO user_profiles
         (profile_id, user_id, display_name)
         VALUES ($1, $2, $3)`,
        [profileId, userId, data.displayName],
      );

      await client.query(
        `INSERT INTO user_settings
         (settings_id, user_id, is_private)
         VALUES ($1, $2, TRUE)`,
        [settingsId, userId],
      );

      await client.query(
        `INSERT INTO terms_acceptance
         (acceptance_id, user_id, terms_version, ip_address)
         VALUES ($1, $2, $3, $4)`,
        [acceptanceId, userId, data.termsVersion, req.ip ?? null],
      );

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }

    const token = jwt.sign({ sub: userId }, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN,
    });

    return res.status(201).json({
      token,
      user: {
        userId,
        email: data.email,
        username: data.username,
        displayName: data.displayName,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Dados inválidos", details: err.flatten() });
    }
    next(err);
  }
});

// ===========================================================================
// POST /api/auth/login
// ===========================================================================

const loginSchema = z.object({
  identifier: z.string().min(1, "Email ou username obrigatório"),
  password: z.string().min(1, "Senha obrigatória"),
});

router.post("/login", async (req, res, next) => {
  try {
    const { identifier, password } = loginSchema.parse(req.body);

    const { rows } = await pool.query(
      `SELECT u.user_id, u.email, u.username, u.password_hash, p.display_name
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.user_id
       WHERE (u.email = $1 OR u.username = $1)
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [identifier],
    );

    const user = rows[0];

    // Comparação constante de tempo (evita timing attack)
    const fakeHash =
      "$2b$12$invalidinvalidinvalidinvalidinvalidinvalidinvalidi";
    const passwordOk = user
      ? await bcrypt.compare(password, user.password_hash)
      : (await bcrypt.compare(password, fakeHash), false);

    if (!user || !passwordOk) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const token = jwt.sign({ sub: user.user_id }, config.JWT_SECRET, {
      expiresIn: config.JWT_EXPIRES_IN,
    });

    await pool.query(
      `INSERT INTO user_sessions (session_id, user_id, token, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '7 days')`,
      [
        randomUUID(),
        user.user_id,
        token,
        req.ip ?? null,
        req.get("user-agent") ?? null,
      ],
    );

    return res.json({
      token,
      user: {
        userId: user.user_id,
        email: user.email,
        username: user.username,
        displayName: user.display_name,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Dados inválidos", details: err.flatten() });
    }
    next(err);
  }
});

export default router;
```

### 4.5. Atualizar `src/routes/posts.routes.ts`

```typescript
import { Router } from "express";
import { z } from "zod";
import { pool } from "../db.js";

const router = Router();

const listPostsParams = z.object({
  communityId: z.string().uuid("ID de comunidade inválido"),
});

const listPostsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

router.get("/communities/:communityId/posts", async (req, res, next) => {
  try {
    const { communityId } = listPostsParams.parse(req.params);
    const { page, limit } = listPostsQuery.parse(req.query);
    const offset = (page - 1) * limit;

    const { rows } = await pool.query(
      `SELECT
         p.post_id,
         p.title,
         p.content,
         p.likes_count,
         p.comments_count,
         p.created_at,
         u.user_id           AS author_id,
         u.username          AS author_username,
         up.display_name     AS author_display_name,
         up.avatar_url       AS author_avatar_url,
         cc.name             AS category_name,
         cc.slug             AS category_slug
       FROM posts p
       INNER JOIN users u           ON u.user_id  = p.author_id
       LEFT  JOIN user_profiles up  ON up.user_id = p.author_id
       LEFT  JOIN community_categories cc
             ON cc.community_category_id = p.community_category_id
       WHERE p.community_id = $1
         AND p.deleted_at IS NULL
       ORDER BY p.created_at DESC
       LIMIT $2 OFFSET $3`,
      [communityId, limit, offset],
    );

    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*)::int AS total
       FROM posts
       WHERE community_id = $1 AND deleted_at IS NULL`,
      [communityId],
    );
    const total = countRows[0].total;

    res.json({
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return res
        .status(400)
        .json({ error: "Parâmetros inválidos", details: err.flatten() });
    }
    next(err);
  }
});

export default router;
```

> **`COUNT(*)::int`** — no Postgres, `COUNT(*)` retorna `bigint`, que vira string no driver. O `::int` força conversão para integer, evitando a necessidade de `Number(countRows[0].total)`.

### 4.6. Middleware (sem mudanças)

`src/middleware/auth.ts` e `src/middleware/error.ts` **não precisam mudar** — eles não tocam no banco. Pode deixar como está.

### 4.7. `src/server.ts` (sem mudanças)

Também não precisa mudar. O `pingDatabase()` continua sendo chamado e a mensagem agora vai dizer "Postgres (Supabase) conectado".

---

## 5. Testar localmente

Antes de subir pra Hostinger, valida que está tudo certo:

```bash
cd backend
npm run dev
```

Você deve ver:

```
✅ Postgres (Supabase) conectado
🚀 API rodando em http://localhost:3000
```

Testa o healthcheck:

```bash
curl http://localhost:3000/api/health
```

Testa o cadastro (em outro terminal):

```bash
curl -X POST http://localhost:3000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "email": "teste@famax.com",
    "username": "teste_user",
    "password": "senha123!@#",
    "displayName": "Usuário Teste",
    "termsAccepted": true
  }'
```

Deve voltar um JSON com `token` e `user`.

E pra confirmar que o registro chegou no Supabase, no dashboard:

1. **Table Editor** → tabela `users`
2. Você deve ver a linha que acabou de ser criada

---

## 6. Subir para o Hostinger

Agora a parte do deploy. O Hostinger Node.js Web App injeta variáveis de ambiente para você — então no servidor, em vez de hardcodar a URL no `config.ts`, vamos ler de `process.env.DATABASE_URL`.

### 6.1. Adicionar suporte a env vars no `config.ts`

Atualize o `config.ts` para ler de `process.env` **caso esteja em produção**, e usar o hardcoded como fallback local:

```typescript
export const config = {
  PORT: Number(process.env.PORT ?? 3000),
  NODE_ENV: (process.env.NODE_ENV ?? "development") as
    | "development"
    | "production",

  DATABASE_URL:
    process.env.DATABASE_URL ??
    "postgresql://postgres.abcdefghijklmnop:SUA_SENHA_AQUI@aws-0-sa-east-1.pooler.supabase.com:5432/postgres",

  JWT_SECRET:
    process.env.JWT_SECRET ??
    "famax-mvp-secret-trocar-em-producao-pelo-menos-32-caracteres-ok",
  JWT_EXPIRES_IN: (process.env.JWT_EXPIRES_IN ?? "7d") as `${number}d`,

  CORS_ORIGIN: process.env.CORS_ORIGIN ?? "http://localhost:5173",
};
```

> Assim, **localmente** ele continua usando o hardcoded. Na **Hostinger**, ele lê das env vars (sobrescreve).

### 6.2. Configurar a env var no painel da Hostinger

No painel do Hostinger Node.js Web App:

1. Acesse seu site → **Settings** ou **Environment**
2. Procure a seção **Environment Variables** (ou "Variáveis de ambiente")
3. Adicione as seguintes variáveis:

   | Nome           | Valor                                                                      |
   | -------------- | -------------------------------------------------------------------------- |
   | `DATABASE_URL` | a connection string completa do Supabase (Session pooler, com senha real)  |
   | `JWT_SECRET`   | uma string longa e aleatória — pode usar `openssl rand -base64 48`         |
   | `CORS_ORIGIN`  | a URL do seu frontend deployado (ex: `https://seu-site.hostingersite.com`) |
   | `NODE_ENV`     | `production`                                                               |

4. Salve

### 6.3. Redeploy

Para que as novas env vars sejam aplicadas, o app precisa rebuildar:

- Se você deploya via Git: faz um commit + push (ou clica em "Redeploy" no painel)
- Se deploya manualmente: reupload do código

Depois do redeploy, acessa a URL pública do seu app e bate em `/api/health` — deve responder normalmente.

---

## 7. Próximos passos

### 7.1. Limpe o config.ts antes de comitar (importante)

Se você for subir o repositório no GitHub, **antes**:

- Substitua a connection string hardcoded por um placeholder genérico (ex: `"postgresql://..."`)
- Apague o JWT_SECRET hardcoded e deixe só `process.env.JWT_SECRET ?? ""`
- Adicione um `config.example.ts` placeholder no repo
- Não precisa mais `gitignore` do config.ts se você seguiu esse padrão (só env vars têm valores reais)

### 7.2. Recursos do Supabase que valem explorar

Como você já está nele:

- **Storage** (1 GB grátis): para os avatares e covers que o FAMAX tem nas colunas `avatar_url`, `banner_url`, `cover_image_url`. Veja **Storage** na sidebar.
- **Logs**: aba **Logs** → mostra todas as queries que o backend roda. Útil pra debugar quando uma rota volta erro 500.
- **Realtime**: você pode receber pushes em tempo real quando alguém insere/atualiza uma linha. Útil pra "novo post chegou na comunidade" sem precisar de polling.
- **Auth**: se algum dia você quiser parar de gerenciar senhas/JWT manualmente, o Auth integrado faz signup/login/recovery/OAuth de graça. Aí você apaga as tabelas `password_recovery` e `user_sessions` e a coluna `password_hash`, e a tabela `users` vira só perfil.

### 7.3. Quando virar produção mesmo

- **Faça backup** — o Free Tier não tem backup automático. Use `pg_dump` semanal ou um GitHub Action.
- **Monitora a aba "Usage"** — alerta antes de bater 500 MB de banco ou 10 GB de bandwidth.
- Quando passar de uns 40K usuários ativos por mês ou perto de bater os limites, sobe pro Pro ($25/mês).

---

## Resumo executivo

1. Cria projeto no Supabase, salva a senha do banco.
2. Roda o `famax_schema.postgres.sql` no SQL Editor.
3. Copia a connection string (Session pooler) e cola no `config.ts`.
4. Troca `mysql2` por `pg` e atualiza os 4 arquivos: `config.ts`, `db.ts`, `auth.routes.ts`, `posts.routes.ts`.
5. Testa local com `npm run dev` e `curl`.
6. Sobe pra Hostinger configurando `DATABASE_URL` como env var no painel.

Qualquer travada (erro de conexão SSL, "relation does not exist", "syntax error at or near"), cola o erro aqui que eu te ajudo a destravar.
