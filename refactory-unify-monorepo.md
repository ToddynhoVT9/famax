# FAMAX — Refactor: Unificar Frontend + Backend num Único Deploy

Guia para transformar o monorepo atual (com `package.json` separados) em um **único projeto Node.js** onde o Express serve tanto a API quanto os arquivos estáticos do frontend Vite. Resultado: **um único repo, um único deploy, um único site na Hostinger**.

> **Tempo estimado:** 45-60 minutos.
> **Pré-requisito:** seu backend já está com `pg` (não `mysql2`) e funcionando localmente conectando no Supabase.

---

## Sumário

1. [Antes de começar — backup](#1-antes-de-começar--backup)
2. [Visão geral do refactor](#2-visão-geral-do-refactor)
3. [Etapa 1 — Reorganizar pastas](#3-etapa-1--reorganizar-pastas)
4. [Etapa 2 — Criar configs unificados na raiz](#4-etapa-2--criar-configs-unificados-na-raiz)
5. [Etapa 3 — Atualizar o `server.ts` pra servir o frontend](#5-etapa-3--atualizar-o-serverts-pra-servir-o-frontend)
6. [Etapa 4 — Atualizar o `api.ts` do frontend](#6-etapa-4--atualizar-o-apits-do-frontend)
7. [Etapa 5 — Limpeza e `.gitignore`](#7-etapa-5--limpeza-e-gitignore)
8. [Etapa 6 — Instalar dependências e testar local](#8-etapa-6--instalar-dependências-e-testar-local)
9. [Etapa 7 — Commit e push](#9-etapa-7--commit-e-push)
10. [Etapa 8 — Reconfigurar a Hostinger](#10-etapa-8--reconfigurar-a-hostinger)
11. [Etapa 9 — Verificação final](#11-etapa-9--verificação-final)
12. [Troubleshooting](#12-troubleshooting)

---

## 1. Antes de começar — backup

**Faz backup antes de mexer.** Esse refactor mexe em arquivos críticos.

```powershell
cd D:\6_code-theu\3-projects
Copy-Item -Recurse famax famax-backup-$(Get-Date -Format "yyyyMMdd")
```

Cria uma branch nova pra trabalhar:

```powershell
cd famax
git checkout -b refactor/unify-monorepo
```

Assim você pode voltar pra `main` instantaneamente se algo der muito errado.

---

## 2. Visão geral do refactor

### Estrutura antes

```
famax/                           ← raiz
├── package.json                 ← do frontend Vite
├── tsconfig.json
├── vite.config.ts
├── src/                         ← código do frontend
│   ├── index.html
│   ├── html/
│   ├── style/
│   └── script/
└── backend/                     ← projeto separado
    ├── package.json             ← do backend Express
    ├── tsconfig.json
    └── src/                     ← código do backend
        ├── server.ts
        ├── db.ts
        ├── config.ts
        ├── middleware/
        └── routes/
```

### Estrutura depois

```
famax/                           ← raiz
├── package.json                 ← UNIFICADO (frontend + backend)
├── tsconfig.json                ← configura compilação do server
├── tsconfig.client.json         ← validação TS do client (Vite usa)
├── vite.config.ts               ← aponta pra client/
├── server/                      ← código do backend (era backend/src/)
│   ├── server.ts                ← agora também serve o frontend buildado
│   ├── db.ts
│   ├── config.ts
│   ├── middleware/
│   └── routes/
├── client/                      ← código do frontend (era src/)
│   ├── index.html
│   ├── html/
│   ├── style/
│   └── script/
└── dist/                        ← gerado no build
    ├── server.js                ← backend compilado
    ├── db.js, config.js, ...
    └── public/                  ← frontend buildado (HTML/CSS/JS estático)
```

### O que muda no fluxo

**Em desenvolvimento (`npm run dev`):**

- Backend Express roda em `localhost:3000`
- Vite roda em `localhost:5173` com hot reload
- Vite proxia `/api/*` pro backend (mesma coisa de antes)

**Em produção (`npm start`):**

- Apenas Express roda em uma única porta
- Express serve `/api/*` (rotas da API) **e** todo o resto (arquivos estáticos do frontend buildado)
- Mesma origem → sem CORS, sem `VITE_API_URL`, sem complicação

---

## 3. Etapa 1 — Reorganizar pastas

### 3.1. Mover o frontend pra `client/`

Da raiz do repo, executa **um comando de cada vez** (cada um pode levar 1-2 segundos):

```powershell
# Cria a pasta client
mkdir client

# Move os arquivos do frontend pra dentro
git mv src/index.html client/index.html
git mv src/html client/html
git mv src/style client/style
git mv src/script client/script
```

Se você tem outras pastas dentro de `src/` (assets, public, etc.), move elas também:

```powershell
# Verifica o que ainda restou em src/
dir src
# Se aparecer algo (ex: src/assets), move:
git mv src/assets client/assets
```

Quando `src/` estiver vazia:

```powershell
Remove-Item src
```

### 3.2. Mover o backend pra `server/`

```powershell
# Move o código do backend
git mv backend/src server

# Verifica que server/ tem os arquivos esperados
dir server
# Deve mostrar: server.ts, db.ts, config.ts, middleware/, routes/
```

### 3.3. Deletar o que sobrou da pasta `backend/`

A pasta `backend/` agora tem apenas `package.json`, `tsconfig.json`, e provavelmente `node_modules/` e `dist/` antigos. Como vamos consolidar tudo na raiz, essa pasta inteira sai:

```powershell
# Sai do tracking do git
git rm -r backend
# Apaga o que restou (node_modules não rastreado)
Remove-Item -Recurse -Force backend
```

### 3.4. Confere a estrutura

```powershell
dir
```

Deve aparecer:

```
client/          ← novo
server/          ← novo
package.json     ← ainda do frontend Vite (vamos substituir)
tsconfig.json    ← ainda do frontend (vamos substituir)
vite.config.ts   ← ainda apontando pra src/ (vamos substituir)
README.md
node_modules/    ← do frontend (vamos refazer)
package-lock.json
.gitignore
.git/
```

Sem `src/`, sem `backend/`. Bom.

---

## 4. Etapa 2 — Criar configs unificados na raiz

Agora os 4 arquivos de configuração: `package.json`, `tsconfig.json`, `tsconfig.client.json`, `vite.config.ts`.

### 4.1. Substituir o `package.json` da raiz

**Sobrescreve totalmente** o `package.json` da raiz por isto:

```json
{
  "name": "famax",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "concurrently -n backend,frontend -c cyan,green \"npm run dev:backend\" \"npm run dev:frontend\"",
    "dev:backend": "tsx watch server/server.ts",
    "dev:frontend": "vite",
    "build": "npm run build:frontend && npm run build:backend",
    "build:frontend": "vite build",
    "build:backend": "tsc",
    "start": "node dist/server.js",
    "typecheck": "tsc --noEmit && tsc -p tsconfig.client.json --noEmit"
  },
  "dependencies": {
    "bcrypt": "^5.1.1",
    "cors": "^2.8.5",
    "express": "^4.21.2",
    "jsonwebtoken": "^9.0.2",
    "pg": "^8.13.1",
    "zod": "^3.24.1"
  },
  "devDependencies": {
    "@types/bcrypt": "^5.0.2",
    "@types/cors": "^2.8.17",
    "@types/express": "^5.0.0",
    "@types/jsonwebtoken": "^9.0.7",
    "@types/node": "^22.10.7",
    "@types/pg": "^8.11.10",
    "concurrently": "^9.2.1",
    "tsx": "^4.19.2",
    "typescript": "^5.9.3",
    "vite": "^7.1.10"
  }
}
```

**Notas importantes:**

- Removi `mysql2` (você migrou pra `pg`)
- Adicionei `pg` e `@types/pg`
- Adicionei `concurrently`, `vite`, e `tsx` (eram divididos antes)
- O script `start` aponta pra `dist/server.js` — é o que a Hostinger vai usar

### 4.2. Substituir o `tsconfig.json` da raiz

**Sobrescreve totalmente** por:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "outDir": "dist",
    "rootDir": "server"
  },
  "include": ["server/**/*"]
}
```

Esse é o `tsconfig` usado pelo `tsc` quando você roda `npm run build:backend`. Ele compila apenas a pasta `server/` e gera `.js` em `dist/`.

### 4.3. Criar `tsconfig.client.json` (novo arquivo)

Cria um arquivo `tsconfig.client.json` na raiz com este conteúdo:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "types": ["vite/client"]
  },
  "include": ["client/**/*", "vite.config.ts"]
}
```

Esse é só pra validação de tipos do frontend — o Vite faz o build de verdade.

### 4.4. Substituir o `vite.config.ts`

**Sobrescreve totalmente** por:

```typescript
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const resolvePath = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: "client",
  server: {
    open: "/index.html",
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  plugins: [],
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolvePath("./client/index.html"),
        home: resolvePath("./client/html/home.html"),
        community: resolvePath("./client/html/community.html"),
        login: resolvePath("./client/html/user-pages/login.html"),
        register: resolvePath("./client/html/user-pages/register.html"),
        recoverPassword: resolvePath(
          "./client/html/user-pages/recover-password.html",
        ),
        profileView: resolvePath("./client/html/user-pages/profile-view.html"),
        profileSettings: resolvePath(
          "./client/html/user-pages/profile-settings.html",
        ),
        terms: resolvePath("./client/html/legal/terms.html"),
      },
    },
  },
});
```

**Mudanças em relação ao anterior:**

- `root: "src"` → `root: "client"`
- `outDir: "../dist"` → `outDir: "../dist/public"` (frontend buildado vai pra `dist/public/` pra não conflitar com o `server.js` do backend)
- Todos os paths de entrada apontam pra `./client/...` em vez de `./src/...`

---

## 5. Etapa 3 — Atualizar o `server.ts` pra servir o frontend

O Express agora precisa servir os arquivos estáticos do frontend além das rotas da API.

### Substitui `server/server.ts` por:

```typescript
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { pingDatabase } from "./db.js";
import { errorHandler } from "./middleware/error.js";

import authRoutes from "./routes/auth.routes.js";
import postsRoutes from "./routes/posts.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Quando o servidor rodar (dist/server.js), o frontend buildado está em dist/public/
const publicDir = path.join(__dirname, "public");

const app = express();

// CORS — em dev (Vite em :5173 chama Express em :3000); em prod é same-origin
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// =========================
// API ROUTES (vêm primeiro!)
// =========================

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);
app.use("/api", postsRoutes);

// =========================
// FRONTEND ESTÁTICO
// =========================

app.use(express.static(publicDir));

// Fallback: rotas não encontradas
app.use((req, res) => {
  // Se for rota /api/*, devolve JSON 404
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Rota não encontrada" });
  }
  // Senão, devolve o index.html (comportamento amigável pra URLs inválidas)
  res.status(404).sendFile(path.join(publicDir, "index.html"));
});

app.use(errorHandler);

async function start() {
  await pingDatabase();
  app.listen(config.PORT, () => {
    console.log(
      `🚀 FAMAX (API + Frontend) rodando em http://localhost:${config.PORT}`,
    );
  });
}

start().catch((err) => {
  console.error("Erro ao iniciar servidor:", err);
  process.exit(1);
});
```

**O que mudou:**

| Antes                      | Depois                                                                           |
| -------------------------- | -------------------------------------------------------------------------------- |
| Só servia `/api/*`         | Serve `/api/*` E todos arquivos estáticos do frontend                            |
| `cors` com origin restrito | `cors` com `origin: true` (reflete qualquer origem — seguro em prod same-origin) |
| 404 sempre JSON            | 404 JSON pra API, `index.html` pras outras rotas                                 |

**Pontos críticos da ordem:**

1. Rotas `/api/*` declaradas **antes** do `express.static` — senão o static interceptaria
2. `express.static(publicDir)` serve qualquer arquivo encontrado em `dist/public/`
3. O fallback final cobre URLs que não bateram em nada

### Por que CORS ainda existe se é same-origin?

Em dev, o Vite roda em `:5173` e o Express em `:3000`. Mesmo com o proxy do Vite (que evita CORS no fluxo principal), `origin: true` mantém o navegador feliz. Em prod, tudo na mesma porta — o CORS não atrapalha.

---

## 6. Etapa 4 — Atualizar o `api.ts` do frontend

Como agora é tudo same-origin em prod, o frontend pode fazer chamadas relativas (`/api/...`) que funcionam tanto em dev (via proxy do Vite) quanto em prod (direto no Express).

### Edita `client/script/shared/api.ts`

Procura a linha que usa `VITE_API_URL` e simplifica pra sempre usar `/api`:

```typescript
// No topo do arquivo, garante que tem:
const API_BASE = "/api";

// E o fetch:
const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
```

Você pode até **deletar a variável** `API_BASE` e usar `/api` direto no fetch — mas manter a constante deixa mais legível.

> **Por que `/api` sem domínio?** O navegador resolve URLs relativas com base na URL atual. Se o site está em `https://famax.toddynhovt.com/login`, chamar `/api/auth/login` vira `https://famax.toddynhovt.com/api/auth/login` automaticamente. Em dev (`http://localhost:5173`), o Vite proxia pro `:3000`.

---

## 7. Etapa 5 — Limpeza e `.gitignore`

### 7.1. Atualizar `.gitignore` da raiz

Edita o `.gitignore` da raiz pra incluir:

```
node_modules/
dist/
.env

# Editor
.vscode/
.idea/

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
```

### 7.2. Apagar `node_modules/` e `package-lock.json` antigos

Como vamos refazer a instalação com o `package.json` unificado:

```powershell
Remove-Item -Recurse -Force node_modules
Remove-Item package-lock.json
```

### 7.3. Apagar pasta `dist/` antiga (se existir)

```powershell
Remove-Item -Recurse -Force dist
```

---

## 8. Etapa 6 — Instalar dependências e testar local

### 8.1. Instala tudo

```powershell
npm install
```

Vai demorar uns 30 segundos. Vai instalar Express + Vite + bcrypt + pg + tudo num único `node_modules/`.

### 8.2. Testa o backend em isolamento

Antes de testar tudo junto, valida que o backend ainda funciona:

```powershell
npm run dev:backend
```

Deve aparecer:

```
✅ Postgres (Supabase) conectado
🚀 FAMAX (API + Frontend) rodando em http://localhost:3000
```

Em outro terminal:

```powershell
curl.exe http://localhost:3000/api/health
```

Deve voltar `{"status":"ok",...}`. Mata o processo com `Ctrl+C`.

### 8.3. Testa dev integrado

```powershell
npm run dev
```

Deve subir os dois em paralelo, com prefixos coloridos `[backend]` e `[frontend]`. O Vite vai abrir o navegador em `http://localhost:5173`. Testa fazer login pela tela — deve funcionar normal (via proxy do Vite).

Mata com `Ctrl+C` (pode precisar apertar duas vezes pra fechar ambos os processos).

### 8.4. Testa o build

Aqui é o teste mais importante: simular o que vai acontecer na Hostinger.

```powershell
npm run build
```

Deve rodar dois passos:

1. `vite build` → gera `dist/public/index.html`, `dist/public/html/...`, `dist/public/assets/...`
2. `tsc` → gera `dist/server.js`, `dist/db.js`, `dist/routes/...`

Verifica que tudo está no lugar:

```powershell
dir dist
```

Deve aparecer:

```
public/         ← do vite
server.js       ← do tsc
db.js
config.js
middleware/
routes/
```

### 8.5. Roda em modo produção localmente

```powershell
npm start
```

Deve aparecer:

```
✅ Postgres (Supabase) conectado
🚀 FAMAX (API + Frontend) rodando em http://localhost:3000
```

Agora abre no navegador: **http://localhost:3000** (não 5173!)

Você deve ver o site Vite funcionando — servido pelo Express, não pelo Vite dev server. Testa o login → deve funcionar perfeitamente. **Esse é o cenário que vai rodar na Hostinger.**

Se tudo funcionou aqui, o deploy vai funcionar.

---

## 9. Etapa 7 — Commit e push

```powershell
git add .
git commit -m "Refactor: unifica frontend e backend em um único projeto"

# Empurra a branch nova
git push -u origin refactor/unify-monorepo
```

### Opção A: testar a branch antes de mergear

Pode criar um Pull Request no GitHub, deployar a branch direto na Hostinger pra ver se sobe, e só depois mergear pra `main`.

### Opção B: mergear direto (mais simples pro MVP)

```powershell
git checkout main
git merge refactor/unify-monorepo
git push origin main
```

---

## 10. Etapa 8 — Reconfigurar a Hostinger

Agora vamos consolidar pra um **único site** no painel.

### 10.1. Deletar os sites antigos

Você provavelmente tem 1 ou 2 sites configurados:

- **Site Vite** (`famax.toddynhovt.com`) — vai virar parte do novo
- **Site Node.js** (se você chegou a criar) — vai ser substituído

No painel da Hostinger:

1. Pra cada site existente: **Settings** → **Delete website**
2. Confirma

> Se o domínio `famax.toddynhovt.com` estiver conectado, anota onde ele está apontando agora — vai precisar reconectar ao novo site.

### 10.2. Criar o site novo (único)

1. **Add Website** → escolhe **Node.js Apps**
2. Conecta o repo `famax` do GitHub
3. Configurações:

| Campo                        | Valor                                                 |
| ---------------------------- | ----------------------------------------------------- |
| **Configuração predefinida** | **Express**                                           |
| **Branch**                   | `main`                                                |
| **Versão do node**           | `22.x`                                                |
| **Diretório raiz**           | `./` (vai aceitar — agora o `package.json` está aqui) |

4. Em **Configurações de compilação e saída** → **Alterar**:

| Campo                      | Valor                         |
| -------------------------- | ----------------------------- |
| **Comando de construção**  | `npm run build` (no dropdown) |
| **Gerenciador de pacotes** | `npm`                         |
| **Diretório de saída**     | `dist`                        |
| **Arquivo de entrada**     | `dist/server.js`              |

5. **Variáveis de ambiente** — adiciona apenas estas 2:

| Chave          | Valor                                                            |
| -------------- | ---------------------------------------------------------------- |
| `DATABASE_URL` | connection string do Supabase (Session Pooler, com a senha real) |
| `JWT_SECRET`   | string aleatória de 32+ caracteres                               |

> Note que **não precisa mais** de `CORS_ORIGIN` (same-origin) nem de `VITE_API_URL` (URL relativa). `NODE_ENV` é opcional — o Express já roda em modo produção por padrão quando inicia em prod.

6. **Finaliza** e deixa a Hostinger buildar.

### 10.3. Acompanhar o build

Vai rodar mais ou menos assim:

1. Clone do repo
2. `npm install` (pode ser que precise de `--include=dev`)
3. `npm run build` → `vite build && tsc`
4. `node dist/server.js`

Se o build falhar com erros tipo `Cannot find name 'process'` ou `Could not find a declaration file for module 'express'`, é o já-conhecido problema dos `@types/*`. Solução:

- Adiciona um script no `package.json` da raiz:
  ```json
  "scripts": {
    "build:install": "npm install --include=dev && npm run build"
  }
  ```
- Comita e push
- Na Hostinger, muda o dropdown de "Comando de construção" pra `npm run build:install`
- Redeploy

### 10.4. Conectar o domínio

Quando o build terminar e o app subir, conecta o domínio `famax.toddynhovt.com` ao novo site:

- **Domains** → **Connect a domain** → segue o wizard

---

## 11. Etapa 9 — Verificação final

### 11.1. Healthcheck

```powershell
curl.exe https://famax.toddynhovt.com/api/health
```

Deve voltar `{"status":"ok",...}` (sem cold start, porque é shared hosting always-on).

### 11.2. Frontend carregando

Abre no navegador: `https://famax.toddynhovt.com`

Deve abrir a home do FAMAX normalmente.

### 11.3. Login real funcionando

Abre: `https://famax.toddynhovt.com/html/user-pages/login.html`

(Ou clica nos links de navegação até chegar lá.)

Faz login com um usuário que já existe no Supabase. Abre o **DevTools (F12) → Network** antes de clicar em entrar.

Deve aparecer:

- POST pra `https://famax.toddynhovt.com/api/auth/login` (note: **mesmo domínio**, sem CORS)
- Status `200`
- Resposta com token JWT
- Redirecionamento pra home

Se funcionou: **refactor completo, MVP no ar**.

---

## 12. Troubleshooting

### Build falha com "Cannot find module" mesmo após `--include=dev`

Verifica que `@types/pg`, `@types/express`, `@types/bcrypt`, `@types/cors`, `@types/jsonwebtoken`, `@types/node` estão TODOS no `package.json` (em `devDependencies`). Se faltar algum, comita e push.

### "Cannot find name 'process'"

Falta `@types/node` no `package.json`. Adiciona:

```bash
npm install --save-dev @types/node
```

### Site abre mas tudo dá 404

Provavelmente o `vite build` não rodou ou o output foi pra lugar errado. Verifica:

- `dist/public/index.html` existe?
- Se sim, o `server.ts` está apontando pra `path.join(__dirname, "public")`?

### Erro "ENOENT: no such file or directory, stat '.../dist/public/index.html'"

O build do Vite não rodou. Confirma que `npm run build` na Hostinger executa **dois passos**: `vite build` E `tsc`. Se só rodou `tsc`, o script no `package.json` está errado.

### Tela do site aparece em branco e console do navegador mostra erros 404 de `.js` ou `.css`

Os assets do Vite estão referenciando paths absolutos diferentes do esperado. Solução: adiciona `base: "/"` no `vite.config.ts` dentro do `defineConfig({})`. Já está implícito por padrão, mas em alguns casos precisa ser explícito.

### CORS bloqueando algo

Em prod same-origin, CORS não deveria atrapalhar. Se atrapalhar, troca:

```typescript
app.use(cors({ origin: true, credentials: true }));
```

por

```typescript
app.use(cors());
```

### Build local funciona mas Hostinger falha

Geralmente é diferença de Node version ou env vars. Confere:

- Hostinger configurada pra Node 22.x?
- `DATABASE_URL` e `JWT_SECRET` setadas?
- O log da Hostinger mostra o erro real?

### `npm start` local funciona, Hostinger sobe mas não responde nada

A Hostinger pode estar injetando uma `PORT` diferente via env var. Confere no `server/config.ts`:

```typescript
PORT: Number(process.env.PORT ?? 3000),
```

Tem que ler de `process.env.PORT` — senão a Hostinger não consegue rotear.

---

## Resumo executivo

Você unificou tudo num único projeto:

- 1 `package.json`
- 1 build (`npm run build` → frontend + backend)
- 1 deploy
- 1 site na Hostinger
- 1 URL pública (frontend e API mesmo domínio)
- Mantém dev local com hot reload via Vite proxy

Trade-offs aceitos:

- Build mais lento (Vite build + tsc)
- Deploy "tudo ou nada"
- Express servindo estáticos (não é o mais eficiente, mas funciona pro MVP)

Quando precisar evoluir, dá pra extrair de volta em dois deploys, ou colocar um CDN na frente pros estáticos. Mas pra MVP, esse setup é simples e robusto.

Manda o log se travar em qualquer etapa.
