/**
 * Teste de integração dos 3 sistemas.
 *
 * Sobe um Postgres real em processo (PGlite) falando o protocolo wire, aplica
 * o schema de _/DB.psql + as migrations de server/sql, e exercita os endpoints
 * por HTTP — sem nenhuma alteração no código de produção.
 *
 * Uso: npx tsx test/integration.mjs
 */
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DB_PORT = 55432;
const API_PORT = 3999;
const BASE = `http://127.0.0.1:${API_PORT}/api`;

let passed = 0;
let failed = 0;
const failures = [];

function check(name, condition, detail) {
    if (condition) {
        passed++;
        console.log(`  ✓ ${name}`);
    } else {
        failed++;
        failures.push(name);
        console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    }
}

/**
 * Chama a API. Cadastros bem-sucedidos já saem com o e-mail verificado (direto
 * no banco), porque quase toda a suíte cria comunidade ou manda mensagem — o
 * que a verificação trava. A seção de verificação de e-mail usa
 * keepUnverified para exercitar o fluxo de verdade.
 */
async function call(method, endpoint, { token, body, raw, keepUnverified } = {}) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body && !raw) headers["Content-Type"] = "application/json";

    const response = await fetch(`${BASE}${endpoint}`, {
        method,
        headers,
        body: raw ? body : body ? JSON.stringify(body) : undefined,
    });

    let payload = null;
    if (response.status !== 204) {
        payload = await response.json().catch(() => null);
    }
    if (method === "POST" && endpoint === "/auth/register" && response.status === 201 && !keepUnverified) {
        await db.query("UPDATE users SET email_verified_at = NOW() WHERE user_id = $1", [payload.user.userId]);
    }
    return { status: response.status, body: payload };
}

// ---------------------------------------------------------------------------

console.log("Iniciando Postgres em processo (PGlite)...");
// pg_trgm carregado como em produção: a busca (migration 011) usa trigramas.
const db = await PGlite.create({ extensions: { pg_trgm } });
const pgServer = new PGLiteSocketServer({ db, port: DB_PORT, host: "127.0.0.1" });
await pgServer.start();

console.log("Aplicando schema base...");
const baseSchema = await readFile(
    path.join(root, "server", "sql", "baseline", "DB.psql"),
    "utf8",
);
await db.exec(baseSchema);

// As migrations de server/sql NÃO são aplicadas aqui: quem aplica é o próprio
// servidor no boot (server/migrate.ts), como em produção. Assim o teste cobre
// esse caminho, e migrations novas entram automaticamente.
const sqlDir = path.join(root, "server", "sql");
const migrations = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();

process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`;
process.env.DATABASE_SSL = "false";
process.env.JWT_SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";
process.env.PORT = String(API_PORT);
process.env.NODE_ENV = "development";
// O socket do PGlite atende uma conexão por vez: um LISTEN parado nela
// travaria a suíte. O barramento em memória cobre o mesmo caminho (ver
// lib/realtime.ts).
process.env.REALTIME_BUS = "memory";
// Chave da 2FA só de teste (32 bytes em hex).
process.env.TWO_FACTOR_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

console.log("Subindo a API...");
await import("../server/server.js");
// Mesmo processo, mesmo módulo: o reset zera as contagens que a API usa. A
// suíte faz mais logins/cadastros do que os limites de produção permitem, e
// eles continuam valendo normalmente — só são zerados entre as seções.
const { resetRateLimits } = await import("../server/lib/rate-limit.js");

// Espera o BANCO, não só a porta: o servidor abre a porta antes de conectar no
// banco (exigência da hospedagem, ver server.ts), e nessa janela as rotas de
// API respondem 503. Parar no primeiro 200 do /health deixava a suíte começar
// cedo demais.
let dbReady = false;
for (let i = 0; i < 120; i++) {
    try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) {
            const body = await res.json();
            if (body.db === "ready") {
                dbReady = true;
                break;
            }
            if (body.db === "error") {
                console.error(`API subiu mas o banco falhou: ${body.dbError ?? "sem detalhe"}`);
                process.exit(1);
            }
        }
    } catch {
        /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 250));
}

if (!dbReady) {
    console.error("Banco não ficou pronto em 30s.");
    process.exit(1);
}

// ---------------------------------------------------------------------------

const stamp = Date.now();
const alice = {
    email: `alice${stamp}@famax.test`,
    username: `alice${stamp}`,
    password: "senha123!forte",
    displayName: "Alice Teste",
    termsAccepted: true,
};
const bob = {
    email: `bob${stamp}@famax.test`,
    username: `bob${stamp}`,
    password: "senha123!forte",
    displayName: "Bob Teste",
    termsAccepted: true,
};

console.log("\n[0] Migrations no boot");
const { rows: registered } = await db.query(
    "SELECT filename FROM schema_migrations ORDER BY filename",
);
check(
    "servidor aplicou e registrou todas as migrations no boot",
    JSON.stringify(registered.map((r) => r.filename)) === JSON.stringify(migrations),
    registered.map((r) => r.filename).join(", "),
);

console.log("\n[0] Autenticação");
const aliceReg = await call("POST", "/auth/register", { body: alice });
check("registra alice", aliceReg.status === 201, JSON.stringify(aliceReg.body));
const bobReg = await call("POST", "/auth/register", { body: bob });
check("registra bob", bobReg.status === 201, JSON.stringify(bobReg.body));

const aliceToken = aliceReg.body?.token;
const bobToken = bobReg.body?.token;
const bobId = bobReg.body?.user?.userId;

// O register já devolve token, então o login é coberto só aqui — é o único
// ponto que exercita o bcrypt.compare e o 401 genérico de credencial inválida.
const loginEmail = await call("POST", "/auth/login", {
    body: { identifier: alice.email, password: alice.password },
});
check(
    "login por email devolve token",
    loginEmail.status === 200 && Boolean(loginEmail.body?.token),
    JSON.stringify(loginEmail.body).slice(0, 120),
);

const loginUsername = await call("POST", "/auth/login", {
    body: { identifier: alice.username, password: alice.password },
});
check(
    "login por username devolve token",
    loginUsername.status === 200 && Boolean(loginUsername.body?.token),
    JSON.stringify(loginUsername.body).slice(0, 120),
);

// Cada login tem que emitir um token distinto, senão o INSERT em
// user_sessions bate na uq_user_sessions_token e devolve 500. Checa o jti
// em vez de só comparar os tokens: sem ele, dois logins em segundos
// diferentes já geram tokens diferentes pelo iat, e o teste passaria à toa.
// Devolve null em vez de lançar: quando a regressão aparece o login responde
// 500 sem token, e um throw aqui abortaria o resto da suíte em vez de
// registrar uma falha.
const jti = (token) => {
    try {
        const payload = token.split(".")[1];
        return JSON.parse(Buffer.from(payload, "base64url").toString()).jti ?? null;
    } catch {
        return null;
    }
};
const jtiEmail = jti(loginEmail.body?.token);
const jtiUsername = jti(loginUsername.body?.token);
check(
    "logins consecutivos emitem tokens com jti distinto",
    jtiEmail !== null && jtiEmail !== jtiUsername,
    `${jtiEmail} vs ${jtiUsername}`,
);

const loginWrongPassword = await call("POST", "/auth/login", {
    body: { identifier: alice.email, password: "senha-errada" },
});
check(
    "senha errada → 401",
    loginWrongPassword.status === 401,
    JSON.stringify(loginWrongPassword.body),
);

// Email inexistente ainda passa pelo bcrypt.compare contra o fakeHash, para o
// tempo de resposta não revelar se a conta existe. A mensagem tem que ser a
// mesma da senha errada, senão o 401 vira um oráculo de emails cadastrados.
const loginUnknown = await call("POST", "/auth/login", {
    body: { identifier: `fantasma${stamp}@famax.test`, password: alice.password },
});
check(
    "usuário inexistente → 401 com a mesma mensagem",
    loginUnknown.status === 401 &&
        loginUnknown.body?.error === loginWrongPassword.body?.error,
    JSON.stringify(loginUnknown.body),
);

const loginNoIdentifier = await call("POST", "/auth/login", {
    body: { password: alice.password },
});
check(
    "login sem identifier → 400",
    loginNoIdentifier.status === 400,
    JSON.stringify(loginNoIdentifier.body).slice(0, 120),
);

// Fecha o ciclo: o token emitido pelo login (e não pelo register) autentica.
const loginTokenUse = await call("GET", "/me/communities", {
    token: loginEmail.body?.token,
});
check(
    "token do login autentica numa rota protegida",
    loginTokenUse.status === 200,
    String(loginTokenUse.status),
);

// --- Rate limit do login e do cadastro --------------------------------------

console.log("\n[0] Rate limit");

// Por identificador: 5 tentativas erradas na mesma conta e a 6ª é barrada —
// inclusive com a senha CERTA, senão o atacante saberia quando acertou.
for (let i = 0; i < 5; i++) {
    await call("POST", "/auth/login", {
        body: { identifier: bob.username, password: "chute-errado" },
    });
}
const loginBlocked = await fetch(`${BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: bob.username, password: bob.password }),
});
check(
    "login por identificador: 6ª tentativa → 429 com Retry-After",
    loginBlocked.status === 429 && Number(loginBlocked.headers.get("retry-after")) > 0,
    `${loginBlocked.status} retry-after=${loginBlocked.headers.get("retry-after")}`,
);

// O identificador é normalizado: maiúsculas não abrem um contador novo.
const loginBlockedUpper = await call("POST", "/auth/login", {
    body: { identifier: bob.username.toUpperCase(), password: "chute-errado" },
});
check(
    "limite por identificador ignora maiúsculas",
    loginBlockedUpper.status === 429,
    String(loginBlockedUpper.status),
);

// Login com sucesso não consome o limite (skipSuccessful).
resetRateLimits();
let successBlocked = false;
for (let i = 0; i < 7; i++) {
    const ok = await call("POST", "/auth/login", {
        body: { identifier: alice.username, password: alice.password },
    });
    if (ok.status !== 200) successBlocked = true;
}
check("logins com sucesso não são barrados", !successBlocked);

// Por IP: identificadores diferentes, mesma origem — 10 falhas e a 11ª cai.
resetRateLimits();
for (let i = 0; i < 10; i++) {
    await call("POST", "/auth/login", {
        body: { identifier: `fantasma${i}-${stamp}`, password: "x" },
    });
}
const ipBlocked = await call("POST", "/auth/login", {
    body: { identifier: `fantasma-extra-${stamp}`, password: "x" },
});
check("login por IP: 11ª falha → 429", ipBlocked.status === 429, String(ipBlocked.status));

// Cadastro: 5 por hora por IP. Corpos inválidos bastam — a tentativa conta
// antes da validação, e assim o teste não paga 6 bcrypt.
resetRateLimits();
for (let i = 0; i < 5; i++) {
    await call("POST", "/auth/register", { body: {} });
}
const registerBlocked = await call("POST", "/auth/register", { body: alice });
check(
    "cadastro: 6ª tentativa na hora → 429",
    registerBlocked.status === 429,
    String(registerBlocked.status),
);

resetRateLimits();

// --- Sistema 2: comunidades -------------------------------------------------

console.log("\n[Sistema 2] Criação de comunidade");

const categories = await call("GET", "/categories");
check(
    "GET /categories devolve o seed",
    categories.status === 200 && categories.body.data.length >= 5,
    JSON.stringify(categories.body).slice(0, 120),
);
const categoryId = categories.body?.data?.[0]?.categoryId;

const noAuth = await call("POST", "/communities", {
    body: { name: "Sem Token", categoryId },
});
check("POST /communities sem token → 401", noAuth.status === 401);

const communityName = `Comunidade Teste ${stamp}`;
const created = await call("POST", "/communities", {
    token: aliceToken,
    body: { name: communityName, categoryId, description: "Descrição de teste" },
});
check(
    "cria comunidade",
    created.status === 201,
    JSON.stringify(created.body).slice(0, 200),
);
const communityId = created.body?.community?.communityId;

const duplicate = await call("POST", "/communities", {
    token: aliceToken,
    body: { name: communityName, categoryId },
});
check("nome duplicado → 409", duplicate.status === 409, JSON.stringify(duplicate.body));

const badCategory = await call("POST", "/communities", {
    token: aliceToken,
    body: { name: `Outra ${stamp}`, categoryId: "00000000-0000-0000-0000-000000000000" },
});
check(
    "categoria inexistente → 400",
    badCategory.status === 400,
    JSON.stringify(badCategory.body),
);

const detail = await call("GET", `/communities/${communityId}`);
check(
    "GET /communities/:id traz as 6 subcategorias padrão",
    detail.status === 200 && detail.body.categories.length === 6,
    `status=${detail.status} categorias=${detail.body?.categories?.length}`,
);
const subCategoryId = detail.body?.categories?.[0]?.communityCategoryId;

const mine = await call("GET", "/me/communities", { token: aliceToken });
check(
    "criador vira owner automaticamente",
    mine.status === 200 &&
        mine.body.data.length === 1 &&
        mine.body.data[0].role === "owner",
    JSON.stringify(mine.body).slice(0, 160),
);

const feed = await call("GET", "/communities");
check(
    "GET /communities lista no feed",
    feed.status === 200 && feed.body.data.some((c) => c.communityId === communityId),
);

// --- Posts ------------------------------------------------------------------

// --- Upload de capa (multipart) ---------------------------------------------

console.log("\n[Sistema 2] Upload de capa");

// Usuário próprio: o rate limit de create-community é 5/min por usuário e a
// alice já gastou 3 nos testes acima.
const dave = {
    email: `dave${stamp}@famax.test`,
    username: `dave${stamp}`,
    password: "senha123!forte",
    displayName: "Dave Teste",
    termsAccepted: true,
};
const daveReg = await call("POST", "/auth/register", { body: dave });
const daveToken = daveReg.body?.token;

// Os magic bytes de um PNG. O conteúdo não precisa ser uma imagem de verdade:
// sem SUPABASE_URL/SUPABASE_SERVICE_KEY o isStorageEnabled() é false e a rota
// nem chama o uploadCommunityCover — o que se exercita aqui é o multer e o
// errorHandler, não o Storage.
const pngBytes = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);

const withCover = new FormData();
withCover.append("name", `Com Capa ${stamp}`);
withCover.append("categoryId", categoryId);
withCover.append("cover", new Blob([pngBytes], { type: "image/png" }), "capa.png");
const coverOk = await call("POST", "/communities", {
    token: daveToken,
    body: withCover,
    raw: true,
});
check(
    "cria comunidade com capa (multipart)",
    coverOk.status === 201,
    JSON.stringify(coverOk.body).slice(0, 140),
);

const tooBig = new FormData();
tooBig.append("name", `Capa Grande ${stamp}`);
tooBig.append("categoryId", categoryId);
tooBig.append("cover", new Blob([new Uint8Array(3 * 1024 * 1024)]), "grande.png");
const coverTooBig = await call("POST", "/communities", {
    token: daveToken,
    body: tooBig,
    raw: true,
});
check(
    "capa acima de 2MB → 413",
    coverTooBig.status === 413 && /2MB/.test(coverTooBig.body?.error ?? ""),
    `${coverTooBig.status} ${JSON.stringify(coverTooBig.body)}`,
);

// fieldArrayIndexLimit: um índice alto forçava a alocação de um array esparso
// gigante e travava o processo. Tem que virar 400, e com mensagem de
// formulário — o problema é o nome do campo, não o arquivo.
const arrayIndex = new FormData();
arrayIndex.append("name", `Indice ${stamp}`);
arrayIndex.append("categoryId", categoryId);
arrayIndex.append("items[4294967294]", "a");
const coverArrayIndex = await call("POST", "/communities", {
    token: daveToken,
    body: arrayIndex,
    raw: true,
});
check(
    "índice de array no nome do campo → 400 Formulário inválido",
    coverArrayIndex.status === 400 &&
        coverArrayIndex.body?.error === "Formulário inválido",
    `${coverArrayIndex.status} ${JSON.stringify(coverArrayIndex.body)}`,
);

// Contraponto do check acima: erro que é de arquivo continua dizendo arquivo.
// Se os dois caírem na mesma mensagem, a separação no errorHandler se perdeu.
const wrongField = new FormData();
wrongField.append("name", `Campo Errado ${stamp}`);
wrongField.append("categoryId", categoryId);
wrongField.append("anexo", new Blob([pngBytes]), "capa.png");
const coverWrongField = await call("POST", "/communities", {
    token: daveToken,
    body: wrongField,
    raw: true,
});
check(
    "campo de arquivo inesperado → 400 Arquivo inválido",
    coverWrongField.status === 400 &&
        coverWrongField.body?.error === "Arquivo inválido",
    `${coverWrongField.status} ${JSON.stringify(coverWrongField.body)}`,
);

// O sniffImageType é a única barreira contra um arquivo renomeado — o
// mimetype que o multer expõe vem do cliente. Chamado direto porque a rota só
// chega nele com o Storage configurado, o que o harness não faz.
const { sniffImageType } = await import("../server/lib/storage.js");
check(
    "sniffImageType reconhece PNG",
    sniffImageType(Buffer.from(pngBytes)) === "png",
);
check(
    "sniffImageType reconhece JPEG",
    sniffImageType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) ===
        "jpeg",
);
check(
    "sniffImageType reconhece WebP",
    sniffImageType(
        Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
    ) === "webp",
);
check(
    "sniffImageType rejeita executável renomeado para .png",
    sniffImageType(Buffer.from([0x4d, 0x5a, 0x90, 0, 0, 0, 0, 0, 0, 0, 0, 0])) === null,
);
check(
    "sniffImageType rejeita buffer curto demais",
    sniffImageType(Buffer.from([0x89, 0x50])) === null,
);


console.log("\n[Sistema 2] Posts");

const postByStranger = await call("POST", "/posts", {
    token: bobToken,
    body: { communityId, title: "Invasor", content: "não sou membro" },
});
check(
    "não-membro não publica → 403",
    postByStranger.status === 403,
    JSON.stringify(postByStranger.body),
);

const post = await call("POST", "/posts", {
    token: aliceToken,
    body: {
        communityId,
        communityCategoryId: subCategoryId,
        title: "Primeira discussão",
        content: "Conteúdo do post de teste",
    },
});
check("membro publica", post.status === 201, JSON.stringify(post.body).slice(0, 200));
const postId = post.body?.post?.postId;

// Subcategoria existe, mas é da comunidade do dave (criada no upload de capa).
const daveCommunity = await call(
    "GET",
    `/communities/${coverOk.body?.community?.communityId}`,
);
const foreignSubCategoryId = daveCommunity.body?.categories?.[0]?.communityCategoryId;
const postForeignCategory = await call("POST", "/posts", {
    token: aliceToken,
    body: {
        communityId,
        communityCategoryId: foreignSubCategoryId,
        title: "Categoria errada",
        content: "subcategoria de outra comunidade",
    },
});
check(
    "subcategoria de outra comunidade → 400",
    postForeignCategory.status === 400 &&
        postForeignCategory.body?.error === "Categoria não pertence a esta comunidade",
    `${postForeignCategory.status} ${JSON.stringify(postForeignCategory.body)}`,
);

const joined = await call("POST", `/communities/${communityId}/join`, {
    token: bobToken,
});
check("bob entra na comunidade", joined.status === 200);

const joinAgain = await call("POST", `/communities/${communityId}/join`, {
    token: bobToken,
});
check("entrar duas vezes é idempotente", joinAgain.status === 200);

// --- Sistema 3: comentários e likes -----------------------------------------

console.log("\n[Sistema 3] Comentários e likes");

const comment = await call("POST", `/posts/${postId}/comments`, {
    token: bobToken,
    body: { content: "Comentário do bob" },
});
check("comenta", comment.status === 201, JSON.stringify(comment.body).slice(0, 200));
const commentId = comment.body?.comment?.commentId;
check(
    "comentário volta com autor resolvido",
    comment.body?.comment?.authorDisplayName === "Bob Teste",
    JSON.stringify(comment.body?.comment),
);

const afterComment = await call("GET", `/communities/${communityId}/posts`);
check(
    "comments_count incrementou",
    afterComment.body?.data?.[0]?.commentsCount === 1,
    `count=${afterComment.body?.data?.[0]?.commentsCount}`,
);

const xssComment = await call("POST", `/posts/${postId}/comments`, {
    token: bobToken,
    body: { content: '<img src=x onerror=alert(1)>' },
});
check("aceita payload XSS como texto puro", xssComment.status === 201);
const listed = await call("GET", `/posts/${postId}/comments`);
check(
    "conteúdo é devolvido literal (escape é do render)",
    listed.body?.data?.some((c) => c.content === "<img src=x onerror=alert(1)>"),
);

const orphanParent = await call("POST", `/posts/${postId}/comments`, {
    token: bobToken,
    body: {
        content: "resposta órfã",
        parentCommentId: "00000000-0000-0000-0000-000000000000",
    },
});
check(
    "parentCommentId de outro post → 400",
    orphanParent.status === 400,
    JSON.stringify(orphanParent.body),
);

const like1 = await call("POST", `/posts/${postId}/reactions`, { token: bobToken });
check(
    "curtir",
    like1.status === 200 && like1.body.liked === true && like1.body.likesCount === 1,
    JSON.stringify(like1.body),
);

const like2 = await call("POST", `/posts/${postId}/reactions`, { token: bobToken });
check(
    "curtir de novo descurte (toggle)",
    like2.status === 200 && like2.body.liked === false && like2.body.likesCount === 0,
    JSON.stringify(like2.body),
);

await call("POST", `/posts/${postId}/reactions`, { token: bobToken });
const feedAsBob = await call("GET", `/communities/${communityId}/posts`, {
    token: bobToken,
});
check(
    "liked_by_me = true para quem curtiu",
    feedAsBob.body?.data?.[0]?.likedByMe === true,
    JSON.stringify(feedAsBob.body?.data?.[0]?.likedByMe),
);

const feedAnon = await call("GET", `/communities/${communityId}/posts`);
check(
    "liked_by_me = false sem sessão",
    feedAnon.body?.data?.[0]?.likedByMe === false,
);

// A dona da comunidade (alice) agora pode remover como moderadora; quem não
// tem papel nenhum (dave) continua recebendo 404.
const deleteOther = await call("DELETE", `/comments/${commentId}`, {
    token: daveToken,
});
check(
    "não dá para apagar comentário alheio → 404",
    deleteOther.status === 404,
    JSON.stringify(deleteOther.body),
);

const deleteOwn = await call("DELETE", `/comments/${commentId}`, { token: bobToken });
check("autor apaga o próprio comentário", deleteOwn.status === 204);

const afterDelete = await call("GET", `/communities/${communityId}/posts`);
check(
    "comments_count decrementou",
    afterDelete.body?.data?.[0]?.commentsCount === 1,
    `count=${afterDelete.body?.data?.[0]?.commentsCount}`,
);

// --- Sistema 1: chat --------------------------------------------------------

console.log("\n[Sistema 1] Chat");

const chatNoAuth = await call("GET", "/conversations");
check("chat exige token → 401", chatNoAuth.status === 401);

const conversation = await call("POST", "/conversations", {
    token: aliceToken,
    body: { userId: bobId },
});
check(
    "abre conversa 1:1",
    conversation.status === 201 && conversation.body.created === true,
    JSON.stringify(conversation.body),
);
const conversationId = conversation.body?.conversationId;

const reopened = await call("POST", "/conversations", {
    token: bobToken,
    body: { userId: aliceReg.body?.user?.userId },
});
check(
    "reabrir pelo outro lado devolve a MESMA conversa",
    reopened.body?.conversationId === conversationId && reopened.body?.created === false,
    `${reopened.body?.conversationId} vs ${conversationId}`,
);

const selfChat = await call("POST", "/conversations", {
    token: aliceToken,
    body: { userId: aliceReg.body?.user?.userId },
});
check("conversa consigo mesmo → 400", selfChat.status === 400);

const sent = await call("POST", `/conversations/${conversationId}/messages`, {
    token: aliceToken,
    body: { content: "Oi Bob!" },
});
check("envia mensagem", sent.status === 201, JSON.stringify(sent.body).slice(0, 160));

const history = await call("GET", `/conversations/${conversationId}/messages`, {
    token: bobToken,
});
check(
    "destinatário lê o histórico",
    history.status === 200 && history.body.data.length === 1,
    JSON.stringify(history.body).slice(0, 160),
);

const listForBob = await call("GET", "/conversations", { token: bobToken });
check(
    "unread_count conta a mensagem não lida",
    listForBob.body?.data?.[0]?.unreadCount === 1,
    `unread=${listForBob.body?.data?.[0]?.unreadCount}`,
);
check(
    "lista traz a última mensagem e o outro participante",
    listForBob.body?.data?.[0]?.lastMessageContent === "Oi Bob!" &&
        listForBob.body?.data?.[0]?.otherDisplayName === "Alice Teste",
    JSON.stringify(listForBob.body?.data?.[0]).slice(0, 200),
);

const read = await call("POST", `/conversations/${conversationId}/read`, {
    token: bobToken,
});
check("marca como lida", read.status === 204);

const afterRead = await call("GET", "/conversations", { token: bobToken });
check(
    "unread_count zera após leitura",
    afterRead.body?.data?.[0]?.unreadCount === 0,
    `unread=${afterRead.body?.data?.[0]?.unreadCount}`,
);

// Cursor do polling.
const cursor = sent.body?.message?.createdAt;
const delta = await call(
    "GET",
    `/conversations/${conversationId}/messages?after=${encodeURIComponent(cursor)}`,
    { token: bobToken },
);
check(
    "polling com cursor não repete o que já foi lido",
    delta.body?.data?.length === 0,
    `retornou ${delta.body?.data?.length}`,
);

await call("POST", `/conversations/${conversationId}/messages`, {
    token: bobToken,
    body: { content: "Oi Alice!" },
});
const delta2 = await call(
    "GET",
    `/conversations/${conversationId}/messages?after=${encodeURIComponent(cursor)}`,
    { token: aliceToken },
);
check(
    "polling com cursor traz só a mensagem nova",
    delta2.body?.data?.length === 1 && delta2.body.data[0].content === "Oi Alice!",
    JSON.stringify(delta2.body?.data).slice(0, 160),
);

// Isolamento: um terceiro não pode ler a conversa.
const carol = {
    email: `carol${stamp}@famax.test`,
    username: `carol${stamp}`,
    password: "senha123!forte",
    displayName: "Carol Teste",
    termsAccepted: true,
};
const carolReg = await call("POST", "/auth/register", { body: carol });
const intruder = await call("GET", `/conversations/${conversationId}/messages`, {
    token: carolReg.body?.token,
});
check(
    "terceiro não lê conversa alheia → 404",
    intruder.status === 404,
    JSON.stringify(intruder.body),
);

const intruderSend = await call("POST", `/conversations/${conversationId}/messages`, {
    token: carolReg.body?.token,
    body: { content: "invadindo" },
});
check("terceiro não escreve na conversa → 404", intruderSend.status === 404);

const userSearch = await call("GET", `/users?search=bob${stamp}`, {
    token: aliceToken,
});
check(
    "busca de usuários encontra o bob",
    userSearch.status === 200 && userSearch.body.data.length === 1,
    JSON.stringify(userSearch.body).slice(0, 160),
);

// --- Conta excluída ---------------------------------------------------------

console.log("\n[0] Conta excluída");
resetRateLimits();

const erin = {
    email: `erin${stamp}@famax.test`,
    username: `erin${stamp}`,
    password: "senha123!forte",
    displayName: "Erin Teste",
    termsAccepted: true,
};
const erinReg = await call("POST", "/auth/register", { body: erin });
const erinToken = erinReg.body?.token;
const erinBefore = await call("GET", "/me/communities", { token: erinToken });
check("token da erin autentica antes da exclusão", erinBefore.status === 200);

// Não há rota de excluir conta ainda: o soft delete vai direto no banco.
await db.query("UPDATE users SET deleted_at = NOW() WHERE user_id = $1", [
    erinReg.body?.user?.userId,
]);

const erinAfter = await call("GET", "/me/communities", { token: erinToken });
check(
    "token de usuário com deleted_at → 401",
    erinAfter.status === 401,
    `${erinAfter.status} ${JSON.stringify(erinAfter.body)}`,
);

const erinOptional = await call("GET", `/communities/${communityId}/posts`, {
    token: erinToken,
});
check(
    "rota com optionalAuth trata usuário excluído como visitante",
    erinOptional.status === 200 && erinOptional.body?.data?.[0]?.likedByMe === false,
    `${erinOptional.status}`,
);

// --- Busca de usuários e perfil privado ---------------------------------------

console.log("\n[Sistema 1] Busca e perfil privado");

// Cadastro sem escolha nasce público: o dave nunca conversou com a carol.
const carolToken = carolReg.body?.token;
const defaultPublic = await call("GET", `/users?search=dave${stamp}`, {
    token: carolToken,
});
check(
    "cadastro sem isPrivate nasce público (aparece na busca)",
    defaultPublic.status === 200 && defaultPublic.body.data.length === 1,
    JSON.stringify(defaultPublic.body).slice(0, 160),
);

// O frank escolhe perfil privado no cadastro.
const frank = {
    email: `frank${stamp}@famax.test`,
    username: `frank${stamp}`,
    password: "senha123!forte",
    displayName: "Frank Teste",
    termsAccepted: true,
    isPrivate: true,
};
const frankReg = await call("POST", "/auth/register", { body: frank });

const privateHidden = await call("GET", `/users?search=frank${stamp}`, {
    token: carolToken,
});
check(
    "perfil privado não aparece na busca sem conversa",
    privateHidden.status === 200 && privateHidden.body.data.length === 0,
    JSON.stringify(privateHidden.body).slice(0, 160),
);

await call("POST", "/conversations", {
    token: carolToken,
    body: { userId: frankReg.body?.user?.userId },
});
const privateVisible = await call("GET", `/users?search=frank${stamp}`, {
    token: carolToken,
});
check(
    "perfil privado aparece na busca para quem já tem conversa",
    privateVisible.status === 200 && privateVisible.body.data.length === 1,
    JSON.stringify(privateVisible.body).slice(0, 160),
);

await db.query("UPDATE user_settings SET is_private = FALSE WHERE user_id = $1", [
    frankReg.body?.user?.userId,
]);
const publicVisible = await call("GET", `/users?search=frank${stamp}`, {
    token: aliceToken,
});
check(
    "perfil público aparece na busca sem conversa",
    publicVisible.status === 200 && publicVisible.body.data.length === 1,
    JSON.stringify(publicVisible.body).slice(0, 160),
);

// --- Sessões, logout e /me ----------------------------------------------------

console.log("\n[0] Sessões e /me");
resetRateLimits();

// Usuário próprio: o logout-all no fim derruba todas as sessões dele.
const hank = {
    email: `hank${stamp}@famax.test`,
    username: `hank${stamp}`,
    password: "senha123!forte",
    displayName: "Hank Teste",
    termsAccepted: true,
};
const hankReg = await call("POST", "/auth/register", { body: hank });
const hankRegToken = hankReg.body?.token;
const hankId = hankReg.body?.user?.userId;

const { rows: hankSessions } = await db.query(
    "SELECT jti, token, expires_at, created_at FROM user_sessions WHERE user_id = $1",
    [hankId],
);
check(
    "cadastro cria sessão com jti e sem token cru",
    hankSessions.length === 1 &&
        hankSessions[0].jti === jti(hankRegToken) &&
        hankSessions[0].token === null,
    JSON.stringify(hankSessions),
);

// JWT_EXPIRES_IN padrão é 7d: a validade da sessão tem que bater com o exp.
const expPayload = JSON.parse(
    Buffer.from(hankRegToken.split(".")[1], "base64url").toString(),
);
check(
    "expires_at da sessão vem do exp do token",
    hankSessions[0] &&
        Math.abs(new Date(hankSessions[0].expires_at).getTime() - expPayload.exp * 1000) <
            1000,
    `${hankSessions[0]?.expires_at} vs ${expPayload.exp}`,
);

const me = await call("GET", "/me", { token: hankRegToken });
const meFields = [
    "userId", "email", "username", "displayName", "avatarUrl", "bannerUrl",
    "bio", "nickname", "birthDate", "gender", "isPrivate", "isAdult",
    "twoFactorEnabled", "createdAt",
];
check(
    "GET /me devolve os campos esperados",
    me.status === 200 &&
        meFields.every((field) => field in (me.body?.user ?? {})) &&
        me.body.user.userId === hankId &&
        me.body.user.displayName === "Hank Teste" &&
        me.body.user.isPrivate === false,
    JSON.stringify(me.body).slice(0, 200),
);
check("GET /me sem token → 401", (await call("GET", "/me")).status === 401);

// Assinatura válida sem sessão (como os tokens anteriores à migration 007)
// não autentica mais.
const jwt = (await import("jsonwebtoken")).default;
const orphanToken = jwt.sign({ sub: hankId }, process.env.JWT_SECRET, {
    expiresIn: "7d",
    jwtid: "00000000-0000-4000-8000-000000000000",
});
const orphan = await call("GET", "/me", { token: orphanToken });
check("token assinado sem sessão → 401", orphan.status === 401, String(orphan.status));

// Duas "abas"/dispositivos: o logout de uma não derruba a outra.
const hankLoginA = await call("POST", "/auth/login", {
    body: { identifier: hank.username, password: hank.password },
});
const hankLoginB = await call("POST", "/auth/login", {
    body: { identifier: hank.username, password: hank.password },
});
const tokenA = hankLoginA.body?.token;
const tokenB = hankLoginB.body?.token;

const logoutA = await call("POST", "/auth/logout", { token: tokenA });
check("logout → 204", logoutA.status === 204, String(logoutA.status));
check(
    "token deslogado → 401 na chamada seguinte",
    (await call("GET", "/me", { token: tokenA })).status === 401,
);
check(
    "logout não derruba as outras sessões",
    (await call("GET", "/me", { token: tokenB })).status === 200,
);

// Sessão expirada no banco, mesmo com o JWT ainda dentro do exp.
const hankLoginC = await call("POST", "/auth/login", {
    body: { identifier: hank.username, password: hank.password },
});
const tokenC = hankLoginC.body?.token;
await db.query(
    "UPDATE user_sessions SET expires_at = NOW() - INTERVAL '1 minute' WHERE jti = $1",
    [jti(tokenC)],
);
check(
    "token de sessão expirada → 401",
    (await call("GET", "/me", { token: tokenC })).status === 401,
);

const logoutAll = await call("POST", "/auth/logout-all", { token: tokenB });
check("logout-all → 204", logoutAll.status === 204, String(logoutAll.status));
// Em sequência: o socket do PGlite atende uma conexão por vez, e chamadas
// paralelas derrubam a do pool (ECONNRESET) — limitação do harness, não da API.
const afterAll = [];
for (const token of [tokenB, hankRegToken]) {
    afterAll.push(await call("GET", "/me", { token }));
}
check(
    "logout-all derruba todas as sessões do usuário",
    afterAll.every((r) => r.status === 401),
    afterAll.map((r) => r.status).join(","),
);
check(
    "logout-all não afeta outros usuários",
    (await call("GET", "/me", { token: aliceToken })).status === 200,
);

// --- Perfil e configurações -------------------------------------------------

console.log("\n[Perfil] Edição");
resetRateLimits();

const ivy = {
    email: `ivy${stamp}@famax.test`,
    username: `ivy${stamp}`,
    password: "senha123!forte",
    displayName: "Ivy Teste",
    termsAccepted: true,
};
const ivyReg = await call("POST", "/auth/register", { body: ivy });
const ivyId = ivyReg.body?.user?.userId;
// Sessão "deste dispositivo": é a que a troca de senha mantém.
const ivyToken = (
    await call("POST", "/auth/login", {
        body: { identifier: ivy.username, password: ivy.password },
    })
).body?.token;

const profileOk = await call("PATCH", "/me/profile", {
    token: ivyToken,
    body: {
        displayName: "Ivy Editada",
        nickname: "ivyzinha",
        bio: "Bio de teste",
        birthDate: "2000-05-10",
        gender: "feminino",
    },
});
check(
    "PATCH /me/profile salva e devolve o formato do /me",
    profileOk.status === 200 &&
        profileOk.body?.user?.displayName === "Ivy Editada" &&
        profileOk.body.user.nickname === "ivyzinha" &&
        profileOk.body.user.bio === "Bio de teste" &&
        profileOk.body.user.birthDate === "2000-05-10" &&
        profileOk.body.user.gender === "feminino" &&
        Array.isArray(profileOk.body.user.socialLinks),
    JSON.stringify(profileOk.body).slice(0, 200),
);

const clearNickname = await call("PATCH", "/me/profile", {
    token: ivyToken,
    body: { nickname: "" },
});
check(
    "apelido vazio vira null e o resto não muda",
    clearNickname.body?.user?.nickname === null &&
        clearNickname.body?.user?.bio === "Bio de teste",
    JSON.stringify(clearNickname.body?.user).slice(0, 160),
);

const invalidProfiles = [
    ["data no futuro", { birthDate: "2999-01-01" }],
    ["menor de 13 anos", { birthDate: `${new Date().getFullYear() - 5}-01-01` }],
    ["data inexistente", { birthDate: "2001-02-31" }],
    ["bio acima de 500", { bio: "x".repeat(501) }],
    ["gênero fora da lista", { gender: "robô" }],
    ["campo desconhecido", { email: "trocar@famax.test" }],
    ["corpo vazio", {}],
];
for (const [label, body] of invalidProfiles) {
    const res = await call("PATCH", "/me/profile", { token: ivyToken, body });
    check(`PATCH /me/profile com ${label} → 400`, res.status === 400, `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
}

// Conteúdo adulto depende da idade calculada pelo nascimento.
const adultOn = await call("PATCH", "/me/settings", {
    token: ivyToken,
    body: { isAdult: true },
});
check("isAdult com 18+ → 200", adultOn.status === 200 && adultOn.body?.user?.isAdult === true, JSON.stringify(adultOn.body).slice(0, 160));

const sixteen = `${new Date().getFullYear() - 16}-01-01`;
const minorDate = await call("PATCH", "/me/profile", {
    token: ivyToken,
    body: { birthDate: sixteen },
});
check(
    "nascimento que deixa de ter 18 anos desliga isAdult",
    minorDate.status === 200 && minorDate.body?.user?.isAdult === false,
    JSON.stringify(minorDate.body?.user).slice(0, 160),
);
const adultMinor = await call("PATCH", "/me/settings", {
    token: ivyToken,
    body: { isAdult: true },
});
check("isAdult com menos de 18 → 400", adultMinor.status === 400, JSON.stringify(adultMinor.body));
await call("PATCH", "/me/profile", { token: ivyToken, body: { birthDate: "2000-05-10" } });

const privateOn = await call("PATCH", "/me/settings", {
    token: ivyToken,
    body: { isPrivate: true },
});
check("PATCH /me/settings isPrivate", privateOn.body?.user?.isPrivate === true);

// --- Redes sociais -----------------------------------------------------------

const linksOk = await call("PUT", "/me/social-links", {
    token: ivyToken,
    body: {
        links: [
            { platform: "github", url: "https://github.com/ivy" },
            { platform: "site", url: "https://ivy.example" },
        ],
    },
});
check(
    "PUT /me/social-links substitui a lista",
    linksOk.status === 200 && linksOk.body?.user?.socialLinks?.length === 2,
    JSON.stringify(linksOk.body).slice(0, 200),
);

const invalidLinks = [
    ["http sem TLS", [{ platform: "site", url: "http://ivy.example" }]],
    ["javascript:", [{ platform: "site", url: "javascript:alert(1)" }]],
    ["plataforma fora da lista", [{ platform: "orkut", url: "https://orkut.com/ivy" }]],
    ["mais de 8", Array.from({ length: 9 }, (_, i) => ({ platform: "site", url: `https://ivy${i}.example` }))],
];
for (const [label, links] of invalidLinks) {
    const res = await call("PUT", "/me/social-links", { token: ivyToken, body: { links } });
    check(`social-links com ${label} → 400`, res.status === 400, `${res.status} ${JSON.stringify(res.body).slice(0, 120)}`);
}

// --- Upload de avatar/banner (sem Storage configurado no teste) -------------

const avatarForm = (bytes, name = "a.png") => {
    const form = new FormData();
    form.append("avatar", new Blob([bytes]), name);
    return form;
};

const avatarNotImage = await call("POST", "/me/avatar", {
    token: ivyToken,
    body: avatarForm(new TextEncoder().encode("isto não é uma imagem, só texto"), "falso.png"),
    raw: true,
});
check(
    "avatar que não é imagem → 400 (mesmo sem Storage)",
    avatarNotImage.status === 400,
    `${avatarNotImage.status} ${JSON.stringify(avatarNotImage.body)}`,
);

const avatarNoStorage = await call("POST", "/me/avatar", {
    token: ivyToken,
    body: avatarForm(pngBytes),
    raw: true,
});
check(
    "avatar válido sem Storage → 503 explicado",
    avatarNoStorage.status === 503 && /configurado/.test(avatarNoStorage.body?.error ?? ""),
    `${avatarNoStorage.status} ${JSON.stringify(avatarNoStorage.body)}`,
);

const avatarTooBig = await call("POST", "/me/avatar", {
    token: ivyToken,
    body: avatarForm(new Uint8Array(1024 * 1024 + 10)),
    raw: true,
});
check(
    "avatar acima de 1MB → 413",
    avatarTooBig.status === 413 && /1MB/.test(avatarTooBig.body?.error ?? ""),
    `${avatarTooBig.status} ${JSON.stringify(avatarTooBig.body)}`,
);

const avatarMissing = await call("POST", "/me/avatar", {
    token: ivyToken,
    body: new FormData(),
    raw: true,
});
check("avatar sem arquivo → 400", avatarMissing.status === 400, String(avatarMissing.status));

const avatarDelete = await call("DELETE", "/me/avatar", { token: ivyToken });
check(
    "DELETE /me/avatar → 200 com avatarUrl null",
    avatarDelete.status === 200 && avatarDelete.body?.user?.avatarUrl === null,
    String(avatarDelete.status),
);

// --- Privacidade do perfil público --------------------------------------------

console.log("\n[Perfil] Público e privacidade");

// A ivy entra na comunidade da alice, publica e comenta, para ter o que listar.
await call("POST", `/communities/${communityId}/join`, { token: ivyToken });
const ivyPost = await call("POST", "/posts", {
    token: ivyToken,
    body: { communityId, title: "Post da Ivy", content: "Conteúdo da Ivy" },
});
await call("POST", `/posts/${ivyPost.body?.post?.postId}/comments`, {
    token: ivyToken,
    body: { content: "Comentário da Ivy" },
});

// Perfil privado (ligado acima) visto pelo bob: só o cartão.
const privateForBob = await call("GET", `/users/${ivyId}`, { token: bobToken });
check(
    "perfil privado para terceiros: só nome, @, avatar e isPrivate",
    privateForBob.status === 200 &&
        privateForBob.body?.user?.isPrivate === true &&
        privateForBob.body.user.username === ivy.username &&
        !("bio" in privateForBob.body.user) &&
        !("stats" in privateForBob.body.user) &&
        !("socialLinks" in privateForBob.body.user),
    JSON.stringify(privateForBob.body),
);

const privateForVisitor = await call("GET", `/users/${ivyId}`);
check(
    "perfil privado para visitante também esconde o conteúdo",
    privateForVisitor.status === 200 && !("bio" in (privateForVisitor.body?.user ?? {})),
);

const privateForOwner = await call("GET", `/users/${ivyId}`, { token: ivyToken });
check(
    "dono vê o próprio perfil privado completo",
    privateForOwner.body?.user?.isOwner === true &&
        privateForOwner.body.user.bio === "Bio de teste" &&
        privateForOwner.body.user.stats?.posts === 1,
    JSON.stringify(privateForOwner.body).slice(0, 200),
);

const privatePostsForBob = await call("GET", `/users/${ivyId}/posts`, { token: bobToken });
check("posts de perfil privado para terceiros → 403", privatePostsForBob.status === 403);
const privateCommentsForBob = await call("GET", `/users/${ivyId}/comments`, { token: bobToken });
check("respostas de perfil privado para terceiros → 403", privateCommentsForBob.status === 403);

await call("PATCH", "/me/settings", { token: ivyToken, body: { isPrivate: false } });

const publicForBob = await call("GET", `/users/${ivyId}`, { token: bobToken });
check(
    "perfil público: bio, contadores e redes sociais",
    publicForBob.body?.user?.isPrivate === false &&
        publicForBob.body.user.isOwner === false &&
        publicForBob.body.user.bio === "Bio de teste" &&
        publicForBob.body.user.stats?.posts === 1 &&
        publicForBob.body.user.stats?.comments === 1 &&
        publicForBob.body.user.stats?.communities === 1 &&
        publicForBob.body.user.socialLinks?.length === 2,
    JSON.stringify(publicForBob.body).slice(0, 240),
);

const ivyPosts = await call("GET", `/users/${ivyId}/posts`);
check(
    "GET /users/:id/posts traz o post com o nome da comunidade",
    ivyPosts.status === 200 &&
        ivyPosts.body?.data?.length === 1 &&
        ivyPosts.body.data[0].title === "Post da Ivy" &&
        ivyPosts.body.data[0].communityName === communityName &&
        ivyPosts.body.pagination?.total === 1,
    JSON.stringify(ivyPosts.body).slice(0, 200),
);

const ivyComments = await call("GET", `/users/${ivyId}/comments`);
check(
    "GET /users/:id/comments traz o post e a comunidade de cada resposta",
    ivyComments.status === 200 &&
        ivyComments.body?.data?.[0]?.content === "Comentário da Ivy" &&
        ivyComments.body.data[0].postTitle === "Post da Ivy" &&
        ivyComments.body.data[0].communityName === communityName,
    JSON.stringify(ivyComments.body).slice(0, 200),
);

const pagedPosts = await call("GET", `/users/${ivyId}/posts?page=2&limit=1`);
check(
    "listagem do perfil é paginada",
    pagedPosts.body?.data?.length === 0 && pagedPosts.body?.pagination?.totalPages === 1,
    JSON.stringify(pagedPosts.body?.pagination),
);

check(
    "usuário inexistente → 404",
    (await call("GET", "/users/00000000-0000-4000-8000-000000000000")).status === 404,
);
check("id inválido → 400", (await call("GET", "/users/nao-e-uuid")).status === 400);

// --- Troca de senha ------------------------------------------------------------

console.log("\n[Perfil] Troca de senha");

const ivyOtherDevice = (
    await call("POST", "/auth/login", {
        body: { identifier: ivy.username, password: ivy.password },
    })
).body?.token;

const wrongCurrent = await call("POST", "/me/password", {
    token: ivyToken,
    body: { currentPassword: "senha-errada", newPassword: "nova456!senha7" },
});
check(
    "senha atual errada → 400 (não 401, para o front não deslogar)",
    wrongCurrent.status === 400 && wrongCurrent.body?.error === "Senha atual incorreta",
    `${wrongCurrent.status} ${JSON.stringify(wrongCurrent.body)}`,
);

const weakNew = await call("POST", "/me/password", {
    token: ivyToken,
    body: { currentPassword: ivy.password, newPassword: "fraca" },
});
check("nova senha fora das regras → 400", weakNew.status === 400, JSON.stringify(weakNew.body).slice(0, 120));

const changed = await call("POST", "/me/password", {
    token: ivyToken,
    body: { currentPassword: ivy.password, newPassword: "nova456!senha7" },
});
check("troca de senha com a atual certa → 204", changed.status === 204, `${changed.status} ${JSON.stringify(changed.body)}`);
check(
    "sessão atual continua válida",
    (await call("GET", "/me", { token: ivyToken })).status === 200,
);
check(
    "outras sessões são revogadas",
    (await call("GET", "/me", { token: ivyOtherDevice })).status === 401,
);
check(
    "senha antiga não entra mais",
    (
        await call("POST", "/auth/login", {
            body: { identifier: ivy.username, password: ivy.password },
        })
    ).status === 401,
);
check(
    "senha nova entra",
    (
        await call("POST", "/auth/login", {
            body: { identifier: ivy.username, password: "nova456!senha7" },
        })
    ).status === 200,
);

// --- Recuperação de senha -------------------------------------------------------

console.log("\n[Auth] Recuperação de senha");
resetRateLimits();

// MAIL_PROVIDER=console (padrão): o hook entrega os e-mails sem ler o log.
const { onMailSent } = await import("../server/lib/mailer.js");
const outbox = [];
onMailSent((mail) => outbox.push(mail));

// O envio é em segundo plano (para o tempo de resposta não revelar contas),
// então o e-mail pode chegar logo depois da resposta.
async function nextMailTo(address, after) {
    for (let i = 0; i < 100; i++) {
        const mail = outbox.slice(after).find((m) => m.to === address);
        if (mail) return mail;
        await new Promise((r) => setTimeout(r, 20));
    }
    return null;
}
const codeOf = (mail) => mail?.text.match(/\b(\d{6})\b/)?.[1] ?? null;

const kate = {
    email: `kate${stamp}@famax.test`,
    username: `kate${stamp}`,
    password: "senha123!forte",
    displayName: "Kate Teste",
    termsAccepted: true,
};
await call("POST", "/auth/register", { body: kate });
const kateOldToken = (
    await call("POST", "/auth/login", {
        body: { identifier: kate.username, password: kate.password },
    })
).body?.token;

const ghostEmail = `ninguem${stamp}@famax.test`;
let mark = outbox.length;
const forgotGhost = await call("POST", "/auth/forgot-password", { body: { email: ghostEmail } });
const forgotKate = await call("POST", "/auth/forgot-password", {
    // Maiúsculas de propósito: o e-mail é comparado sem diferenciar caixa.
    body: { email: kate.email.toUpperCase() },
});
check(
    "forgot-password responde igual com e sem conta",
    forgotGhost.status === 200 &&
        forgotKate.status === 200 &&
        forgotGhost.body?.message === forgotKate.body?.message,
    `${JSON.stringify(forgotGhost.body)} vs ${JSON.stringify(forgotKate.body)}`,
);

const firstMail = await nextMailTo(kate.email, mark);
const firstCode = codeOf(firstMail);
check("e-mail com código de 6 dígitos é enviado", Boolean(firstCode), firstMail?.subject);
check(
    "e-mail inexistente não gera envio",
    !outbox.slice(mark).some((m) => m.to === ghostEmail),
);

const { rows: storedRecovery } = await db.query(
    `SELECT r.recovery_code, r.code_hash
     FROM password_recovery r JOIN users u ON u.user_id = r.user_id
     WHERE u.email = $1 AND r.is_used = FALSE`,
    [kate.email],
);
check(
    "código não fica gravado em claro (só o hash)",
    storedRecovery.length === 1 &&
        storedRecovery[0].recovery_code === null &&
        storedRecovery[0].code_hash?.length === 64 &&
        !storedRecovery[0].code_hash.includes(firstCode),
    JSON.stringify(storedRecovery),
);

// Um código que certamente não é o certo.
const wrongCode = firstCode === "000000" ? "111111" : "000000";
const verifyGhost = await call("POST", "/auth/verify-reset-code", {
    body: { email: ghostEmail, code: wrongCode },
});
const verifyWrong = await call("POST", "/auth/verify-reset-code", {
    body: { email: kate.email, code: wrongCode },
});
check(
    "código errado e e-mail sem conta dão o mesmo erro",
    verifyWrong.status === 400 && verifyWrong.body?.error === verifyGhost.body?.error,
    `${JSON.stringify(verifyWrong.body)} vs ${JSON.stringify(verifyGhost.body)}`,
);
for (let i = 0; i < 4; i++) {
    await call("POST", "/auth/verify-reset-code", { body: { email: kate.email, code: wrongCode } });
}
const verifyAfterBlock = await call("POST", "/auth/verify-reset-code", {
    body: { email: kate.email, code: firstCode },
});
check(
    "depois de 5 erros nem o código certo vale",
    verifyAfterBlock.status === 400,
    JSON.stringify(verifyAfterBlock.body),
);

// Código expirado.
mark = outbox.length;
await call("POST", "/auth/forgot-password", { body: { email: kate.email } });
const secondCode = codeOf(await nextMailTo(kate.email, mark));
await db.query(
    `UPDATE password_recovery SET expires_at = NOW() - INTERVAL '1 minute'
     WHERE email = $1 AND is_used = FALSE`,
    [kate.email],
);
const verifyExpired = await call("POST", "/auth/verify-reset-code", {
    body: { email: kate.email, code: secondCode },
});
check("código expirado → 400", verifyExpired.status === 400, JSON.stringify(verifyExpired.body));

// Fluxo completo.
mark = outbox.length;
await call("POST", "/auth/forgot-password", { body: { email: kate.email } });
const thirdCode = codeOf(await nextMailTo(kate.email, mark));
const verifyOk = await call("POST", "/auth/verify-reset-code", {
    body: { email: kate.email, code: thirdCode },
});
const resetToken = verifyOk.body?.resetToken;
check("código certo devolve resetToken", verifyOk.status === 200 && Boolean(resetToken), JSON.stringify(verifyOk.body));

check(
    "resetToken não serve como sessão",
    (await call("GET", "/me", { token: resetToken })).status === 401,
);
const resetWithLoginToken = await call("POST", "/auth/reset-password", {
    body: { resetToken: kateOldToken, newPassword: "outra789!senha0" },
});
check("token de login não serve como resetToken", resetWithLoginToken.status === 400);

const resetWeak = await call("POST", "/auth/reset-password", {
    body: { resetToken, newPassword: "fraca" },
});
check("nova senha fora das regras → 400", resetWeak.status === 400, JSON.stringify(resetWeak.body));

mark = outbox.length;
const resetOk = await call("POST", "/auth/reset-password", {
    body: { resetToken, newPassword: "outra789!senha0" },
});
check("reset-password troca a senha", resetOk.status === 200, JSON.stringify(resetOk.body));
check(
    "sessões antigas são revogadas após o reset",
    (await call("GET", "/me", { token: kateOldToken })).status === 401,
);
check(
    "senha nova entra e a antiga não",
    (
        await call("POST", "/auth/login", {
            body: { identifier: kate.username, password: "outra789!senha0" },
        })
    ).status === 200 &&
        (
            await call("POST", "/auth/login", {
                body: { identifier: kate.username, password: kate.password },
            })
        ).status === 401,
);
const changedMail = await nextMailTo(kate.email, mark);
check(
    "e-mail avisando da troca é enviado",
    /alterada/.test(changedMail?.subject ?? ""),
    changedMail?.subject,
);

const resetAgain = await call("POST", "/auth/reset-password", {
    body: { resetToken, newPassword: "mais012!senha3" },
});
check("resetToken não serve duas vezes", resetAgain.status === 400, JSON.stringify(resetAgain.body));

// 3 pedidos já feitos para este e-mail nesta janela: o 4º é barrado.
const forgotLimited = await call("POST", "/auth/forgot-password", { body: { email: kate.email } });
check("forgot-password limitado por e-mail → 429", forgotLimited.status === 429, String(forgotLimited.status));

// --- Comunidade completa ----------------------------------------------------------

console.log("\n[Comunidade] Membros, posts e comentários");
resetRateLimits();

// Comunidade nova da alice, com o bob como membro comum.
const c6 = await call("POST", "/communities", {
    token: aliceToken,
    body: { name: `Completa ${stamp}`, categoryId, description: "Descrição completa" },
});
const c6Id = c6.body?.community?.communityId;
await call("POST", `/communities/${c6Id}/join`, { token: bobToken });

const c6AsBob = await call("GET", `/communities/${c6Id}`, { token: bobToken });
check(
    "GET /communities/:id traz descrição, capa, dono, categoria e my_role",
    c6AsBob.body?.community?.description === "Descrição completa" &&
        "coverImageUrl" in (c6AsBob.body?.community ?? {}) &&
        c6AsBob.body.community.ownerId === aliceReg.body?.user?.userId &&
        c6AsBob.body.community.categoryId === categoryId &&
        c6AsBob.body.community.myRole === "member",
    JSON.stringify(c6AsBob.body?.community).slice(0, 240),
);
check(
    "my_role é null para visitante",
    (await call("GET", `/communities/${c6Id}`)).body?.community?.myRole === null,
);

// leave
const ownerLeave = await call("POST", `/communities/${c6Id}/leave`, { token: aliceToken });
check("dono não pode sair → 409", ownerLeave.status === 409, JSON.stringify(ownerLeave.body));
const carolJoinLeave = await call("POST", `/communities/${c6Id}/join`, { token: carolToken });
const carolLeave = await call("POST", `/communities/${c6Id}/leave`, { token: carolToken });
check(
    "membro sai da comunidade",
    carolJoinLeave.status === 200 &&
        carolLeave.status === 200 &&
        (await call("GET", `/communities/${c6Id}`, { token: carolToken })).body?.community?.myRole === null,
);

// Posts: editar e excluir só pelo autor.
const subcats = c6AsBob.body?.categories ?? [];
const bobPost6 = await call("POST", "/posts", {
    token: bobToken,
    body: { communityId: c6Id, title: "Post do Bob", content: "Original" },
});
const bobPost6Id = bobPost6.body?.post?.postId;
check(
    "post novo não aparece como editado",
    bobPost6.body?.post?.editedAt === null,
    JSON.stringify(bobPost6.body?.post).slice(0, 160),
);

// Curtir mexe em posts.updated_at (trigger), mas não pode marcar "editado".
await call("POST", `/posts/${bobPost6Id}/reactions`, { token: aliceToken });
const afterLike = await call("GET", `/communities/${c6Id}/posts`);
check(
    "curtida não marca o post como editado",
    afterLike.body?.data?.[0]?.editedAt === null,
    JSON.stringify(afterLike.body?.data?.[0]).slice(0, 160),
);

const editByOther = await call("PATCH", `/posts/${bobPost6Id}`, {
    token: aliceToken,
    body: { title: "Sequestrado" },
});
check("editar post alheio → 404", editByOther.status === 404, String(editByOther.status));

const editOwn = await call("PATCH", `/posts/${bobPost6Id}`, {
    token: bobToken,
    body: { title: "Post do Bob (editado)", content: "Novo conteúdo", communityCategoryId: subcats[1]?.communityCategoryId },
});
check(
    "autor edita título, conteúdo e subcategoria; edited_at preenchido",
    editOwn.status === 200 &&
        editOwn.body?.post?.title === "Post do Bob (editado)" &&
        editOwn.body.post.content === "Novo conteúdo" &&
        editOwn.body.post.categoryName === subcats[1]?.name &&
        editOwn.body.post.editedAt !== null &&
        editOwn.body.post.likedByMe === false,
    JSON.stringify(editOwn.body).slice(0, 200),
);

const editForeignCategory = await call("PATCH", `/posts/${bobPost6Id}`, {
    token: bobToken,
    body: { communityCategoryId: subCategoryId },
});
check(
    "editar para subcategoria de outra comunidade → 400",
    editForeignCategory.status === 400,
    JSON.stringify(editForeignCategory.body),
);

// Filtro unanswered ("Ajudar os outros"): perguntas sem resposta aceita. A
// Alice aceita a resposta do Bob; o post do Bob segue sem resposta aceita.
const alicePost6 = await call("POST", "/posts", {
    token: aliceToken,
    body: { communityId: c6Id, title: "Post da Alice", content: "Vai ter comentário" },
});
const alicePost6Id = alicePost6.body?.post?.postId;
const bobAnswer6 = await call("POST", `/posts/${alicePost6Id}/comments`, {
    token: bobToken,
    body: { content: "Respondendo a Alice" },
});
await call("PUT", `/posts/${alicePost6Id}/resolution`, {
    token: aliceToken,
    body: { commentId: bobAnswer6.body?.comment?.commentId },
});
const unanswered = await call("GET", `/communities/${c6Id}/posts?unanswered=true`);
check(
    "filtro unanswered traz só posts sem resposta aceita",
    unanswered.status === 200 &&
        unanswered.body?.data?.length === 1 &&
        unanswered.body.data[0].postId === bobPost6Id &&
        unanswered.body.pagination?.total === 1,
    JSON.stringify(unanswered.body?.pagination),
);

// Comentários aninhados, edição e "[comentário removido]".
const rootComment = await call("POST", `/posts/${alicePost6Id}/comments`, {
    token: aliceToken,
    body: { content: "Raiz da conversa" },
});
const rootId = rootComment.body?.comment?.commentId;
const reply1 = await call("POST", `/posts/${alicePost6Id}/comments`, {
    token: bobToken,
    body: { content: "Resposta nível 1", parentCommentId: rootId },
});
const reply2 = await call("POST", `/posts/${alicePost6Id}/comments`, {
    token: aliceToken,
    body: { content: "Resposta nível 2", parentCommentId: reply1.body?.comment?.commentId },
});
check(
    "resposta volta com parent_comment_id",
    reply2.status === 201 && reply2.body?.comment?.parentCommentId === reply1.body?.comment?.commentId,
);

const tree = await call("GET", `/posts/${alicePost6Id}/comments`);
const byId = new Map((tree.body?.data ?? []).map((c) => [c.commentId, c]));
check(
    "comentários vêm planos com parent_comment_id e replies_count",
    tree.status === 200 &&
        byId.get(rootId)?.repliesCount === 1 &&
        byId.get(reply1.body?.comment?.commentId)?.repliesCount === 1 &&
        byId.get(reply2.body?.comment?.commentId)?.parentCommentId === reply1.body?.comment?.commentId,
    JSON.stringify(tree.body).slice(0, 240),
);

const editCommentOther = await call("PATCH", `/comments/${rootId}`, {
    token: bobToken,
    body: { content: "Não é meu" },
});
check("editar comentário alheio → 404", editCommentOther.status === 404);
const editComment = await call("PATCH", `/comments/${rootId}`, {
    token: aliceToken,
    body: { content: "Raiz editada" },
});
check(
    "autor edita o comentário",
    editComment.status === 200 &&
        editComment.body?.comment?.content === "Raiz editada" &&
        editComment.body.comment.editedAt !== null,
    JSON.stringify(editComment.body).slice(0, 160),
);

await call("DELETE", `/comments/${rootId}`, { token: aliceToken });
const treeAfterDelete = await call("GET", `/posts/${alicePost6Id}/comments`);
const removedRoot = treeAfterDelete.body?.data?.find((c) => c.commentId === rootId);
check(
    "comentário apagado com respostas vira [removido] sem autor nem texto",
    removedRoot?.isDeleted === true &&
        removedRoot.content === null &&
        removedRoot.authorId === null &&
        treeAfterDelete.body.data.some((c) => c.commentId === reply2.body?.comment?.commentId),
    JSON.stringify(removedRoot),
);

// Folha apagada some de vez.
const leaf = await call("POST", `/posts/${alicePost6Id}/comments`, {
    token: bobToken,
    body: { content: "Folha que será apagada" },
});
await call("DELETE", `/comments/${leaf.body?.comment?.commentId}`, { token: bobToken });
const treeLeaf = await call("GET", `/posts/${alicePost6Id}/comments`);
check(
    "comentário apagado sem respostas some da listagem",
    !treeLeaf.body?.data?.some((c) => c.commentId === leaf.body?.comment?.commentId),
);

// Paginação por cursor nas raízes: 3 raízes vivas a mais, limite 2.
for (const text of ["Raiz A", "Raiz B", "Raiz C"]) {
    await call("POST", `/posts/${alicePost6Id}/comments`, { token: bobToken, body: { content: text } });
}
const page1 = await call("GET", `/posts/${alicePost6Id}/comments?limit=2`);
const page2 = await call(
    "GET",
    `/posts/${alicePost6Id}/comments?limit=2&cursor=${encodeURIComponent(page1.body?.nextCursor ?? "")}`,
);
const rootsOf = (body) => (body?.data ?? []).filter((c) => c.parentCommentId === null).map((c) => c.commentId);
check(
    "comentários paginam por cursor sem repetir raízes",
    page1.body?.nextCursor &&
        rootsOf(page1.body).length === 2 &&
        rootsOf(page2.body).length >= 1 &&
        !rootsOf(page2.body).some((id) => rootsOf(page1.body).includes(id)),
    `${JSON.stringify(rootsOf(page1.body))} / ${JSON.stringify(rootsOf(page2.body))}`,
);
check(
    "cursor inválido → 400",
    (await call("GET", `/posts/${alicePost6Id}/comments?cursor=lixo`)).status === 400,
);

// Excluir post: o autor (ou a moderação — ver [Moderação]); quem não tem
// papel recebe 404. Some da listagem e bloqueia comentário e like.
const deleteByOther = await call("DELETE", `/posts/${bobPost6Id}`, { token: daveToken });
check("excluir post alheio → 404", deleteByOther.status === 404);
const deleteOwnPost = await call("DELETE", `/posts/${bobPost6Id}`, { token: bobToken });
check("autor exclui o próprio post → 204", deleteOwnPost.status === 204);
const listAfterDelete = await call("GET", `/communities/${c6Id}/posts`);
check(
    "post excluído some da listagem",
    !listAfterDelete.body?.data?.some((p) => p.postId === bobPost6Id),
);
check(
    "post excluído bloqueia comentário",
    (await call("POST", `/posts/${bobPost6Id}/comments`, { token: aliceToken, body: { content: "oi" } }))
        .status === 404,
);
check(
    "post excluído bloqueia like",
    (await call("POST", `/posts/${bobPost6Id}/reactions`, { token: aliceToken })).status === 404,
);
check(
    "comentários de post excluído → 404",
    (await call("GET", `/posts/${bobPost6Id}/comments`)).status === 404,
);

console.log("\n[Comunidade] Edição e exclusão pelo dono");

const editCommunityByMember = await call("PATCH", `/communities/${c6Id}`, {
    token: bobToken,
    body: { description: "Tentando editar" },
});
check("membro não edita a comunidade → 403", editCommunityByMember.status === 403);

const editCommunity = await call("PATCH", `/communities/${c6Id}`, {
    token: aliceToken,
    body: { name: `Completa Editada ${stamp}`, description: "" },
});
check(
    "dono edita nome e apaga a descrição",
    editCommunity.status === 200 &&
        editCommunity.body?.community?.name === `Completa Editada ${stamp}` &&
        editCommunity.body.community.description === null,
    JSON.stringify(editCommunity.body),
);

const editDuplicate = await call("PATCH", `/communities/${c6Id}`, {
    token: aliceToken,
    body: { name: communityName },
});
check("renomear para nome já usado → 409", editDuplicate.status === 409);

const editNotImage = new FormData();
editNotImage.append("cover", new Blob([new TextEncoder().encode("não é imagem")]), "x.png");
const editCoverNoStorage = await call("PATCH", `/communities/${c6Id}`, {
    token: aliceToken,
    body: editNotImage,
    raw: true,
});
check(
    "capa nova sem Storage configurado → 503 previsível",
    editCoverNoStorage.status === 503,
    `${editCoverNoStorage.status} ${JSON.stringify(editCoverNoStorage.body)}`,
);

const deleteByMember = await call("DELETE", `/communities/${c6Id}`, {
    token: bobToken,
    body: { confirmName: `Completa Editada ${stamp}` },
});
check("membro não exclui a comunidade → 403", deleteByMember.status === 403);

const deleteWrongName = await call("DELETE", `/communities/${c6Id}`, {
    token: aliceToken,
    body: { confirmName: "nome errado" },
});
check("excluir sem o nome certo → 400", deleteWrongName.status === 400);

const deleteCommunity = await call("DELETE", `/communities/${c6Id}`, {
    token: aliceToken,
    body: { confirmName: `Completa Editada ${stamp}` },
});
check("dono exclui a comunidade → 204", deleteCommunity.status === 204);
check(
    "comunidade excluída some (404) e sai do feed",
    (await call("GET", `/communities/${c6Id}`)).status === 404 &&
        !(await call("GET", "/communities?limit=50")).body?.data?.some((c) => c.communityId === c6Id),
);

// O nome de uma comunidade excluída pode ser reutilizado.
const reuseName = await call("POST", "/communities", {
    token: aliceToken,
    body: { name: `Completa Editada ${stamp}`, categoryId },
});
check("nome de comunidade excluída pode ser reutilizado", reuseName.status === 201, JSON.stringify(reuseName.body));

// --- Busca e página do post ----------------------------------------------------

console.log("\n[Busca] Comunidades, usuários e posts");
resetRateLimits();

// Dados com termos únicos desta execução, para não depender do resto da suíte.
const tag = `zq${stamp}`.slice(0, 14);
const searchCommunity = await call("POST", "/communities", {
    token: aliceToken,
    body: { name: `Torrefação ${tag}`, categoryId },
});
const searchCommunityId = searchCommunity.body?.community?.communityId;
const searchPost = await call("POST", "/posts", {
    token: aliceToken,
    body: {
        communityId: searchCommunityId,
        title: `Moagem para espresso ${tag}`,
        content: "Comparando moedores cônicos e planos para extração equilibrada.",
    },
});
const searchPostId = searchPost.body?.post?.postId;

const sCommunities = await call("GET", `/search?q=${encodeURIComponent(`torrefa ${tag}`.slice(0, 7))}&type=communities`);
check(
    "busca de comunidades acha por pedaço do nome",
    sCommunities.status === 200 &&
        sCommunities.body?.results?.communities?.data?.some((c) => c.communityId === searchCommunityId),
    JSON.stringify(sCommunities.body).slice(0, 200),
);

// Tolerância a erro de digitação (pg_trgm): uma letra trocada no nome único.
const typo = `${tag.slice(0, -1)}x`;
const sTypo = await call("GET", `/search?q=${encodeURIComponent(`Torrefação ${typo}`)}&type=communities`);
check(
    "busca de comunidades tolera erro de digitação",
    sTypo.body?.results?.communities?.data?.[0]?.communityId === searchCommunityId,
    JSON.stringify(sTypo.body?.results?.communities?.data?.map((c) => c.name)),
);

const sPosts = await call("GET", `/search?q=${encodeURIComponent(`moedor ${tag}`)}&type=posts`);
check(
    "busca de posts por prefixo de palavra (full-text)",
    sPosts.status === 200 &&
        sPosts.body?.results?.posts?.data?.[0]?.postId === searchPostId &&
        sPosts.body.results.posts.data[0].communityName === `Torrefação ${tag}`,
    JSON.stringify(sPosts.body).slice(0, 200),
);

const sOperators = await call("GET", `/search?q=${encodeURIComponent("' | & !:* ()")}&type=posts`);
check(
    "operadores de tsquery digitados não quebram a busca",
    sOperators.status === 200 || sOperators.status === 400,
    String(sOperators.status),
);

const sAll = await call("GET", `/search?q=${encodeURIComponent(tag)}`);
check(
    "type=all devolve as três seções",
    sAll.status === 200 &&
        ["communities", "users", "posts"].every((k) => Array.isArray(sAll.body?.results?.[k]?.data)),
    JSON.stringify(sAll.body).slice(0, 200),
);

check("busca com 1 caractere → 400", (await call("GET", "/search?q=a")).status === 400);
check("tipo de busca inválido → 400", (await call("GET", `/search?q=${tag}&type=tudo`)).status === 400);

// Privacidade: o mesmo critério da busca do chat.
const lena = {
    email: `lena${stamp}@famax.test`,
    username: `lena${tag}`,
    password: "senha123!forte",
    displayName: "Lena Privada",
    termsAccepted: true,
    isPrivate: true,
};
const lenaReg = await call("POST", "/auth/register", { body: lena });
const lenaToken = lenaReg.body?.token;
const findLena = (body) =>
    body?.results?.users?.data?.some((u) => u.userId === lenaReg.body?.user?.userId) ?? false;

check(
    "perfil privado não aparece para visitante",
    !findLena((await call("GET", `/search?q=lena${tag}&type=users`)).body),
);
check(
    "perfil privado não aparece para quem não conversa com ele",
    !findLena((await call("GET", `/search?q=lena${tag}&type=users`, { token: bobToken })).body),
);
check(
    "o dono encontra o próprio perfil privado",
    findLena((await call("GET", `/search?q=lena${tag}&type=users`, { token: lenaToken })).body),
);
await call("POST", "/conversations", { token: bobToken, body: { userId: lenaReg.body?.user?.userId } });
check(
    "perfil privado aparece para quem já conversa com ele",
    findLena((await call("GET", `/search?q=lena${tag}&type=users`, { token: bobToken })).body),
);

console.log("\n[Post] Página individual");

const singlePost = await call("GET", `/posts/${searchPostId}`, { token: aliceToken });
check(
    "GET /posts/:id traz o post com a comunidade e liked_by_me",
    singlePost.status === 200 &&
        singlePost.body?.post?.postId === searchPostId &&
        singlePost.body.post.communityId === searchCommunityId &&
        singlePost.body.post.communityName === `Torrefação ${tag}` &&
        singlePost.body.post.likedByMe === false,
    JSON.stringify(singlePost.body).slice(0, 200),
);
check(
    "GET /posts/:id com id inválido → 400",
    (await call("GET", "/posts/nao-e-uuid")).status === 400,
);

await call("DELETE", `/posts/${searchPostId}`, { token: aliceToken });
check(
    "GET /posts/:id de post excluído → 404",
    (await call("GET", `/posts/${searchPostId}`)).status === 404,
);
const sAfterDelete = await call("GET", `/search?q=${encodeURIComponent(`moedor ${tag}`)}&type=posts`);
check(
    "post excluído não aparece na busca",
    sAfterDelete.status === 200 && sAfterDelete.body?.results?.posts?.total === 0,
    JSON.stringify(sAfterDelete.body?.results?.posts),
);

console.log("\n[Moderação] Papéis, banimentos e denúncias");
resetRateLimits();

// Elenco próprio: dona, moderador, dois membros e um admin do site.
async function newUser(name) {
    const reg = await call("POST", "/auth/register", {
        body: {
            email: `${name}${stamp}@famax.test`,
            username: `${name}${stamp}`.slice(0, 30),
            password: "senha123!forte",
            displayName: name,
            termsAccepted: true,
        },
    });
    return { token: reg.body?.token, id: reg.body?.user?.userId };
}
const owner = await newUser("dona");
const mod = await newUser("mode");
const member = await newUser("membro");
const troll = await newUser("troll");
const admin = await newUser("admin");
await db.query("UPDATE users SET is_admin = true WHERE user_id = $1", [admin.id]);

const modCommunity = await call("POST", "/communities", {
    token: owner.token,
    body: { name: `Moderada ${stamp}`, categoryId },
});
const modCid = modCommunity.body?.community?.communityId;
for (const u of [mod, member, troll]) {
    await call("POST", `/communities/${modCid}/join`, { token: u.token });
}

// --- Papéis ------------------------------------------------------------------

check(
    "membro comum não promove ninguém → 403",
    (await call("PATCH", `/communities/${modCid}/members/${troll.id}`, {
        token: member.token,
        body: { role: "moderator" },
    })).status === 403,
);
const promote = await call("PATCH", `/communities/${modCid}/members/${mod.id}`, {
    token: owner.token,
    body: { role: "moderator" },
});
check(
    "dono promove a moderador",
    promote.status === 200 && promote.body?.member?.role === "moderator",
    JSON.stringify(promote.body),
);
check(
    "papel inválido → 400",
    (await call("PATCH", `/communities/${modCid}/members/${member.id}`, {
        token: owner.token,
        body: { role: "owner" },
    })).status === 400,
);

const members = await call("GET", `/communities/${modCid}/members`);
check(
    "lista de membros: dono primeiro, depois moderador, com data de entrada",
    members.status === 200 &&
        members.body?.data?.[0]?.role === "owner" &&
        members.body.data[1]?.role === "moderator" &&
        members.body.data[1].userId === mod.id &&
        Boolean(members.body.data[0].joinedAt) &&
        members.body.pagination.total === 4,
    JSON.stringify(members.body).slice(0, 200),
);
const onlyMods = await call("GET", `/communities/${modCid}/members?role=moderator`);
check(
    "filtro de membros por papel",
    onlyMods.body?.data?.length === 1 && onlyMods.body.data[0].userId === mod.id,
    JSON.stringify(onlyMods.body).slice(0, 200),
);

// --- Remoção de conteúdo ------------------------------------------------------

const trollPost = await call("POST", "/posts", {
    token: troll.token,
    body: { communityId: modCid, title: "Post problemático", content: "conteúdo ruim" },
});
const trollPostId = trollPost.body?.post?.postId;
check(
    "post traz o papel do autor e de quem vê",
    trollPost.body?.post?.authorRole === "member" && trollPost.body.post.viewerRole === "member",
    JSON.stringify(trollPost.body?.post).slice(0, 200),
);
const ownerPost = await call("POST", "/posts", {
    token: owner.token,
    body: { communityId: modCid, title: "Aviso da dona", content: "bem-vindos" },
});
const ownerPostId = ownerPost.body?.post?.postId;

check(
    "membro comum não remove post de outro",
    (await call("DELETE", `/posts/${trollPostId}`, { token: member.token })).status === 404,
);
check(
    "moderador não remove post do dono → 403",
    (await call("DELETE", `/posts/${ownerPostId}`, { token: mod.token })).status === 403,
);

const trollComment = await call("POST", `/posts/${ownerPostId}/comments`, {
    token: troll.token,
    body: { content: "comentário ofensivo" },
});
const trollCommentId = trollComment.body?.comment?.commentId;
check(
    "comentário traz o papel do autor",
    trollComment.body?.comment?.authorRole === "member",
    JSON.stringify(trollComment.body).slice(0, 200),
);
const modComment = await call("DELETE", `/comments/${trollCommentId}`, { token: mod.token });
const { rows: commentRow } = await db.query(
    "SELECT deleted_by FROM comments WHERE comment_id = $1",
    [trollCommentId],
);
check(
    "moderador remove comentário de membro e deleted_by registra quem foi",
    modComment.status === 204 && commentRow[0]?.deleted_by === mod.id,
    `${modComment.status} ${JSON.stringify(commentRow)}`,
);

// --- Denúncias ---------------------------------------------------------------

const report1 = await call("POST", "/reports", {
    token: member.token,
    body: { targetType: "post", targetId: trollPostId, reason: "Spam — propaganda" },
});
check("membro denuncia post", report1.status === 201, JSON.stringify(report1.body));
const reportDup = await call("POST", "/reports", {
    token: member.token,
    body: { targetType: "post", targetId: trollPostId, reason: "de novo" },
});
check("denúncia duplicada pendente → 409", reportDup.status === 409, JSON.stringify(reportDup.body));
check(
    "não denuncia o próprio conteúdo → 400",
    (await call("POST", "/reports", {
        token: troll.token,
        body: { targetType: "post", targetId: trollPostId, reason: "teste" },
    })).status === 400,
);
check(
    "denúncia de alvo inexistente → 404",
    (await call("POST", "/reports", {
        token: member.token,
        body: { targetType: "comment", targetId: trollPostId, reason: "não existe" },
    })).status === 404,
);
const report2 = await call("POST", "/reports", {
    token: admin.token,
    body: { targetType: "post", targetId: trollPostId, reason: "Assédio" },
});
const userReport = await call("POST", "/reports", {
    token: member.token,
    body: { targetType: "user", targetId: troll.id, reason: "Perfil falso" },
});
check("denúncia de usuário criada", userReport.status === 201, JSON.stringify(userReport.body));

check(
    "membro comum não vê a fila da comunidade → 403",
    (await call("GET", `/communities/${modCid}/reports`, { token: member.token })).status === 403,
);
const queue = await call("GET", `/communities/${modCid}/reports`, { token: mod.token });
check(
    "fila da comunidade traz as denúncias abertas com o alvo resolvido",
    queue.status === 200 &&
        queue.body?.pagination?.total === 2 &&
        queue.body.data.every((r) => r.postTitle === "Post problemático" && r.authorId === troll.id) &&
        !queue.body.data.some((r) => r.targetType === "user"),
    JSON.stringify(queue.body).slice(0, 300),
);

const reviewing = await call("PATCH", `/reports/${report1.body?.report?.reportId}`, {
    token: mod.token,
    body: { status: "reviewing" },
});
check(
    "marcar em análise",
    reviewing.status === 200 && reviewing.body?.report?.status === "reviewing",
    JSON.stringify(reviewing.body).slice(0, 200),
);
check(
    "ação sem resolver → 400",
    (await call("PATCH", `/reports/${report1.body?.report?.reportId}`, {
        token: mod.token,
        body: { status: "reviewing", action: "remove_content" },
    })).status === 400,
);
check(
    "membro comum não resolve denúncia → 403",
    (await call("PATCH", `/reports/${report1.body?.report?.reportId}`, {
        token: member.token,
        body: { status: "dismissed" },
    })).status === 403,
);

const resolved = await call("PATCH", `/reports/${report1.body?.report?.reportId}`, {
    token: mod.token,
    body: { status: "resolved", action: "ban_author", banDays: 7 },
});
check(
    "resolver banindo o autor",
    resolved.status === 200 &&
        resolved.body?.report?.status === "resolved" &&
        resolved.body.report.resolution === "ban_author",
    JSON.stringify(resolved.body).slice(0, 200),
);
const queueAfter = await call("GET", `/communities/${modCid}/reports`, { token: mod.token });
check(
    "encerrar fecha as outras denúncias abertas do mesmo alvo",
    queueAfter.body?.pagination?.total === 0,
    JSON.stringify(queueAfter.body?.data?.map((r) => r.status)),
);
const closedQueue = await call("GET", `/communities/${modCid}/reports?status=resolved`, {
    token: owner.token,
});
check(
    "filtro por status mostra as resolvidas",
    closedQueue.body?.pagination?.total === 2 &&
        closedQueue.body.data.some((r) => r.reportId === report2.body?.report?.reportId),
    JSON.stringify(closedQueue.body).slice(0, 200),
);
check(
    "denúncia encerrada não é resolvida de novo → 409",
    (await call("PATCH", `/reports/${report1.body?.report?.reportId}`, {
        token: mod.token,
        body: { status: "dismissed" },
    })).status === 409,
);

// --- Banimento ---------------------------------------------------------------

const trollCommunity = await call("GET", `/communities/${modCid}`, { token: troll.token });
check(
    "banido sai dos membros e a comunidade avisa do ban",
    trollCommunity.body?.community?.myRole === null &&
        trollCommunity.body.community.isBanned === true &&
        Boolean(trollCommunity.body.community.myBanExpiresAt),
    JSON.stringify(trollCommunity.body?.community).slice(0, 300),
);
check(
    "banido não entra de novo → 403",
    (await call("POST", `/communities/${modCid}/join`, { token: troll.token })).status === 403,
);
check(
    "banido não posta → 403",
    (await call("POST", "/posts", {
        token: troll.token,
        body: { communityId: modCid, title: "Voltei", content: "oi" },
    })).status === 403,
);
check(
    "banido não comenta → 403",
    (await call("POST", `/posts/${ownerPostId}/comments`, {
        token: troll.token,
        body: { content: "voltei" },
    })).status === 403,
);
// Mesmo que volte a constar como membro (corrida), o ban ainda barra a escrita.
await db.query(
    `INSERT INTO community_members (membership_id, user_id, community_id, role)
     VALUES (gen_random_uuid(), $1, $2, 'member')`,
    [troll.id, modCid],
);
check(
    "ban vale mesmo com linha de membro → 403",
    (await call("POST", "/posts", {
        token: troll.token,
        body: { communityId: modCid, title: "Voltei", content: "oi" },
    })).status === 403,
);
await db.query("DELETE FROM community_members WHERE user_id = $1 AND community_id = $2", [
    troll.id,
    modCid,
]);

const bans = await call("GET", `/communities/${modCid}/bans`, { token: mod.token });
check(
    "lista de bans para a moderação",
    bans.status === 200 && bans.body?.data?.[0]?.userId === troll.id,
    JSON.stringify(bans.body).slice(0, 200),
);
check(
    "moderador não bane o dono → 403",
    (await call("POST", `/communities/${modCid}/bans/${owner.id}`, { token: mod.token, body: {} })).status === 403,
);
check(
    "membro comum não bane → 403",
    (await call("POST", `/communities/${modCid}/bans/${mod.id}`, { token: member.token, body: {} })).status === 403,
);
check(
    "desbanir",
    (await call("DELETE", `/communities/${modCid}/bans/${troll.id}`, { token: mod.token })).status === 204,
);
check(
    "desbanido pode entrar de novo",
    (await call("POST", `/communities/${modCid}/join`, { token: troll.token })).status === 200,
);

const directBan = await call("POST", `/communities/${modCid}/bans/${troll.id}`, {
    token: owner.token,
    body: { reason: "reincidente" },
});
check(
    "dono bane direto, permanente (sem prazo)",
    directBan.status === 201 && directBan.body?.ban?.expiresAt === null,
    JSON.stringify(directBan.body),
);

// Remover conteúdo pela denúncia.
const memberPost = await call("POST", "/posts", {
    token: member.token,
    body: { communityId: modCid, title: "Post fora do tema", content: "nada a ver" },
});
const memberPostId = memberPost.body?.post?.postId;
const report3 = await call("POST", "/reports", {
    token: mod.token,
    body: { targetType: "post", targetId: memberPostId, reason: "Fora do tema" },
});
const removeVia = await call("PATCH", `/reports/${report3.body?.report?.reportId}`, {
    token: owner.token,
    body: { status: "resolved", action: "remove_content" },
});
const { rows: removedRow } = await db.query("SELECT deleted_by FROM posts WHERE post_id = $1", [
    memberPostId,
]);
check(
    "resolver removendo o conteúdo apaga o post (deleted_by = quem resolveu)",
    removeVia.status === 200 &&
        removeVia.body?.report?.targetDeleted === true &&
        removedRow[0]?.deleted_by === owner.id,
    `${removeVia.status} ${JSON.stringify(removeVia.body).slice(0, 150)}`,
);

// --- Admin -------------------------------------------------------------------

check(
    "não-admin recebe 403 na fila do admin",
    (await call("GET", "/admin/reports", { token: owner.token })).status === 403,
);
const adminQueue = await call("GET", "/admin/reports", { token: admin.token });
check(
    "admin vê as denúncias de usuário",
    adminQueue.status === 200 &&
        adminQueue.body?.data?.some((r) => r.targetType === "user" && r.authorId === troll.id) &&
        adminQueue.body.data.every((r) => r.targetType === "user"),
    JSON.stringify(adminQueue.body).slice(0, 200),
);
check(
    "moderador não resolve denúncia de usuário → 403",
    (await call("PATCH", `/reports/${userReport.body?.report?.reportId}`, {
        token: mod.token,
        body: { status: "dismissed" },
    })).status === 403,
);
const adminDismiss = await call("PATCH", `/reports/${userReport.body?.report?.reportId}`, {
    token: admin.token,
    body: { status: "dismissed" },
});
check(
    "admin descarta denúncia de usuário",
    adminDismiss.status === 200 && adminDismiss.body?.report?.status === "dismissed",
    JSON.stringify(adminDismiss.body).slice(0, 200),
);
check(
    "GET /me informa isAdmin",
    (await call("GET", "/me", { token: admin.token })).body?.user?.isAdmin === true &&
        (await call("GET", "/me", { token: owner.token })).body?.user?.isAdmin === false,
);

// --- Regras e transferência --------------------------------------------------

const rules = await call("PATCH", `/communities/${modCid}`, {
    token: owner.token,
    body: { rules: "1. Respeito\n2. Sem spam" },
});
check(
    "dono edita as regras",
    rules.status === 200 && rules.body?.community?.rules === "1. Respeito\n2. Sem spam",
    JSON.stringify(rules.body).slice(0, 200),
);
check(
    "regras aparecem na comunidade",
    (await call("GET", `/communities/${modCid}`)).body?.community?.rules === "1. Respeito\n2. Sem spam",
);

check(
    "transferência sem o nome certo → 400",
    (await call("POST", `/communities/${modCid}/transfer`, {
        token: owner.token,
        body: { userId: mod.id, confirmName: "errado" },
    })).status === 400,
);
check(
    "moderador não transfere → 403",
    (await call("POST", `/communities/${modCid}/transfer`, {
        token: mod.token,
        body: { userId: mod.id, confirmName: `Moderada ${stamp}` },
    })).status === 403,
);
const transfer = await call("POST", `/communities/${modCid}/transfer`, {
    token: owner.token,
    body: { userId: mod.id, confirmName: `Moderada ${stamp}` },
});
const afterTransfer = await call("GET", `/communities/${modCid}`, { token: owner.token });
check(
    "transferência: novo dono e o antigo vira moderador",
    transfer.status === 200 &&
        afterTransfer.body?.community?.ownerId === mod.id &&
        afterTransfer.body.community.myRole === "moderator",
    JSON.stringify(afterTransfer.body?.community).slice(0, 200),
);
check(
    "antigo dono pode sair depois de transferir",
    (await call("POST", `/communities/${modCid}/leave`, { token: owner.token })).status === 200,
);

console.log("\n[Notificações]");
resetRateLimits();

const nAuthor = await newUser("nautor");
const nFan = await newUser("nfa");
const nThird = await newUser("nterc");
const nCommunity = await call("POST", "/communities", {
    token: nAuthor.token,
    body: { name: `Avisos ${stamp}`, categoryId },
});
const nCid = nCommunity.body?.community?.communityId;
await call("POST", `/communities/${nCid}/join`, { token: nFan.token });
await call("POST", `/communities/${nCid}/join`, { token: nThird.token });

const nPost = await call("POST", "/posts", {
    token: nAuthor.token,
    body: { communityId: nCid, title: "Post com avisos", content: "conteúdo" },
});
const nPostId = nPost.body?.post?.postId;

const notifsOf = async (u, query = "") => (await call("GET", `/notifications${query}`, { token: u.token })).body;
const unreadOf = async (u) => (await call("GET", "/notifications/unread-count", { token: u.token })).body?.unread;

check("sem notificações no começo", (await unreadOf(nAuthor)) === 0);
check("rota exige login", (await call("GET", "/notifications")).status === 401);

// --- Comentário e resposta --------------------------------------------------

const fanComment = await call("POST", `/posts/${nPostId}/comments`, {
    token: nFan.token,
    body: { content: "Ótimo post!" },
});
const fanCommentId = fanComment.body?.comment?.commentId;
let authorList = await notifsOf(nAuthor);
check(
    "comentar no post avisa o autor (post_comment)",
    authorList?.data?.length === 1 &&
        authorList.data[0].type === "post_comment" &&
        authorList.data[0].actorId === nFan.id &&
        authorList.data[0].postId === nPostId &&
        authorList.data[0].commentId === fanCommentId &&
        authorList.data[0].postTitle === "Post com avisos" &&
        authorList.data[0].commentExcerpt === "Ótimo post!" &&
        authorList.unread === 1,
    JSON.stringify(authorList).slice(0, 300),
);
check("quem comentou não recebe aviso", (await unreadOf(nFan)) === 0);

await call("POST", `/posts/${nPostId}/comments`, {
    token: nAuthor.token,
    body: { content: "comentário no próprio post" },
});
check("comentar no próprio post não avisa ninguém", (await unreadOf(nAuthor)) === 1);

await call("POST", `/posts/${nPostId}/comments`, {
    token: nAuthor.token,
    body: { content: "Obrigado!", parentCommentId: fanCommentId },
});
const fanList = await notifsOf(nFan);
check(
    "resposta avisa quem foi respondido (comment_reply)",
    fanList?.data?.length === 1 &&
        fanList.data[0].type === "comment_reply" &&
        fanList.data[0].actorId === nAuthor.id,
    JSON.stringify(fanList).slice(0, 200),
);
check("o autor do post que respondeu não é avisado", (await unreadOf(nAuthor)) === 1);

await call("POST", `/posts/${nPostId}/comments`, {
    token: nThird.token,
    body: { content: "Concordo", parentCommentId: fanCommentId },
});
check(
    "resposta de terceiro avisa o respondido e o autor do post",
    (await unreadOf(nFan)) === 2 && (await notifsOf(nAuthor)).data[0].type === "post_comment",
);

// --- Curtidas agrupadas ------------------------------------------------------

await call("POST", `/posts/${nPostId}/reactions`, { token: nAuthor.token });
check("curtir o próprio post não avisa", !(await notifsOf(nAuthor)).data.some((n) => n.type === "post_like"));
await call("POST", `/posts/${nPostId}/reactions`, { token: nAuthor.token }); // desfaz

await call("POST", `/posts/${nPostId}/reactions`, { token: nFan.token });
await call("POST", `/posts/${nPostId}/reactions`, { token: nThird.token });
let likes = (await notifsOf(nAuthor)).data.filter((n) => n.type === "post_like");
check(
    "curtidas viram um aviso só, com a última pessoa e o total",
    likes.length === 1 && likes[0].actorId === nThird.id && likes[0].likesCount === 2,
    JSON.stringify(likes),
);

await call("POST", `/posts/${nPostId}/reactions`, { token: nThird.token }); // descurte
likes = (await notifsOf(nAuthor)).data.filter((n) => n.type === "post_like");
check(
    "descurtir passa o aviso para a curtida anterior",
    likes.length === 1 && likes[0].actorId === nFan.id && likes[0].likesCount === 1,
    JSON.stringify(likes),
);
await call("POST", `/posts/${nPostId}/reactions`, { token: nFan.token }); // descurte
likes = (await notifsOf(nAuthor)).data.filter((n) => n.type === "post_like");
check("like seguido de unlike não deixa aviso órfão", likes.length === 0, JSON.stringify(likes));

// --- Marcar como lida --------------------------------------------------------

const beforeRead = await notifsOf(nAuthor);
const firstId = beforeRead.data[0].notificationId;
const otherRead = await call("POST", "/notifications/read", {
    token: nFan.token,
    body: { ids: [firstId] },
});
check(
    "marcar ids de outra pessoa não afeta nada",
    otherRead.status === 200 && (await unreadOf(nAuthor)) === beforeRead.unread,
);
const readOne = await call("POST", "/notifications/read", {
    token: nAuthor.token,
    body: { ids: [firstId] },
});
check(
    "marcar uma como lida",
    readOne.body?.unread === beforeRead.unread - 1 &&
        Boolean((await notifsOf(nAuthor)).data.find((n) => n.notificationId === firstId)?.readAt),
    JSON.stringify(readOne.body),
);
const readAll = await call("POST", "/notifications/read", { token: nAuthor.token, body: {} });
check("marcar todas como lidas", readAll.body?.unread === 0 && (await unreadOf(nAuthor)) === 0);
check(
    "ids inválidos → 400",
    (await call("POST", "/notifications/read", { token: nAuthor.token, body: { ids: ["x"] } })).status === 400,
);

// Curtida nova depois de lida volta a contar como não lida.
await call("POST", `/posts/${nPostId}/reactions`, { token: nFan.token });
check("curtida nova reabre o aviso agrupado", (await unreadOf(nAuthor)) === 1);

// --- Paginação ---------------------------------------------------------------

const pageA = await notifsOf(nAuthor, "?limit=2");
const pageB = await notifsOf(nAuthor, `?limit=2&cursor=${pageA.nextCursor}`);
check(
    "paginação por cursor sem repetir",
    pageA.data.length === 2 &&
        Boolean(pageA.nextCursor) &&
        pageB.data.length >= 1 &&
        !pageB.data.some((n) => pageA.data.some((m) => m.notificationId === n.notificationId)),
    `${pageA.data.length} / ${pageB.data?.length}`,
);
check("cursor inválido → 400", (await call("GET", "/notifications?cursor=lixo", { token: nAuthor.token })).status === 400);

// --- Preferências ------------------------------------------------------------

const prefs = await call("PATCH", "/me/settings", {
    token: nAuthor.token,
    body: { notifyLikes: false, notifyComments: false },
});
check(
    "preferências salvas e devolvidas no /me",
    prefs.status === 200 &&
        prefs.body?.user?.notifyLikes === false &&
        prefs.body.user.notifyComments === false &&
        prefs.body.user.notifyReplies === true,
    JSON.stringify(prefs.body?.user).slice(0, 200),
);
await call("POST", "/notifications/read", { token: nAuthor.token, body: {} });
await call("POST", `/posts/${nPostId}/reactions`, { token: nThird.token });
await call("POST", `/posts/${nPostId}/comments`, { token: nThird.token, body: { content: "mais um" } });
check("preferência desligada não gera aviso", (await unreadOf(nAuthor)) === 0);
await call("PATCH", "/me/settings", { token: nAuthor.token, body: { notifyLikes: true, notifyComments: true } });

// --- Moderação e papel --------------------------------------------------------

await call("PATCH", `/communities/${nCid}/members/${nFan.id}`, {
    token: nAuthor.token,
    body: { role: "moderator" },
});
const roleNotif = (await notifsOf(nFan)).data.find((n) => n.type === "community_role");
check(
    "virar moderador avisa (community_role)",
    roleNotif?.data?.role === "moderator" && roleNotif.communityName === `Avisos ${stamp}`,
    JSON.stringify(roleNotif),
);

const thirdPost = await call("POST", "/posts", {
    token: nThird.token,
    body: { communityId: nCid, title: "Post que será removido", content: "x" },
});
const thirdPostId = thirdPost.body?.post?.postId;
await call("POST", `/posts/${thirdPostId}/reactions`, { token: nFan.token });
await call("DELETE", `/posts/${thirdPostId}`, { token: nFan.token });
const thirdList = (await notifsOf(nThird)).data;
const removedNotif = thirdList.find((n) => n.type === "content_removed");
check(
    "remoção pela moderação avisa o autor, sem dizer quem removeu",
    removedNotif?.data?.title === "Post que será removido" && removedNotif.actorId === null,
    JSON.stringify(removedNotif),
);
check(
    "avisos de post apagado somem (a curtida no post removido)",
    !thirdList.some((n) => n.type === "post_like" && n.postId === thirdPostId),
    JSON.stringify(thirdList.map((n) => n.type)),
);

console.log("\n[Engajamento A] Leaderboard");
resetRateLimits();

const lbOwner = await newUser("lbdona");
const lbAuthor = await newUser("lbautor");
const lbFan = await newUser("lbfa");
const lbCommunity = await call("POST", "/communities", {
    token: lbOwner.token,
    body: { name: `Ranking ${stamp}`, categoryId },
});
const lbCid = lbCommunity.body?.community?.communityId;
await call("POST", `/communities/${lbCid}/join`, { token: lbAuthor.token });
await call("POST", `/communities/${lbCid}/join`, { token: lbFan.token });

const board = async (period = "week") =>
    (await call("GET", `/communities/${lbCid}/leaderboard?period=${period}`)).body;
const pointsOf = async (u, period = "week") =>
    (await board(period))?.data?.find((row) => row.userId === u.id)?.points ?? 0;
const dbPoints = async (u) =>
    (
        await db.query(
            "SELECT COALESCE(SUM(points), 0)::int AS n FROM leaderboard_points WHERE user_id = $1 AND community_id = $2",
            [u.id, lbCid],
        )
    ).rows[0].n;

check("ranking vazio numa comunidade nova", (await board())?.data?.length === 0, JSON.stringify(await board()));

const lbPost = await call("POST", "/posts", {
    token: lbAuthor.token,
    body: { communityId: lbCid, title: "Post do ranking", content: "conteúdo" },
});
const lbPostId = lbPost.body?.post?.postId;
check("publicar post rende 5 pontos", (await pointsOf(lbAuthor)) === 5);

await call("POST", `/posts/${lbPostId}/reactions`, { token: lbFan.token });
check("curtida recebida rende 2", (await pointsOf(lbAuthor)) === 7);
await call("POST", `/posts/${lbPostId}/comments`, { token: lbOwner.token, body: { content: "bom" } });
check("comentário recebido rende 1", (await pointsOf(lbAuthor)) === 8);
await call("POST", `/posts/${lbPostId}/reactions`, { token: lbAuthor.token });
await call("POST", `/posts/${lbPostId}/comments`, { token: lbAuthor.token, body: { content: "eu mesmo" } });
check("curtir e comentar o próprio post não rende", (await pointsOf(lbAuthor)) === 8);
await call("POST", `/posts/${lbPostId}/reactions`, { token: lbAuthor.token }); // desfaz

const weekBoard = await board();
check(
    "ranking semanal com posição, nome e pontos",
    weekBoard?.data?.[0]?.userId === lbAuthor.id &&
        weekBoard.data[0].rank === 1 &&
        weekBoard.data[0].points === 8 &&
        weekBoard.data[0].username === `lbautor${stamp}`.slice(0, 30) &&
        /^\d{4}-\d{2}-\d{2}$/.test(weekBoard.weekStart),
    JSON.stringify(weekBoard),
);

await call("POST", `/posts/${lbPostId}/reactions`, { token: lbFan.token }); // descurte
check("descurtir devolve os 2 pontos", (await pointsOf(lbAuthor)) === 6);

const lbPost2 = await call("POST", "/posts", {
    token: lbAuthor.token,
    body: { communityId: lbCid, title: "Post que vai sumir", content: "x" },
});
const lbPost2Id = lbPost2.body?.post?.postId;
await call("POST", `/posts/${lbPost2Id}/comments`, { token: lbFan.token, body: { content: "oi" } });
await call("POST", `/posts/${lbPost2Id}/reactions`, { token: lbFan.token });
check("segundo post soma tudo", (await pointsOf(lbAuthor)) === 6 + 5 + 1 + 2);
await call("DELETE", `/posts/${lbPost2Id}`, { token: lbAuthor.token });
check("excluir o post devolve publicação, curtida e comentário", (await pointsOf(lbAuthor)) === 6);

// Curtida de uma semana anterior: o ponto saiu daquela semana, não desta.
await call("POST", `/posts/${lbPostId}/reactions`, { token: lbFan.token });
await db.query(
    "UPDATE post_reactions SET created_at = NOW() - INTERVAL '8 days' WHERE post_id = $1 AND user_id = $2",
    [lbPostId, lbFan.id],
);
await db.query(
    `UPDATE leaderboard_points SET points = points - 2
     WHERE user_id = $1 AND community_id = $2 AND period_start = famax_week_start(NOW())`,
    [lbAuthor.id, lbCid],
);
await db.query(
    `INSERT INTO leaderboard_points (leaderboard_id, user_id, community_id, points, period_start, period_end)
     VALUES (gen_random_uuid(), $1, $2, 2, famax_week_start(NOW() - INTERVAL '8 days'), famax_week_start(NOW() - INTERVAL '8 days') + 6)`,
    [lbAuthor.id, lbCid],
);
check(
    "todos os tempos soma as semanas",
    (await pointsOf(lbAuthor, "all")) === 8 && (await pointsOf(lbAuthor, "week")) === 6,
);
await call("POST", `/posts/${lbPostId}/reactions`, { token: lbFan.token }); // descurte
check(
    "desfazer devolve na semana em que o ponto foi ganho",
    (await pointsOf(lbAuthor, "week")) === 6 && (await pointsOf(lbAuthor, "all")) === 6,
    `${await pointsOf(lbAuthor, "week")} / ${await pointsOf(lbAuthor, "all")}`,
);

// Moderação: o comentário removido custa −10 a quem escreveu e tira o ponto do
// autor do post; o post removido devolve o que rendeu e custa −10.
const lbFanComment = await call("POST", `/posts/${lbPostId}/comments`, {
    token: lbFan.token,
    body: { content: "comentário ruim" },
});
check("comentário do fã rende 1 ao autor", (await pointsOf(lbAuthor)) === 7);
await call("DELETE", `/comments/${lbFanComment.body?.comment?.commentId}`, { token: lbOwner.token });
check(
    "comentário removido pela moderação: −1 ao autor do post, −10 a quem comentou",
    (await pointsOf(lbAuthor)) === 6 && (await dbPoints(lbFan)) === -10,
    `${await pointsOf(lbAuthor)} / ${await dbPoints(lbFan)}`,
);
check("pontuação negativa não aparece no ranking", !(await board()).data.some((r) => r.userId === lbFan.id));

await call("DELETE", `/posts/${lbPostId}`, { token: lbOwner.token });
check(
    "post removido pela moderação: devolve o que rendeu e custa −10",
    (await dbPoints(lbAuthor)) === -10 && (await board()).data.length === 0,
    `${await dbPoints(lbAuthor)} / ${JSON.stringify((await board()).data)}`,
);

check("period inválido → 400", (await call("GET", `/communities/${lbCid}/leaderboard?period=ano`)).status === 400);
check(
    "comunidade inexistente → 404",
    (await call("GET", "/communities/00000000-0000-4000-8000-000000000000/leaderboard")).status === 404,
);

console.log("\n[Engajamento B] Seguir usuários");
resetRateLimits();

const fAna = await newUser("fana");
const fBia = await newUser("fbia");
const fCid = await newUser("fcid");
const fDeb = await newUser("fdeb");
const fEva = await newUser("feva");

const follow = (u, target) => call("POST", `/users/${target.id}/follow`, { token: u.token });
const unfollow = (u, target) => call("DELETE", `/users/${target.id}/follow`, { token: u.token });
const profileOf = async (target, viewer) =>
    (await call("GET", `/users/${target.id}`, { token: viewer?.token })).body?.user;
const followNotifs = async (u) =>
    (await call("GET", "/notifications", { token: u.token })).body?.data?.filter((n) => n.type === "follow") ?? [];

const firstFollow = await follow(fAna, fBia);
check(
    "seguir devolve o estado e a contagem",
    firstFollow.status === 200 && firstFollow.body?.following === true && firstFollow.body.followersCount === 1,
    JSON.stringify(firstFollow.body),
);
const againFollow = await follow(fAna, fBia);
check("seguir de novo é idempotente", againFollow.status === 200 && againFollow.body?.followersCount === 1);
check("seguir a si mesmo → 400", (await follow(fAna, fAna)).status === 400);
check(
    "seguir conta inexistente → 404",
    (await follow(fAna, { id: "00000000-0000-4000-8000-000000000000" })).status === 404,
);
check("seguir exige login", (await call("POST", `/users/${fBia.id}/follow`)).status === 401);

let biaNotifs = await followNotifs(fBia);
check(
    "seguir gera notificação follow",
    biaNotifs.length === 1 && biaNotifs[0].actorId === fAna.id,
    JSON.stringify(biaNotifs),
);

const biaSeenByAna = await profileOf(fBia, fAna);
const biaSeenByCid = await profileOf(fBia, fCid);
const anaSeenBySelf = await profileOf(fAna, fAna);
check(
    "perfil mostra seguidores, seguindo e se quem vê segue",
    biaSeenByAna?.stats?.followers === 1 &&
        biaSeenByAna.stats.following === 0 &&
        biaSeenByAna.followedByMe === true &&
        biaSeenByCid?.followedByMe === false &&
        anaSeenBySelf?.stats?.following === 1,
    JSON.stringify(biaSeenByAna?.stats),
);

const biaFollowers = await call("GET", `/users/${fBia.id}/followers`, { token: fCid.token });
const anaFollowing = await call("GET", `/users/${fAna.id}/following`);
check(
    "listas de seguidores e seguindo",
    biaFollowers.status === 200 &&
        biaFollowers.body?.data?.length === 1 &&
        biaFollowers.body.data[0].userId === fAna.id &&
        biaFollowers.body.data[0].followedByMe === false &&
        anaFollowing.body?.data?.[0]?.userId === fBia.id,
    JSON.stringify(biaFollowers.body),
);

const unfollowed = await unfollow(fAna, fBia);
check(
    "deixar de seguir zera a contagem e apaga o aviso",
    unfollowed.status === 200 &&
        unfollowed.body?.following === false &&
        unfollowed.body.followersCount === 0 &&
        (await followNotifs(fBia)).length === 0,
    JSON.stringify(unfollowed.body),
);
await follow(fAna, fBia);
await unfollow(fAna, fBia);
await follow(fAna, fBia);
check("seguir, sair e seguir de novo deixa um aviso só", (await followNotifs(fBia)).length === 1);

// Paginação das listas.
await follow(fCid, fBia);
await follow(fDeb, fBia);
const followersA = await call("GET", `/users/${fBia.id}/followers?limit=2`);
const followersB = await call("GET", `/users/${fBia.id}/followers?limit=2&cursor=${followersA.body?.nextCursor}`);
check(
    "lista paginada por cursor sem repetir",
    followersA.body?.data?.length === 2 &&
        Boolean(followersA.body.nextCursor) &&
        followersB.body?.data?.length === 1 &&
        !followersB.body.data.some((u) => followersA.body.data.some((v) => v.userId === u.userId)) &&
        followersA.body.data[0].userId === fDeb.id,
    JSON.stringify(followersA.body),
);

// Perfil privado: pode ser seguido, mas as listas ficam fechadas para os outros.
await call("PATCH", "/me/settings", { token: fCid.token, body: { isPrivate: true } });
const followPrivate = await follow(fAna, fCid);
check("perfil privado pode ser seguido", followPrivate.status === 200 && followPrivate.body?.followersCount === 1);
check(
    "cartão do perfil privado diz se quem vê segue",
    (await profileOf(fCid, fAna))?.followedByMe === true && (await profileOf(fCid, fAna))?.stats === undefined,
);
check(
    "listas de perfil privado → 403 para os outros, 200 para o dono",
    (await call("GET", `/users/${fCid.id}/followers`, { token: fAna.token })).status === 403 &&
        (await call("GET", `/users/${fCid.id}/following`)).status === 403 &&
        (await call("GET", `/users/${fCid.id}/followers`, { token: fCid.token })).status === 200,
);

// Preferência: sem aviso de novo seguidor.
await call("PATCH", "/me/settings", { token: fDeb.token, body: { notifyFollows: false } });
await follow(fAna, fDeb);
check(
    "preferência desligada não gera aviso de seguidor",
    (await followNotifs(fDeb)).length === 0 &&
        (await call("GET", "/me", { token: fDeb.token })).body?.user?.notifyFollows === false,
);

// Feed "Seguindo".
const fCommunity = await call("POST", "/communities", {
    token: fBia.token,
    body: { name: `Seguindo ${stamp}`, categoryId },
});
const fCommunityId = fCommunity.body?.community?.communityId;
const biaPost = await call("POST", "/posts", {
    token: fBia.token,
    body: { communityId: fCommunityId, title: "Post da Bia", content: "para quem segue" },
});
const biaGone = await call("POST", "/posts", {
    token: fBia.token,
    body: { communityId: fCommunityId, title: "Post apagado da Bia", content: "x" },
});
await call("DELETE", `/posts/${biaGone.body?.post?.postId}`, { token: fBia.token });

const anaFeed = await call("GET", "/feed/following", { token: fAna.token });
const evaFeed = await call("GET", "/feed/following", { token: fEva.token });
check(
    "feed Seguindo traz posts de quem a pessoa segue",
    anaFeed.status === 200 &&
        anaFeed.body?.data?.some((p) => p.postId === biaPost.body?.post?.postId) &&
        anaFeed.body.data.every((p) => p.authorId === fBia.id || p.authorId === fCid.id) &&
        anaFeed.body.data[0].communityName === `Seguindo ${stamp}`,
    JSON.stringify(anaFeed.body).slice(0, 300),
);
check(
    "feed Seguindo não traz post apagado",
    !anaFeed.body?.data?.some((p) => p.postId === biaGone.body?.post?.postId),
);
check(
    "feed Seguindo só de quem se segue",
    evaFeed.status === 200 && evaFeed.body?.data?.length === 0 && evaFeed.body?.pagination?.total === 0,
    JSON.stringify(evaFeed.body),
);
check("feed Seguindo exige login", (await call("GET", "/feed/following")).status === 401);

console.log("\n[Engajamento C] Ordenação do feed");
resetRateLimits();

const sOwner = await newUser("sdono");
const sCommunity = await call("POST", "/communities", {
    token: sOwner.token,
    body: { name: `Ordenação ${stamp}`, categoryId },
});
const sCid = sCommunity.body?.community?.communityId;

// Contadores e idades fixados direto no banco: a ordem esperada fica exata.
//   hot = (2×reações + comentários + 1) / (horas + 2)^1.5
//   P1: 1h,  0/0  → 1/3^1.5   ≈ 0,19
//   P2: 48h, 10/1 → 22/50^1.5 ≈ 0,062
//   P3: 2h,  2/5  → 10/4^1.5  = 1,25
//   P4: 40h, 1/8  → 11/42^1.5 ≈ 0,040
const sorted = {};
for (const [label, hours, likes, comments] of [
    ["P1", 1, 0, 0],
    ["P2", 48, 10, 1],
    ["P3", 2, 2, 5],
    ["P4", 40, 1, 8],
]) {
    const created = await call("POST", "/posts", {
        token: sOwner.token,
        body: { communityId: sCid, title: `Post ${label}`, content: "x" },
    });
    const id = created.body?.post?.postId;
    sorted[id] = label;
    await db.query(
        `UPDATE posts SET likes_count = $2, comments_count = $3,
                created_at = NOW() - make_interval(hours => $4)
         WHERE post_id = $1`,
        [id, likes, comments, hours],
    );
}

const orderOf = async (sort) => {
    const query = sort ? `?sort=${sort}` : "";
    const res = await call("GET", `/communities/${sCid}/posts${query}`);
    return (res.body?.data ?? []).map((p) => sorted[p.postId]).join(",");
};

check("padrão: mais recentes", (await orderOf()) === "P1,P3,P4,P2", await orderOf());
check("sort=new", (await orderOf("new")) === "P1,P3,P4,P2", await orderOf("new"));
check("sort=top: mais reações", (await orderOf("top")) === "P2,P3,P4,P1", await orderOf("top"));
check("sort=comments: mais comentados", (await orderOf("comments")) === "P4,P3,P2,P1", await orderOf("comments"));
check("sort=hot: interação com decaimento", (await orderOf("hot")) === "P3,P1,P2,P4", await orderOf("hot"));
const sortEcho = await call("GET", `/communities/${sCid}/posts?sort=top&limit=2&page=2`);
check(
    "ordenação vale na paginação e volta na resposta",
    sortEcho.body?.sort === "top" &&
        sortEcho.body.data.map((p) => sorted[p.postId]).join(",") === "P4,P1",
    JSON.stringify(sortEcho.body?.data?.map((p) => sorted[p.postId])),
);
check("sort inválido → 400", (await call("GET", `/communities/${sCid}/posts?sort=aleatorio`)).status === 400);

console.log("\n[Engajamento D] Fixar e resolver");
resetRateLimits();

const pOwner = await newUser("pdono");
const pMod = await newUser("pmod");
const pMember = await newUser("pmembro");
const pCommunity = await call("POST", "/communities", {
    token: pOwner.token,
    body: { name: `Fixados ${stamp}`, categoryId },
});
const pCid = pCommunity.body?.community?.communityId;
await call("POST", `/communities/${pCid}/join`, { token: pMod.token });
await call("POST", `/communities/${pCid}/join`, { token: pMember.token });
await call("PATCH", `/communities/${pCid}/members/${pMod.id}`, {
    token: pOwner.token,
    body: { role: "moderator" },
});

const pPosts = [];
for (let i = 1; i <= 5; i++) {
    const created = await call("POST", "/posts", {
        token: pMember.token,
        body: { communityId: pCid, title: `Pergunta ${i}`, content: "Alguém sabe?" },
    });
    pPosts.push(created.body?.post?.postId);
}
const pin = (u, postId) => call("POST", `/posts/${postId}/pin`, { token: u.token });
const unpin = (u, postId) => call("DELETE", `/posts/${postId}/pin`, { token: u.token });
const feedIds = async (query = "") =>
    ((await call("GET", `/communities/${pCid}/posts${query}`)).body?.data ?? []).map((p) => p.postId);

check("membro comum não fixa → 403", (await pin(pMember, pPosts[0])).status === 403);
const pinned1 = await pin(pMod, pPosts[0]);
check(
    "moderador fixa e o post volta com pinned_at",
    pinned1.status === 200 && Boolean(pinned1.body?.post?.pinnedAt),
    JSON.stringify(pinned1.body).slice(0, 200),
);
await pin(pMod, pPosts[1]);
await pin(pOwner, pPosts[2]);
const fourth = await pin(pOwner, pPosts[3]);
check("limite de 3 fixados por comunidade → 409", fourth.status === 409, JSON.stringify(fourth.body));
check("fixar de novo o que já está fixado é aceito", (await pin(pOwner, pPosts[0])).status === 200);

const pinnedOrder = await feedIds();
check(
    "fixados no topo, o mais recente primeiro",
    pinnedOrder.slice(0, 3).join() === [pPosts[2], pPosts[1], pPosts[0]].join() &&
        pinnedOrder.slice(3).join() === [pPosts[4], pPosts[3]].join(),
    pinnedOrder.join(),
);
check(
    "fixados no topo também em outra ordenação",
    (await feedIds("?sort=top")).slice(0, 3).sort().join() === [pPosts[0], pPosts[1], pPosts[2]].sort().join(),
);

const pUnpinned = await unpin(pMod, pPosts[1]);
check(
    "desafixar libera a vaga",
    pUnpinned.status === 200 && pUnpinned.body?.post?.pinnedAt === null && (await pin(pOwner, pPosts[3])).status === 200,
);
await call("DELETE", `/posts/${pPosts[2]}`, { token: pMember.token });
check("post fixado excluído não ocupa vaga", (await pin(pOwner, pPosts[4])).status === 200);
check("membro comum não desafixa → 403", (await unpin(pMember, pPosts[0])).status === 403);

// Resposta aceita.
const pAnswer = await call("POST", `/posts/${pPosts[0]}/comments`, {
    token: pMod.token,
    body: { content: "Faz assim, ó." },
});
const answerId = pAnswer.body?.comment?.commentId;
const otherPostComment = await call("POST", `/posts/${pPosts[1]}/comments`, {
    token: pMod.token,
    body: { content: "Outro post" },
});
const resolve = (u, postId, commentId) =>
    call("PUT", `/posts/${postId}/resolution`, { token: u.token, body: { commentId } });

check("só o autor marca a resposta aceita → 404 para os outros", (await resolve(pOwner, pPosts[0], answerId)).status === 404);
check(
    "comentário de outro post não pode ser a resposta → 400",
    (await resolve(pMember, pPosts[0], otherPostComment.body?.comment?.commentId)).status === 400,
);
const pResolved = await resolve(pMember, pPosts[0], answerId);
check(
    "autor marca a resposta aceita",
    pResolved.status === 200 && pResolved.body?.post?.resolvedCommentId === answerId,
    JSON.stringify(pResolved.body).slice(0, 200),
);
check(
    "\"Ajudar os outros\" deixa de fora o post resolvido",
    !(await feedIds("?unanswered=true")).includes(pPosts[0]) && (await feedIds("?unanswered=true")).includes(pPosts[1]),
);
const pUnresolved = await call("DELETE", `/posts/${pPosts[0]}/resolution`, { token: pMember.token });
check(
    "autor desmarca a resposta aceita",
    pUnresolved.status === 200 && pUnresolved.body?.post?.resolvedCommentId === null &&
        (await feedIds("?unanswered=true")).includes(pPosts[0]),
);
await resolve(pMember, pPosts[0], answerId);
await call("DELETE", `/comments/${answerId}`, { token: pMod.token });
const pAfterDelete = await call("GET", `/posts/${pPosts[0]}`);
check(
    "excluir a resposta aceita reabre a pergunta",
    pAfterDelete.body?.post?.resolvedCommentId === null,
    JSON.stringify(pAfterDelete.body?.post?.resolvedCommentId),
);

console.log("\n[Engajamento E] Mais reações");
resetRateLimits();

const rOwner = await newUser("rdono");
const rFan = await newUser("rfa");
const rOther = await newUser("routro");
const rCommunity = await call("POST", "/communities", {
    token: rOwner.token,
    body: { name: `Reações ${stamp}`, categoryId },
});
const rCid = rCommunity.body?.community?.communityId;
await call("POST", `/communities/${rCid}/join`, { token: rFan.token });
await call("POST", `/communities/${rCid}/join`, { token: rOther.token });
const rPost = await call("POST", "/posts", {
    token: rOwner.token,
    body: { communityId: rCid, title: "Reaja a isto", content: "x" },
});
const rPostId = rPost.body?.post?.postId;
const react = (u, type) =>
    call("POST", `/posts/${rPostId}/reactions`, { token: u.token, body: type ? { type } : undefined });
const ownerPoints = async () =>
    (await call("GET", `/communities/${rCid}/leaderboard`)).body?.data?.find((r) => r.userId === rOwner.id)?.points;
const likeNotifs = async () =>
    (await call("GET", "/notifications", { token: rOwner.token })).body?.data?.filter((n) => n.type === "post_like") ?? [];

const loved = await react(rFan, "love");
check(
    "reagir com outro tipo",
    loved.status === 200 &&
        loved.body?.reaction === "love" &&
        loved.body.liked === true &&
        loved.body.likesCount === 1 &&
        loved.body.reactionCounts?.love === 1,
    JSON.stringify(loved.body),
);
const swapped = await react(rFan, "haha");
check(
    "trocar de reação substitui a anterior",
    swapped.body?.reaction === "haha" &&
        swapped.body.likesCount === 1 &&
        swapped.body.reactionCounts?.haha === 1 &&
        swapped.body.reactionCounts.love === undefined,
    JSON.stringify(swapped.body),
);
check(
    "trocar não dá pontos nem avisa de novo",
    (await ownerPoints()) === 7 && (await likeNotifs()).length === 1,
    `${await ownerPoints()} / ${(await likeNotifs()).length}`,
);
const fanView = await call("GET", `/posts/${rPostId}`, { token: rFan.token });
check(
    "post traz my_reaction e reaction_counts",
    fanView.body?.post?.myReaction === "haha" &&
        fanView.body.post.likedByMe === true &&
        fanView.body.post.reactionCounts?.haha === 1,
    JSON.stringify(fanView.body?.post).slice(0, 300),
);

await react(rOther, "sad");
const both = await call("GET", `/posts/${rPostId}`);
check(
    "contagem por tipo e total de reações",
    both.body?.post?.likesCount === 2 &&
        both.body.post.reactionCounts?.sad === 1 &&
        both.body.post.reactionCounts.haha === 1 &&
        both.body.post.myReaction === null,
    JSON.stringify(both.body?.post?.reactionCounts),
);
check(
    "aviso agrupado conta todas as reações",
    (await likeNotifs())[0]?.likesCount === 2 && (await likeNotifs())[0]?.actorId === rOther.id,
    JSON.stringify(await likeNotifs()),
);

const undone = await react(rFan);
check(
    "botão sem tipo desfaz qualquer reação e devolve os pontos",
    undone.body?.reaction === null &&
        undone.body.liked === false &&
        undone.body.likesCount === 1 &&
        (await ownerPoints()) === 7,
    JSON.stringify(undone.body),
);
await react(rFan, "wow");
const wowAgain = await react(rFan, "wow");
check("mesma reação de novo desfaz", wowAgain.body?.reaction === null && wowAgain.body.likesCount === 1);
const plainLike = await react(rFan);
check("botão sem tipo, sem reação, curte", plainLike.body?.reaction === "like" && plainLike.body.likesCount === 2);

check("tipo inválido → 400", (await react(rFan, "raiva")).status === 400);
let duplicateBlocked = false;
try {
    await db.query(
        "INSERT INTO post_reactions (reaction_id, post_id, user_id, type) VALUES (gen_random_uuid(), $1, $2, 'love')",
        [rPostId, rFan.id],
    );
} catch (err) {
    duplicateBlocked = err.code === "23505";
}
check("banco garante uma reação por pessoa por post", duplicateBlocked);

console.log("\n[Engajamento F] Salvos");
resetRateLimits();

const svAuthor = await newUser("svautor");
const svReader = await newUser("svleitor");
const svCommunity = await call("POST", "/communities", {
    token: svAuthor.token,
    body: { name: `Salvos ${stamp}`, categoryId },
});
const svCid = svCommunity.body?.community?.communityId;
const svPosts = [];
for (const title of ["Guarde este", "E este também", "Este vai sumir"]) {
    const created = await call("POST", "/posts", {
        token: svAuthor.token,
        body: { communityId: svCid, title, content: "x" },
    });
    svPosts.push(created.body?.post?.postId);
}
const save = (u, postId) => call("POST", `/posts/${postId}/save`, { token: u.token });
const savedList = async (u, query = "") => (await call("GET", `/me/saved${query}`, { token: u.token })).body;

const firstSave = await save(svReader, svPosts[0]);
check("salvar post sem ser membro", firstSave.status === 200 && firstSave.body?.saved === true, JSON.stringify(firstSave.body));
check("salvar de novo é idempotente", (await save(svReader, svPosts[0])).status === 200);
check("salvar exige login", (await call("POST", `/posts/${svPosts[0]}/save`)).status === 401);
check(
    "salvar post inexistente → 404",
    (await save(svReader, "00000000-0000-4000-8000-000000000000")).status === 404,
);
await save(svReader, svPosts[1]);
await save(svReader, svPosts[2]);

let readerSaved = await savedList(svReader);
check(
    "lista de salvos, mais recentes primeiro, com saved_by_me",
    readerSaved?.data?.map((p) => p.postId).join() === [svPosts[2], svPosts[1], svPosts[0]].join() &&
        readerSaved.data.every((p) => p.savedByMe === true) &&
        readerSaved.pagination?.total === 3,
    JSON.stringify(readerSaved?.pagination),
);
check(
    "post traz saved_by_me para quem salvou, e só para ele",
    (await call("GET", `/posts/${svPosts[0]}`, { token: svReader.token })).body?.post?.savedByMe === true &&
        (await call("GET", `/posts/${svPosts[0]}`, { token: svAuthor.token })).body?.post?.savedByMe === false,
);
check("salvos são de cada um", (await savedList(svAuthor))?.data?.length === 0);

await call("DELETE", `/posts/${svPosts[2]}`, { token: svAuthor.token });
readerSaved = await savedList(svReader);
check("post apagado some dos salvos", readerSaved?.data?.length === 2 && readerSaved.pagination.total === 2);

const unsaved = await call("DELETE", `/posts/${svPosts[0]}/save`, { token: svReader.token });
check(
    "tirar dos salvos",
    unsaved.status === 200 && unsaved.body?.saved === false && (await savedList(svReader))?.data?.length === 1,
);
check("lista de salvos exige login", (await call("GET", "/me/saved")).status === 401);

console.log("\n[Engajamento G] Menções e imagens");
resetRateLimits();

const mAuthor = await newUser("mautor");
const mFriend = await newUser("mamigo");
const mThird = await newUser("mterc");
const mFriendName = `mamigo${stamp}`.slice(0, 30);
const mThirdName = `mterc${stamp}`.slice(0, 30);
const mAuthorName = `mautor${stamp}`.slice(0, 30);
const mCommunity = await call("POST", "/communities", {
    token: mAuthor.token,
    body: { name: `Menções ${stamp}`, categoryId },
});
const mCid = mCommunity.body?.community?.communityId;
await call("POST", `/communities/${mCid}/join`, { token: mThird.token });

const mentionsOf = async (u) =>
    (await call("GET", "/notifications", { token: u.token })).body?.data?.filter((n) => n.type === "mention") ?? [];

const mPost = await call("POST", "/posts", {
    token: mAuthor.token,
    body: {
        communityId: mCid,
        title: "Chamando a galera",
        content: `Oi @${mFriendName.toUpperCase()}, veja isto. Contato: fulano@${mThirdName}.com, @naoexiste${stamp} e eu mesmo @${mAuthorName}`,
    },
});
const mPostId = mPost.body?.post?.postId;
let friendMentions = await mentionsOf(mFriend);
check(
    "menção no post avisa a pessoa (sem diferenciar maiúsculas)",
    friendMentions.length === 1 &&
        friendMentions[0].postId === mPostId &&
        friendMentions[0].actorId === mAuthor.id &&
        friendMentions[0].commentId === null,
    JSON.stringify(friendMentions),
);
check(
    "e-mail não é menção, e ninguém é avisado de se mencionar",
    (await mentionsOf(mThird)).length === 0 && (await mentionsOf(mAuthor)).length === 0,
);

await call("POST", "/posts", {
    token: mAuthor.token,
    body: { communityId: mCid, title: "Código", content: "Use `@" + mThirdName + "` no código\n```\n@" + mThirdName + "\n```" },
});
check("menção dentro de código não conta", (await mentionsOf(mThird)).length === 0);

await call("PATCH", `/posts/${mPostId}`, {
    token: mAuthor.token,
    body: { content: `Oi @${mFriendName}, veja isto. E você também, @${mThirdName}!` },
});
check(
    "editar avisa só as menções novas",
    (await mentionsOf(mFriend)).length === 1 && (await mentionsOf(mThird)).length === 1,
);

// Comentários: quem já recebe "respondeu" não recebe também "mencionou".
const mRoot = await call("POST", `/posts/${mPostId}/comments`, {
    token: mAuthor.token,
    body: { content: "Comentário do autor" },
});
await call("POST", `/posts/${mPostId}/comments`, {
    token: mThird.token,
    body: { content: `@${mAuthorName} concordo! @${mFriendName} o que acha?`, parentCommentId: mRoot.body?.comment?.commentId },
});
const authorNotifs = (await call("GET", "/notifications", { token: mAuthor.token })).body?.data ?? [];
friendMentions = await mentionsOf(mFriend);
check(
    "menção em comentário avisa com o comentário, sem aviso duplo para o respondido",
    friendMentions.length === 2 &&
        Boolean(friendMentions[0].commentId) &&
        authorNotifs.filter((n) => n.type === "comment_reply").length === 1 &&
        authorNotifs.filter((n) => n.type === "mention").length === 0,
    JSON.stringify(authorNotifs.map((n) => n.type)),
);

const mThirdComment = await call("POST", `/posts/${mPostId}/comments`, {
    token: mThird.token,
    body: { content: "sem menção" },
});
await call("PATCH", "/me/settings", { token: mFriend.token, body: { notifyReplies: false } });
await call("PATCH", `/comments/${mThirdComment.body?.comment?.commentId}`, {
    token: mThird.token,
    body: { content: `agora com @${mFriendName}` },
});
check("menção respeita a preferência de respostas", (await mentionsOf(mFriend)).length === 2);
await call("PATCH", "/me/settings", { token: mFriend.token, body: { notifyReplies: true } });
await call("PATCH", `/comments/${mThirdComment.body?.comment?.commentId}`, {
    token: mThird.token,
    body: { content: `agora com @${mFriendName} e @${mAuthorName}` },
});
check(
    "editar comentário avisa a menção nova",
    (await mentionsOf(mAuthor)).length === 1 && (await mentionsOf(mFriend)).length === 2,
);

const lookup = await call("GET", `/users/by-username/${mFriendName.toUpperCase()}`);
check(
    "@username resolve para o id do perfil",
    lookup.status === 200 && lookup.body?.user?.userId === mFriend.id &&
        (await call("GET", `/users/by-username/naoexiste${stamp}`)).status === 404 &&
        (await call("GET", "/users/by-username/a b")).status === 400,
);

// --- Imagens -----------------------------------------------------------------

const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const imageForm = (count, buffer = png) => {
    const form = new FormData();
    for (let i = 0; i < count; i++) form.append("images", new Blob([buffer], { type: "image/png" }), `img${i}.png`);
    return form;
};
const upload = (u, form) => call("POST", `/posts/${mPostId}/images`, { token: u.token, body: form, raw: true });

check("imagens: só o autor anexa → 404", (await upload(mThird, imageForm(1))).status === 404);
check("imagens: sem arquivo → 400", (await upload(mAuthor, new FormData())).status === 400);
check(
    "imagens: arquivo que não é imagem → 400",
    (await upload(mAuthor, imageForm(1, Buffer.from("isto não é uma imagem de verdade")))).status === 400,
);
check("imagens: mais de 4 de uma vez → 400", (await upload(mAuthor, imageForm(5))).status === 400);
const noStorage = await upload(mAuthor, imageForm(1));
check(
    "imagens: sem Storage configurado → 503 (validado antes)",
    noStorage.status === 503,
    JSON.stringify(noStorage.body),
);

// Com o Storage desligado no teste, as linhas entram direto no banco.
for (let i = 0; i < 3; i++) {
    await db.query(
        "INSERT INTO post_images (image_id, post_id, url, position) VALUES (gen_random_uuid(), $1, $2, $3)",
        [mPostId, `https://cdn.test/img${i}.png`, i],
    );
}
const withImages = await call("GET", `/posts/${mPostId}`);
check(
    "post traz as imagens em ordem",
    withImages.body?.post?.images?.map((i) => i.url).join() ===
        ["https://cdn.test/img0.png", "https://cdn.test/img1.png", "https://cdn.test/img2.png"].join(),
    JSON.stringify(withImages.body?.post?.images),
);
const overLimit = await upload(mAuthor, imageForm(2));
check("imagens: limite de 4 por post contando as que já existem → 400", overLimit.status === 400, JSON.stringify(overLimit.body));

const firstImage = withImages.body?.post?.images?.[0]?.imageId;
check(
    "imagens: só o autor remove → 404",
    (await call("DELETE", `/posts/${mPostId}/images/${firstImage}`, { token: mThird.token })).status === 404,
);
const removedImage = await call("DELETE", `/posts/${mPostId}/images/${firstImage}`, { token: mAuthor.token });
check(
    "imagens: autor remove uma",
    removedImage.status === 200 && removedImage.body?.post?.images?.length === 2,
    JSON.stringify(removedImage.body?.post?.images),
);

console.log("\n[Engajamento H] Eventos da comunidade");
resetRateLimits();

const eOwner = await newUser("edona");
const eMod = await newUser("emod");
const eMember = await newUser("emembro");
const eQuiet = await newUser("equieto");
const eOutsider = await newUser("efora");
const eCommunity = await call("POST", "/communities", {
    token: eOwner.token,
    body: { name: `Eventos ${stamp}`, categoryId },
});
const eCid = eCommunity.body?.community?.communityId;
for (const u of [eMod, eMember, eQuiet]) await call("POST", `/communities/${eCid}/join`, { token: u.token });
await call("PATCH", `/communities/${eCid}/members/${eMod.id}`, { token: eOwner.token, body: { role: "moderator" } });
await call("PATCH", "/me/settings", { token: eQuiet.token, body: { notifyEvents: false } });

const inDays = (days, hours = 0) => new Date(Date.now() + days * 86_400_000 + hours * 3_600_000).toISOString();
const createEvent = (u, body) => call("POST", `/communities/${eCid}/events`, { token: u.token, body });
const eventNotifs = async (u) =>
    (await call("GET", "/notifications", { token: u.token })).body?.data?.filter((n) => n.type === "event") ?? [];

check(
    "membro comum não cria evento → 403",
    (await createEvent(eMember, { title: "Encontro", startsAt: inDays(2) })).status === 403,
);
check(
    "quem não é membro não cria evento → 403",
    (await createEvent(eOutsider, { title: "Encontro", startsAt: inDays(2) })).status === 403,
);
check(
    "início no passado → 400",
    (await createEvent(eOwner, { title: "Encontro", startsAt: inDays(-1) })).status === 400,
);
check(
    "fim antes do início → 400",
    (await createEvent(eOwner, { title: "Encontro", startsAt: inDays(2), endsAt: inDays(1) })).status === 400,
);

const later = await createEvent(eOwner, {
    title: "Degustação de cafés",
    description: "Traga sua caneca.",
    startsAt: inDays(5),
    endsAt: inDays(5, 2),
    location: "https://meet.example.com/cafe",
});
const sooner = await createEvent(eMod, { title: "Live com barista", startsAt: inDays(1) });
const laterId = later.body?.event?.eventId;
const soonerId = sooner.body?.event?.eventId;
check(
    "dono e moderador criam evento",
    later.status === 201 &&
        sooner.status === 201 &&
        later.body.event.title === "Degustação de cafés" &&
        later.body.event.location === "https://meet.example.com/cafe" &&
        later.body.event.attendeesCount === 0 &&
        later.body.event.creatorId === eOwner.id,
    JSON.stringify(later.body).slice(0, 300),
);

const memberEventNotifs = await eventNotifs(eMember);
check(
    "evento novo avisa os membros",
    memberEventNotifs.length === 2 &&
        memberEventNotifs.some((n) => n.eventId === laterId && n.eventTitle === "Degustação de cafés"),
    JSON.stringify(memberEventNotifs),
);
check(
    "quem criou não é avisado; preferência desligada não recebe",
    (await eventNotifs(eOwner)).length === 1 &&
        (await eventNotifs(eMod)).length === 1 &&
        (await eventNotifs(eQuiet)).length === 0 &&
        (await eventNotifs(eOutsider)).length === 0,
);

// Evento que já aconteceu, direto no banco (a API não aceita início no passado).
await db.query(
    `INSERT INTO community_events (event_id, community_id, created_by, title, starts_at)
     VALUES (gen_random_uuid(), $1, $2, 'Encontro antigo', NOW() - INTERVAL '3 days')`,
    [eCid, eOwner.id],
);
const upcoming = await call("GET", `/communities/${eCid}/events`);
const past = await call("GET", `/communities/${eCid}/events?scope=past`);
check(
    "próximos eventos em ordem de data; anteriores à parte",
    upcoming.body?.data?.map((e) => e.eventId).join() === [soonerId, laterId].join() &&
        past.body?.data?.length === 1 &&
        past.body.data[0].title === "Encontro antigo" &&
        past.body.data[0].isPast === true,
    JSON.stringify(upcoming.body?.data?.map((e) => e.title)),
);
check(
    "widget pede só o próximo",
    (await call("GET", `/communities/${eCid}/events?limit=1`)).body?.data?.[0]?.eventId === soonerId,
);

// "Vou"
const attend = (u, id) => call("POST", `/events/${id}/attend`, { token: u.token });
const going = await attend(eMember, laterId);
check(
    "membro marca presença",
    going.status === 200 && going.body?.attending === true && going.body.attendeesCount === 1,
    JSON.stringify(going.body),
);
check("marcar de novo é idempotente", (await attend(eMember, laterId)).body?.attendeesCount === 1);
check(
    "evento mostra a presença de quem vê",
    (await call("GET", `/events/${laterId}`, { token: eMember.token })).body?.event?.attending === true &&
        (await call("GET", `/events/${laterId}`, { token: eMod.token })).body?.event?.attending === false &&
        (await call("GET", `/events/${laterId}`)).body?.event?.attendeesCount === 1,
);
check("quem não é membro não marca presença → 403", (await attend(eOutsider, laterId)).status === 403);
check("evento que já terminou não aceita presença → 400", (await attend(eMember, past.body?.data?.[0]?.eventId)).status === 400);
const notGoing = await call("DELETE", `/events/${laterId}/attend`, { token: eMember.token });
check("desmarcar presença", notGoing.body?.attending === false && notGoing.body.attendeesCount === 0);

// Editar e cancelar
const edited = await call("PATCH", `/events/${laterId}`, {
    token: eMod.token,
    body: { title: "Degustação de cafés especiais", location: null },
});
check(
    "moderador edita o evento",
    edited.status === 200 && edited.body?.event?.title === "Degustação de cafés especiais" && edited.body.event.location === null,
    JSON.stringify(edited.body).slice(0, 200),
);
check(
    "membro comum não edita → 403",
    (await call("PATCH", `/events/${laterId}`, { token: eMember.token, body: { title: "Hack" } })).status === 403,
);
check(
    "edição com fim antes do início → 400",
    (await call("PATCH", `/events/${laterId}`, { token: eOwner.token, body: { endsAt: inDays(4) } })).status === 400,
);
check(
    "membro comum não cancela → 403",
    (await call("DELETE", `/events/${laterId}`, { token: eMember.token })).status === 403,
);
const cancelled = await call("DELETE", `/events/${laterId}`, { token: eOwner.token });
check(
    "dono cancela: evento some e o aviso também",
    cancelled.status === 204 &&
        (await call("GET", `/events/${laterId}`)).status === 404 &&
        !(await eventNotifs(eMember)).some((n) => n.eventId === laterId),
);

console.log("\n[Chat] Histórico, exclusão, visto, tempo real e grupos");
resetRateLimits();

const chA = await newUser("cha");
const chB = await newUser("chb");
const chC = await newUser("chc");
const chD = await newUser("chd");

const ch_openDm = async (u, other) =>
    (await call("POST", "/conversations", { token: u.token, body: { userId: other.id } })).body?.conversationId;
const ch_send = (u, conversationId, content) =>
    call("POST", `/conversations/${conversationId}/messages`, { token: u.token, body: { content } });
const ch_messagesOf = async (u, conversationId, query = "") =>
    (await call("GET", `/conversations/${conversationId}/messages${query}`, { token: u.token })).body;

// --- Histórico com before ----------------------------------------------------

const dmAB = await ch_openDm(chA, chB);
const ch_sent = [];
for (let i = 1; i <= 5; i++) ch_sent.push((await ch_send(chA, dmAB, `mensagem ${i}`)).body?.message);
const ch_latest = await ch_messagesOf(chA, dmAB, "?limit=2");
check(
    "últimas mensagens com hasMore",
    ch_latest?.data?.map((m) => m.content).join() === "mensagem 4,mensagem 5" && ch_latest.hasMore === true,
    JSON.stringify(ch_latest),
);
const ch_older = await ch_messagesOf(chA, dmAB, `?limit=2&beforeId=${ch_latest.data[0].messageId}`);
check(
    "histórico com beforeId traz as anteriores, sem repetir",
    ch_older?.data?.map((m) => m.content).join() === "mensagem 2,mensagem 3" && ch_older.hasMore === true,
    JSON.stringify(ch_older?.data?.map((m) => m.content)),
);
const ch_oldest = await ch_messagesOf(chA, dmAB, `?limit=5&before=${encodeURIComponent(ch_older.data[0].createdAt)}`);
check(
    "histórico com before (timestamp) chega ao começo",
    ch_oldest?.data?.map((m) => m.content).join() === "mensagem 1" && ch_oldest.hasMore === false,
    JSON.stringify(ch_oldest),
);

// --- Excluir mensagem própria -------------------------------------------------

const ch_target = ch_sent[4];
check(
    "só o autor apaga a mensagem → 404 para o outro",
    (await call("DELETE", `/conversations/${dmAB}/messages/${ch_target.messageId}`, { token: chB.token })).status === 404,
);
check(
    "quem não participa não apaga → 404",
    (await call("DELETE", `/conversations/${dmAB}/messages/${ch_target.messageId}`, { token: chC.token })).status === 404,
);
check(
    "autor apaga a própria mensagem",
    (await call("DELETE", `/conversations/${dmAB}/messages/${ch_target.messageId}`, { token: chA.token })).status === 204,
);
const ch_afterDelete = (await ch_messagesOf(chB, dmAB)).data.find((m) => m.messageId === ch_target.messageId);
check(
    "mensagem apagada vira placeholder sem conteúdo",
    ch_afterDelete?.isDeleted === true && ch_afterDelete.content === null,
    JSON.stringify(ch_afterDelete),
);
check(
    "apagar de novo → 404",
    (await call("DELETE", `/conversations/${dmAB}/messages/${ch_target.messageId}`, { token: chA.token })).status === 404,
);
const ch_listAfterDelete = await call("GET", "/conversations", { token: chB.token });
check(
    "prévia da conversa ignora a mensagem apagada e conta as não lidas",
    ch_listAfterDelete.body?.data?.[0]?.lastMessageContent === "mensagem 4" &&
        ch_listAfterDelete.body.data[0].unreadCount === 4 &&
        ch_listAfterDelete.body.unreadTotal === 4,
    JSON.stringify(ch_listAfterDelete.body?.data?.[0]),
);

// --- Visto ---------------------------------------------------------------------

await call("POST", `/conversations/${dmAB}/read`, { token: chB.token });
const ch_detail = await call("GET", `/conversations/${dmAB}`, { token: chA.token });
const ch_bRead = ch_detail.body?.participants?.find((p) => p.userId === chB.id)?.lastReadAt;
check(
    "detalhe da conversa expõe o last_read_at do outro (visto)",
    ch_detail.status === 200 &&
        ch_detail.body.conversation.isGroup === false &&
        new Date(ch_bRead) >= new Date(ch_sent[3].createdAt),
    JSON.stringify(ch_detail.body),
);
check(
    "detalhe de conversa alheia → 404",
    (await call("GET", `/conversations/${dmAB}`, { token: chC.token })).status === 404,
);

// --- Paginação da lista de conversas ------------------------------------------

await ch_openDm(chA, chC);
await ch_send(chA, await ch_openDm(chA, chC), "oi C");
await ch_send(chA, await ch_openDm(chA, chD), "oi D");
const ch_convPage1 = await call("GET", "/conversations?limit=2", { token: chA.token });
const ch_convPage2 = await call("GET", `/conversations?limit=2&cursor=${ch_convPage1.body?.nextCursor}`, { token: chA.token });
check(
    "lista de conversas paginada por cursor",
    ch_convPage1.body?.data?.length === 2 &&
        Boolean(ch_convPage1.body.nextCursor) &&
        ch_convPage2.body?.data?.length === 1 &&
        ch_convPage2.body.nextCursor === null &&
        ch_convPage2.body.data[0].conversationId === dmAB,
    JSON.stringify(ch_convPage2.body),
);
check("cursor inválido → 400", (await call("GET", "/conversations?cursor=lixo", { token: chA.token })).status === 400);

// --- Tempo real (SSE) ------------------------------------------------------------

/** Abre o stream como o navegador faria e junta os eventos recebidos. */
async function ch_openStream(u, ticketOverride) {
    const ticket = ticketOverride ?? (await call("POST", "/stream/ticket", { token: u.token })).body?.ticket;
    const controller = new AbortController();
    const res = await fetch(`${BASE}/stream?ticket=${encodeURIComponent(ticket)}`, { signal: controller.signal });
    const events = [];
    if (res.ok) {
        (async () => {
            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            try {
                for (;;) {
                    const { value, done } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    let index;
                    while ((index = buffer.indexOf("\n\n")) >= 0) {
                        const block = buffer.slice(0, index);
                        buffer = buffer.slice(index + 2);
                        const type = /^event: (.+)$/m.exec(block)?.[1];
                        const data = /^data: (.+)$/m.exec(block)?.[1];
                        if (type) events.push({ type, data: data ? JSON.parse(data) : null });
                    }
                }
            } catch {
                /* abortado */
            }
        })();
    }
    const waitFor = async (predicate, ms = 1500) => {
        const until = Date.now() + ms;
        while (Date.now() < until) {
            const found = events.find(predicate);
            if (found) return found;
            await new Promise((r) => setTimeout(r, 25));
        }
        return null;
    };
    return { status: res.status, ticket, events, waitFor, close: () => controller.abort() };
}

const ch_ticketRes = await call("POST", "/stream/ticket", { token: chA.token });
check(
    "ticket do stream exige login e vem com validade curta",
    (await call("POST", "/stream/ticket")).status === 401 &&
        ch_ticketRes.status === 200 &&
        typeof ch_ticketRes.body?.ticket === "string" &&
        ch_ticketRes.body.expiresIn === 60,
    JSON.stringify(ch_ticketRes.body),
);
const streamA = await ch_openStream(chA, ch_ticketRes.body.ticket);
check(
    "stream abre com o ticket e manda ready",
    streamA.status === 200 && Boolean(await streamA.waitFor((e) => e.type === "ready")),
);
const ch_reused = await ch_openStream(chA, ch_ticketRes.body.ticket);
check("ticket é de uso único → 401 na segunda vez", ch_reused.status === 401);
check("ticket inválido → 401", (await ch_openStream(chA, "x".repeat(43))).status === 401);

const { createHash } = await import("node:crypto");
const ch_expiredTicket = "ticket-vencido-de-teste-com-tamanho-suficiente";
const { rows: chASession } = await db.query(
    "SELECT session_id FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL LIMIT 1",
    [chA.id],
);
await db.query(
    `INSERT INTO stream_tickets (ticket_hash, user_id, session_id, expires_at)
     VALUES ($1, $2, $3, NOW() - INTERVAL '1 second')`,
    [createHash("sha256").update(ch_expiredTicket).digest("hex"), chA.id, chASession[0].session_id],
);
check("ticket vencido → 401", (await ch_openStream(chA, ch_expiredTicket)).status === 401);
check(
    "ticket fica só como hash no banco",
    (await db.query("SELECT 1 FROM stream_tickets WHERE ticket_hash = $1", [ch_ticketRes.body.ticket])).rows.length === 0,
);

const streamB = await ch_openStream(chB);
const streamC = await ch_openStream(chC);
await streamB.waitFor((e) => e.type === "ready");
await streamC.waitFor((e) => e.type === "ready");

const ch_liveStart = Date.now();
const ch_live = await ch_send(chA, dmAB, "chegou em tempo real?");
const ch_liveId = ch_live.body?.message?.messageId;
const bGotMessage = await streamB.waitFor((e) => e.type === "message:new" && e.data.messageId === ch_liveId);
const ch_liveMs = Date.now() - ch_liveStart;
check(
    "mensagem nova chega por SSE ao outro participante (< 1 s)",
    Boolean(bGotMessage) && bGotMessage.data.conversationId === dmAB && ch_liveMs < 1000,
    `${ch_liveMs} ms`,
);
check(
    "quem envia também recebe (outras abas)",
    Boolean(await streamA.waitFor((e) => e.type === "message:new" && e.data.messageId === ch_liveId)),
);

await call("POST", `/conversations/${dmAB}/typing`, { token: chA.token });
const bTyping = await streamB.waitFor((e) => e.type === "typing");
check(
    "digitando chega ao outro, com o nome",
    bTyping?.data?.conversationId === dmAB && bTyping.data.userId === chA.id && bTyping.data.name === "cha",
    JSON.stringify(bTyping),
);
await call("POST", `/conversations/${dmAB}/read`, { token: chB.token });
check(
    "visto chega ao outro participante",
    Boolean(await streamA.waitFor((e) => e.type === "conversation:read" && e.data.userId === chB.id)),
);
await call("DELETE", `/conversations/${dmAB}/messages/${ch_liveId}`, { token: chA.token });
check(
    "exclusão chega por SSE",
    Boolean(await streamB.waitFor((e) => e.type === "message:deleted" && e.data.messageId === ch_liveId)),
);
await call("POST", `/users/${chA.id}/follow`, { token: chC.token });
check(
    "notificação nova chega por SSE",
    Boolean(await streamA.waitFor((e) => e.type === "notification:new" && e.data.type === "follow")),
);
check(
    "quem não participa da conversa não recebe nada dela",
    !streamC.events.some((e) => e.data?.conversationId === dmAB) &&
        !streamA.events.some((e) => e.type === "typing"),
    JSON.stringify(streamC.events.map((e) => e.type)),
);

// --- Grupos ---------------------------------------------------------------------

const ch_group = await call("POST", "/conversations/groups", {
    token: chA.token,
    body: { title: "Turma do café", userIds: [chB.id, chC.id] },
});
const ch_groupId = ch_group.body?.conversationId;
const ch_groupDetail = await call("GET", `/conversations/${ch_groupId}`, { token: chA.token });
const ch_groupMessages = await ch_messagesOf(chB, ch_groupId);
check(
    "cria grupo: criador admin, participantes e mensagem de sistema",
    ch_group.status === 201 &&
        ch_groupDetail.body?.conversation?.isGroup === true &&
        ch_groupDetail.body.conversation.title === "Turma do café" &&
        ch_groupDetail.body.conversation.myRole === "admin" &&
        ch_groupDetail.body.participants.length === 3 &&
        ch_groupMessages?.data?.[0]?.kind === "system" &&
        ch_groupMessages.data[0].content === "cha criou o grupo “Turma do café”",
    JSON.stringify(ch_groupMessages?.data),
);
check(
    "grupo avisa os participantes por SSE",
    Boolean(await streamC.waitFor((e) => e.type === "conversation:updated" && e.data.conversationId === ch_groupId)),
);
check(
    "grupo sem ninguém → 400; com conta inexistente → 404",
    (await call("POST", "/conversations/groups", { token: chA.token, body: { title: "X", userIds: [] } })).status === 400 &&
        (
            await call("POST", "/conversations/groups", {
                token: chA.token,
                body: { title: "X", userIds: ["00000000-0000-4000-8000-000000000000"] },
            })
        ).status === 404,
);

check(
    "membro não renomeia → 403",
    (await call("PATCH", `/conversations/${ch_groupId}`, { token: chB.token, body: { title: "Hack" } })).status === 403,
);
const ch_renamed = await call("PATCH", `/conversations/${ch_groupId}`, { token: chA.token, body: { title: "Café & cia" } });
check("admin renomeia", ch_renamed.status === 200 && ch_renamed.body?.title === "Café & cia");
check(
    "renomear conversa 1:1 → 400",
    (await call("PATCH", `/conversations/${dmAB}`, { token: chA.token, body: { title: "x" } })).status === 400,
);

check(
    "membro não adiciona → 403",
    (await call("POST", `/conversations/${ch_groupId}/participants`, { token: chB.token, body: { userIds: [chD.id] } })).status === 403,
);
const ch_addD = await call("POST", `/conversations/${ch_groupId}/participants`, { token: chA.token, body: { userIds: [chD.id] } });
check("admin adiciona pessoa", ch_addD.status === 201 && ch_addD.body?.added?.[0] === chD.id, JSON.stringify(ch_addD.body));
check(
    "adicionar quem já está → 400",
    (await call("POST", `/conversations/${ch_groupId}/participants`, { token: chA.token, body: { userIds: [chB.id] } })).status === 400,
);
const ch_tooMany = Array.from({ length: 17 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`);
check(
    "limite de 20 pessoas por grupo → 400",
    (await call("POST", `/conversations/${ch_groupId}/participants`, { token: chA.token, body: { userIds: ch_tooMany } })).status === 400,
);

check(
    "membro não remove outra pessoa → 403",
    (await call("DELETE", `/conversations/${ch_groupId}/participants/${chC.id}`, { token: chB.token })).status === 403,
);
check(
    "admin remove pessoa, que perde o acesso",
    (await call("DELETE", `/conversations/${ch_groupId}/participants/${chC.id}`, { token: chA.token })).status === 204 &&
        (await call("GET", `/conversations/${ch_groupId}/messages`, { token: chC.token })).status === 404,
);
check(
    "quem foi removido é avisado por SSE",
    Boolean(
        await streamC.waitFor(
            (e) => e.type === "conversation:updated" && e.data.conversationId === ch_groupId && streamC.events.filter((x) => x.data?.conversationId === ch_groupId).length >= 3,
        ),
    ),
);
check(
    "membro sai do grupo",
    (await call("DELETE", `/conversations/${ch_groupId}/participants/${chB.id}`, { token: chB.token })).status === 204,
);
await call("DELETE", `/conversations/${ch_groupId}/participants/${chA.id}`, { token: chA.token });
const ch_dDetail = await call("GET", `/conversations/${ch_groupId}`, { token: chD.token });
const ch_systemTexts = (await ch_messagesOf(chD, ch_groupId)).data.filter((m) => m.kind === "system").map((m) => m.content);
check(
    "admin sai: o mais antigo que sobrou assume",
    ch_dDetail.body?.conversation?.myRole === "admin" && ch_dDetail.body.participants.length === 1,
    JSON.stringify(ch_dDetail.body),
);
check(
    "mensagens de sistema contam a história do grupo",
    ch_systemTexts.join(" | ") ===
        [
            "cha criou o grupo “Turma do café”",
            "cha renomeou o grupo para “Café & cia”",
            "cha adicionou chd ao grupo",
            "cha removeu chc do grupo",
            "chb saiu do grupo",
            "cha saiu do grupo",
        ].join(" | "),
    ch_systemTexts.join(" | "),
);
const ch_dList = await call("GET", "/conversations", { token: chD.token });
check(
    "mensagem de sistema não conta como não lida",
    ch_dList.body?.data?.find((c) => c.conversationId === ch_groupId)?.unreadCount === 0,
    JSON.stringify(ch_dList.body?.data),
);
check(
    "mensagem de sistema não pode ser apagada",
    (
        await call("DELETE", `/conversations/${ch_groupId}/messages/${(await ch_messagesOf(chD, ch_groupId)).data[0].messageId}`, {
            token: chA.token,
        })
    ).status === 404,
);

streamA.close();
streamB.close();
streamC.close();

console.log("\n[Conta A] Verificação de e-mail");
resetRateLimits();

const a_tokenFromMail = (mail) => {
    const link = mail?.text.match(/https?:\/\/\S+#token=(\S+)/)?.[1];
    return link ? decodeURIComponent(link) : null;
};

const a_vEmail = `verif${stamp}@famax.test`;
let a_vMark = outbox.length;
const a_vReg = await call("POST", "/auth/register", {
    keepUnverified: true,
    body: {
        email: a_vEmail,
        username: `verif${stamp}`.slice(0, 30),
        password: "senha123!forte",
        displayName: "Vera Verificação",
        termsAccepted: true,
    },
});
const a_vToken = a_vReg.body?.token;
const a_vMail = await nextMailTo(a_vEmail, a_vMark);
check(
    "cadastro manda o link de verificação e nasce não verificado",
    a_vReg.status === 201 &&
        a_vReg.body.user.emailVerified === false &&
        Boolean(a_tokenFromMail(a_vMail)) &&
        a_vMail.text.includes("/html/user-pages/verify-email.html#token=") &&
        (await call("GET", "/me", { token: a_vToken })).body?.user?.emailVerified === false,
    a_vMail?.text,
);

const a_blockedCommunity = await call("POST", "/communities", {
    token: a_vToken,
    body: { name: `Sem verificar ${stamp}`, categoryId },
});
check(
    "sem verificar não cria comunidade (403 EMAIL_NOT_VERIFIED)",
    a_blockedCommunity.status === 403 && a_blockedCommunity.body?.code === "EMAIL_NOT_VERIFIED",
    JSON.stringify(a_blockedCommunity.body),
);
const a_vConv = await call("POST", "/conversations", { token: a_vToken, body: { userId: bobId } });
const a_blockedMessage = await call("POST", `/conversations/${a_vConv.body?.conversationId}/messages`, {
    token: a_vToken,
    body: { content: "oi" },
});
check(
    "sem verificar não manda mensagem; navegar e abrir conversa continuam livres",
    a_vConv.status === 201 &&
        a_blockedMessage.status === 403 &&
        a_blockedMessage.body?.code === "EMAIL_NOT_VERIFIED" &&
        (await call("GET", "/communities", { token: a_vToken })).status === 200,
);

a_vMark = outbox.length;
const a_resend = await call("POST", "/auth/resend-verification", { token: a_vToken });
const a_resentMail = await nextMailTo(a_vEmail, a_vMark);
check("reenvio manda um link novo", a_resend.status === 200 && Boolean(a_tokenFromMail(a_resentMail)));
await call("POST", "/auth/resend-verification", { token: a_vToken });
await call("POST", "/auth/resend-verification", { token: a_vToken });
check(
    "reenvio tem limite",
    (await call("POST", "/auth/resend-verification", { token: a_vToken })).status === 429,
);

check(
    "token inválido → 400",
    (await call("POST", "/auth/verify-email", { body: { token: "lixo" } })).status === 400,
);
const a_verified = await call("POST", "/auth/verify-email", { body: { token: a_tokenFromMail(a_vMail) } });
check(
    "link confirma o e-mail (sem precisar de sessão)",
    a_verified.status === 200 && (await call("GET", "/me", { token: a_vToken })).body?.user?.emailVerified === true,
    JSON.stringify(a_verified.body),
);
check(
    "verificado cria comunidade",
    (
        await call("POST", "/communities", {
            token: a_vToken,
            body: { name: `Verificada ${stamp}`, categoryId },
        })
    ).status === 201,
);
resetRateLimits();
check(
    "já verificado: reenvio → 400",
    (await call("POST", "/auth/resend-verification", { token: a_vToken })).status === 400,
);

// Troca de e-mail
const a_newEmail = `verif-novo${stamp}@famax.test`;
check(
    "troca de e-mail exige a senha",
    (await call("PATCH", "/me/email", { token: a_vToken, body: { a_newEmail, password: "errada" } })).status === 400,
);
check(
    "troca para e-mail de outra conta → 409",
    (await call("PATCH", "/me/email", { token: a_vToken, body: { newEmail: alice.email, password: "senha123!forte" } }))
        .status === 409,
);
a_vMark = outbox.length;
const a_change = await call("PATCH", "/me/email", {
    token: a_vToken,
    body: { newEmail: a_newEmail.toUpperCase(), password: "senha123!forte" },
});
const a_changeMail = await nextMailTo(a_newEmail, a_vMark);
const a_noticeMail = await nextMailTo(a_vEmail, a_vMark);
check(
    "troca fica pendente: link para o novo, aviso para o antigo",
    a_change.status === 200 &&
        a_change.body?.user?.pendingEmail === a_newEmail &&
        a_change.body.user.email === a_vEmail &&
        Boolean(a_tokenFromMail(a_changeMail)) &&
        a_noticeMail?.subject.includes("troca de e-mail"),
    JSON.stringify(a_change.body?.user),
);
check(
    "enquanto pendente, o login segue no e-mail antigo",
    (await call("POST", "/auth/login", { body: { identifier: a_vEmail, password: "senha123!forte" } })).status === 200,
);
const a_confirmChange = await call("POST", "/auth/verify-email", { body: { token: a_tokenFromMail(a_changeMail) } });
const a_afterChange = (await call("GET", "/me", { token: a_vToken })).body?.user;
check(
    "confirmar o link troca o e-mail",
    a_confirmChange.status === 200 &&
        a_afterChange?.email === a_newEmail &&
        a_afterChange.pendingEmail === null &&
        a_afterChange.emailVerified === true &&
        (await call("POST", "/auth/login", { body: { identifier: a_newEmail, password: "senha123!forte" } })).status === 200,
    JSON.stringify(a_afterChange),
);
check(
    "link do e-mail antigo deixa de valer",
    (await call("POST", "/auth/verify-email", { body: { token: a_tokenFromMail(a_vMail) } })).status === 400,
);
await call("PATCH", "/me/email", { token: a_vToken, body: { newEmail: `outro${stamp}@famax.test`, password: "senha123!forte" } });
const a_cancelled = await call("DELETE", "/me/email/pending", { token: a_vToken });
check("cancelar a troca pendente", a_cancelled.status === 200 && a_cancelled.body?.user?.pendingEmail === null);

console.log("\n[Conta B] Verificação em duas etapas");
resetRateLimits();

const b_OTPAuth = await import("otpauth");
const b_tfUser = await newUser("tfa");
const b_tfName = `tfa${stamp}`.slice(0, 30);
const b_codeAt = (secret, offsetSeconds = 0) =>
    new b_OTPAuth.TOTP({ secret: b_OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30, algorithm: "SHA1" }).generate({
        timestamp: Date.now() + offsetSeconds * 1000,
    });

const b_setup = await call("POST", "/me/2fa/setup", { token: b_tfUser.token });
const b_tfSecret = b_setup.body?.secret;
check(
    "setup devolve segredo, URI otpauth e QR",
    b_setup.status === 200 &&
        /^[A-Z2-7]+=*$/.test(b_tfSecret) &&
        b_setup.body.otpauthUri.startsWith("otpauth://totp/FAMAX:") &&
        b_setup.body.otpauthUri.includes(`secret=${b_tfSecret}`) &&
        b_setup.body.qrCode.startsWith("data:image/png;base64,"),
    JSON.stringify(b_setup.body).slice(0, 200),
);
const { rows: b_storedSecret } = await db.query(
    "SELECT two_factor_pending_secret AS s, two_factor_enabled AS on FROM users WHERE user_id = $1",
    [b_tfUser.id],
);
check(
    "segredo fica cifrado no banco e a 2FA ainda não liga",
    b_storedSecret[0].s.startsWith("v1:") && !b_storedSecret[0].s.includes(b_tfSecret) && b_storedSecret[0].on === false,
);
check(
    "ativar com código errado → 400",
    (await call("POST", "/me/2fa/enable", { token: b_tfUser.token, body: { code: "000000" } })).status === 400,
);
// Guardado: o teste de replay usa o MESMO código (recalcular poderia cair no
// passo seguinte, se a suíte cruzasse a virada dos 30 s).
const b_enableCode = b_codeAt(b_tfSecret);
const b_enabled = await call("POST", "/me/2fa/enable", { token: b_tfUser.token, body: { code: b_enableCode } });
const b_recoveryCodes = b_enabled.body?.recoveryCodes ?? [];
check(
    "ativar com o código do app liga a 2FA e mostra 10 códigos de recuperação",
    b_enabled.status === 200 && b_recoveryCodes.length === 10 && /^[a-z2-9]{5}-[a-z2-9]{5}$/.test(b_recoveryCodes[0]),
    JSON.stringify(b_enabled.body),
);
check(
    "/me mostra a 2FA ativa e os códigos restantes",
    (await call("GET", "/me", { token: b_tfUser.token })).body?.user?.twoFactorEnabled === true &&
        (await call("GET", "/me", { token: b_tfUser.token })).body.user.recoveryCodesLeft === 10,
);
check(
    "códigos de recuperação ficam só como hash",
    (await db.query("SELECT 1 FROM two_factor_recovery_codes WHERE code_hash LIKE $1", [`%${b_recoveryCodes[0]}%`])).rows
        .length === 0,
);

const b_tfLogin = () => call("POST", "/auth/login", { body: { identifier: b_tfName, password: "senha123!forte" } });
const b_step1 = await b_tfLogin();
check(
    "login com 2FA não abre sessão: devolve mfaToken",
    b_step1.status === 200 && b_step1.body?.mfaRequired === true && Boolean(b_step1.body.mfaToken) && !b_step1.body.token,
    JSON.stringify(b_step1.body),
);
check("mfaToken não vale como sessão", (await call("GET", "/me", { token: b_step1.body.mfaToken })).status === 401);
const b_mfa = (mfaToken, code) => call("POST", "/auth/login/2fa", { body: { mfaToken, code } });
check("segundo passo com código errado → 400", (await b_mfa(b_step1.body.mfaToken, "123456")).status === 400);
check(
    "código já usado (o da ativação) não serve de novo",
    (await b_mfa(b_step1.body.mfaToken, b_enableCode)).status === 400,
);
const b_step2 = await b_mfa(b_step1.body.mfaToken, b_codeAt(b_tfSecret, 30));
check(
    "segundo passo com o código do app emite a sessão",
    b_step2.status === 200 && Boolean(b_step2.body?.token) && (await call("GET", "/me", { token: b_step2.body.token })).status === 200,
    JSON.stringify(b_step2.body),
);
check("mfaToken inválido → 401", (await b_mfa("lixo", "123456")).status === 401);

const b_viaRecovery = await b_mfa((await b_tfLogin()).body.mfaToken, b_recoveryCodes[0].toUpperCase());
check(
    "código de recuperação entra e diz quantos sobraram",
    b_viaRecovery.status === 200 && Boolean(b_viaRecovery.body?.token) && b_viaRecovery.body.recoveryCodesLeft === 9,
    JSON.stringify(b_viaRecovery.body),
);
check(
    "código de recuperação é de uso único",
    (await b_mfa((await b_tfLogin()).body.mfaToken, b_recoveryCodes[0])).status === 400,
);

resetRateLimits();
const b_regenerated = await call("POST", "/me/2fa/recovery-codes", {
    token: b_tfUser.token,
    body: { password: "senha123!forte", code: b_recoveryCodes[1] },
});
check(
    "gerar códigos novos (senha + código) invalida os antigos",
    b_regenerated.status === 200 &&
        b_regenerated.body?.recoveryCodes?.length === 10 &&
        (await b_mfa((await b_tfLogin()).body.mfaToken, b_recoveryCodes[2])).status === 400,
    JSON.stringify(b_regenerated.body).slice(0, 120),
);

resetRateLimits();
const b_lockoutToken = (await b_tfLogin()).body.mfaToken;
for (let i = 0; i < 5; i++) await b_mfa(b_lockoutToken, "000000");
check("segundo passo tem limite forte por conta", (await b_mfa(b_lockoutToken, "000000")).status === 429);
resetRateLimits();

check(
    "desativar exige a senha",
    (
        await call("POST", "/me/2fa/disable", {
            token: b_tfUser.token,
            body: { password: "errada", code: b_regenerated.body.recoveryCodes[0] },
        })
    ).status === 400,
);
const b_disabled = await call("POST", "/me/2fa/disable", {
    token: b_tfUser.token,
    body: { password: "senha123!forte", code: b_regenerated.body.recoveryCodes[0] },
});
const b_plainLogin = await b_tfLogin();
check(
    "desativar (senha + código) volta ao login de um passo",
    b_disabled.status === 200 &&
        Boolean(b_plainLogin.body?.token) &&
        !b_plainLogin.body.mfaRequired &&
        (await db.query("SELECT two_factor_secret FROM users WHERE user_id = $1", [b_tfUser.id])).rows[0].two_factor_secret ===
            null,
    JSON.stringify(b_plainLogin.body).slice(0, 120),
);

console.log("\n[Conta C] Sessões ativas");
resetRateLimits();

const c_sesUser = await newUser("sessoes");
const c_sesName = `sessoes${stamp}`.slice(0, 30);
const c_loginWith = async (userAgent) => {
    const res = await fetch(`${BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": userAgent },
        body: JSON.stringify({ identifier: c_sesName, password: "senha123!forte" }),
    });
    return (await res.json()).token;
};
const c_phoneToken = await c_loginWith(
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36",
);
const c_firefoxToken = await c_loginWith("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0");

const c_sessionsList = await call("GET", "/me/sessions", { token: c_phoneToken });
const c_devices = c_sessionsList.body?.data ?? [];
check(
    "lista as sessões com dispositivo, IP parcial e a atual marcada",
    c_sessionsList.status === 200 &&
        c_devices.length === 3 &&
        c_devices.some((s) => s.device === "Chrome no Android" && s.current === true) &&
        c_devices.some((s) => s.device === "Firefox no Windows" && s.current === false) &&
        c_devices.every((s) => s.ip === null || s.ip === "rede local" || /\*/.test(s.ip)) &&
        c_devices.filter((s) => s.current).length === 1,
    JSON.stringify(c_devices),
);

const c_firefoxSession = c_devices.find((s) => s.device === "Firefox no Windows");
check(
    "sessão de outra pessoa → 404",
    (await call("DELETE", `/me/sessions/${c_firefoxSession.sessionId}`, { token: aliceToken })).status === 404,
);
check(
    "encerrar uma sessão derruba o token dela",
    (await call("DELETE", `/me/sessions/${c_firefoxSession.sessionId}`, { token: c_phoneToken })).status === 204 &&
        (await call("GET", "/me", { token: c_firefoxToken })).status === 401 &&
        (await call("GET", "/me", { token: c_phoneToken })).status === 200,
);
check(
    "sair de todos os outros mantém só esta",
    (await call("POST", "/me/sessions/revoke-others", { token: c_phoneToken })).status === 204 &&
        (await call("GET", "/me", { token: c_sesUser.token })).status === 401 &&
        (await call("GET", "/me/sessions", { token: c_phoneToken })).body?.data?.length === 1,
);
check("lista de sessões exige login", (await call("GET", "/me/sessions")).status === 401);

console.log("\n[Conta D] Exportar dados e excluir conta");
resetRateLimits();

const d_delOwner = await newUser("deldono");
const d_delUser = await newUser("delconta");
const d_delName = `delconta${stamp}`.slice(0, 30);
const d_delEmail = `delconta${stamp}@famax.test`;
const d_delCommunity = await call("POST", "/communities", {
    token: d_delOwner.token,
    body: { name: `Exclusões ${stamp}`, categoryId },
});
const d_delCid = d_delCommunity.body?.community?.communityId;
await call("POST", `/communities/${d_delCid}/join`, { token: d_delUser.token });
await call("PATCH", "/me/profile", { token: d_delUser.token, body: { bio: "Minha bio original" } });
await call("PUT", "/me/social-links", {
    token: d_delUser.token,
    body: { links: [{ platform: "github", url: "https://github.com/exemplo" }] },
});
const d_delPost = await call("POST", "/posts", {
    token: d_delUser.token,
    body: { communityId: d_delCid, title: "Post de quem vai sair", content: "conteúdo" },
});
const d_delPostId = d_delPost.body?.post?.postId;
await call("POST", `/posts/${d_delPostId}/comments`, { token: d_delUser.token, body: { content: "meu comentário" } });
const d_delConv = await call("POST", "/conversations", { token: d_delUser.token, body: { userId: d_delOwner.id } });
await call("POST", `/conversations/${d_delConv.body?.conversationId}/messages`, {
    token: d_delUser.token,
    body: { content: "mensagem minha" },
});
await call("POST", `/conversations/${d_delConv.body?.conversationId}/messages`, {
    token: d_delOwner.token,
    body: { content: "mensagem da outra pessoa" },
});

// Exportar
const d_exportRes = await fetch(`${BASE}/me/export`, {
    method: "POST",
    headers: { Authorization: `Bearer ${d_delUser.token}` },
});
const d_exported = await d_exportRes.json();
check(
    "exportar devolve um JSON para download com os dados da pessoa",
    d_exportRes.status === 200 &&
        /attachment; filename="famax-dados-/.test(d_exportRes.headers.get("content-disposition") ?? "") &&
        d_exported.account?.email === d_delEmail &&
        d_exported.profile?.bio === "Minha bio original" &&
        d_exported.posts?.some((p) => p.title === "Post de quem vai sair") &&
        d_exported.comments?.some((c) => c.content === "meu comentário") &&
        d_exported.communities?.some((c) => c.name === `Exclusões ${stamp}`) &&
        d_exported.termsAcceptance?.length === 1,
    JSON.stringify(d_exported).slice(0, 300),
);
check(
    "exportação só traz as mensagens que a pessoa enviou",
    d_exported.messagesSent?.length === 1 && d_exported.messagesSent[0].content === "mensagem minha",
    JSON.stringify(d_exported.messagesSent),
);
check("exportar exige login", (await call("POST", "/me/export")).status === 401);

// Excluir
const d_ownerDelete = await call("DELETE", "/me", { token: d_delOwner.token, body: { password: "senha123!forte" } });
check(
    "dono de comunidade não exclui a conta sem transferir → 409 com a lista",
    d_ownerDelete.status === 409 && d_ownerDelete.body?.communities?.[0] === `Exclusões ${stamp}`,
    JSON.stringify(d_ownerDelete.body),
);
check(
    "excluir exige a senha",
    (await call("DELETE", "/me", { token: d_delUser.token, body: { password: "errada" } })).status === 400,
);
const d_deleted = await call("DELETE", "/me", { token: d_delUser.token, body: { password: "senha123!forte" } });
const d_daysLeft = (new Date(d_deleted.body?.reactivateUntil) - Date.now()) / 86_400_000;
check(
    "excluir: prazo de 30 dias para reativar e sessão encerrada",
    d_deleted.status === 200 &&
        d_daysLeft > 29.9 &&
        d_daysLeft <= 30 &&
        (await call("GET", "/me", { token: d_delUser.token })).status === 401,
    JSON.stringify(d_deleted.body),
);
const d_postAfter = await call("GET", `/posts/${d_delPostId}`);
check(
    "perfil some e o conteúdo fica como “Usuário removido”",
    (await call("GET", `/users/${d_delUser.id}`)).status === 404 &&
        d_postAfter.body?.post?.authorDisplayName === "Usuário removido" &&
        (await db.query("SELECT 1 FROM user_social_links WHERE user_id = $1", [d_delUser.id])).rows.length === 0,
    JSON.stringify(d_postAfter.body?.post).slice(0, 200),
);
const d_deletedLogin = await call("POST", "/auth/login", { body: { identifier: d_delName, password: "senha123!forte" } });
check(
    "login com a senha certa oferece reativar",
    d_deletedLogin.status === 403 && d_deletedLogin.body?.reactivatable === true && Boolean(d_deletedLogin.body.reactivateUntil),
    JSON.stringify(d_deletedLogin.body),
);
check(
    "senha errada não revela que a conta foi excluída",
    (await call("POST", "/auth/login", { body: { identifier: d_delName, password: "errada" } })).status === 401,
);
check(
    "durante o prazo o e-mail continua reservado",
    (
        await call("POST", "/auth/register", {
            body: { email: d_delEmail, username: `outro${stamp}`.slice(0, 30), password: "senha123!forte", displayName: "X", termsAccepted: true },
        })
    ).status === 409,
);

resetRateLimits();
check(
    "reativar exige a senha",
    (await call("POST", "/auth/reactivate", { body: { identifier: d_delName, password: "errada" } })).status === 401,
);
const d_reactivated = await call("POST", "/auth/reactivate", { body: { identifier: d_delName, password: "senha123!forte" } });
const d_meBack = (await call("GET", "/me", { token: d_reactivated.body?.token })).body?.user;
check(
    "reativar devolve a conta, o perfil e as redes",
    d_reactivated.status === 200 &&
        d_meBack?.displayName === "delconta" &&
        d_meBack.bio === "Minha bio original" &&
        d_meBack.socialLinks?.length === 1,
    JSON.stringify(d_meBack).slice(0, 200),
);

// Exclusão definitiva (o job, com o prazo vencido à força)
await call("DELETE", "/me", { token: d_reactivated.body?.token, body: { password: "senha123!forte" } });
await db.query("UPDATE account_deletions SET purge_after = NOW() - INTERVAL '1 minute' WHERE user_id = $1", [d_delUser.id]);
const { purgeExpiredAccounts: d_purgeExpiredAccounts } = await import("../server/lib/account.js");
const d_purgedCount = await d_purgeExpiredAccounts();
const { rows: d_purgedRow } = await db.query("SELECT email, username, password_hash FROM users WHERE user_id = $1", [
    d_delUser.id,
]);
check(
    "depois do prazo: e-mail e username trocados, vínculos apagados",
    d_purgedCount >= 1 &&
        d_purgedRow[0].email.endsWith("@removido.invalid") &&
        d_purgedRow[0].username.startsWith("removido_") &&
        d_purgedRow[0].password_hash === "!" &&
        (await db.query("SELECT 1 FROM account_deletions WHERE user_id = $1", [d_delUser.id])).rows.length === 0 &&
        (await db.query("SELECT 1 FROM user_sessions WHERE user_id = $1", [d_delUser.id])).rows.length === 0,
    JSON.stringify(d_purgedRow[0]),
);
resetRateLimits();
check(
    "depois do prazo não há mais reativação, e o e-mail fica livre",
    (await call("POST", "/auth/reactivate", { body: { identifier: d_delName, password: "senha123!forte" } })).status === 401 &&
        (
            await call("POST", "/auth/register", {
                body: { email: d_delEmail, username: d_delName, password: "senha123!forte", displayName: "Nova", termsAccepted: true },
            })
        ).status === 201,
);
check(
    "posts e mensagens de quem saiu continuam, anônimos",
    (await call("GET", `/posts/${d_delPostId}`)).body?.post?.authorDisplayName === "Usuário removido" &&
        (await call("GET", `/conversations/${d_delConv.body?.conversationId}/messages`, { token: d_delOwner.token })).body?.data
            ?.length === 2,
);

console.log("\n[Conta E] Bloquear usuário");
resetRateLimits();

const blA = await newUser("blqa");
const blB = await newUser("blqb");
const blC = await newUser("blqc");
const blBName = `blqb${stamp}`.slice(0, 30);
const blCommunity = await call("POST", "/communities", {
    token: blA.token,
    body: { name: `Bloqueios ${stamp}`, categoryId },
});
const blCid = blCommunity.body?.community?.communityId;
await call("POST", `/communities/${blCid}/join`, { token: blB.token });
await call("POST", `/communities/${blCid}/join`, { token: blC.token });
await call("POST", `/users/${blA.id}/follow`, { token: blB.token });
const blConv = await call("POST", "/conversations", { token: blB.token, body: { userId: blA.id } });

check("bloquear a si mesmo → 400", (await call("POST", `/users/${blA.id}/block`, { token: blA.token })).status === 400);
check(
    "bloquear conta inexistente → 404",
    (await call("POST", "/users/00000000-0000-4000-8000-000000000000/block", { token: blA.token })).status === 404,
);
const e_blocked = await call("POST", `/users/${blB.id}/block`, { token: blA.token });
check(
    "bloquear (idempotente) desfaz os follows entre os dois",
    e_blocked.status === 200 &&
        e_blocked.body?.blocked === true &&
        (await call("POST", `/users/${blB.id}/block`, { token: blA.token })).status === 200 &&
        (await call("GET", `/users/${blA.id}`, { token: blA.token })).body?.user?.stats?.followers === 0,
);
check(
    "ninguém segue ninguém com bloqueio",
    (await call("POST", `/users/${blA.id}/follow`, { token: blB.token })).status === 403 &&
        (await call("POST", `/users/${blB.id}/follow`, { token: blA.token })).status === 403,
);
check(
    "bloqueado não manda mensagem (nem quem bloqueou)",
    (
        await call("POST", `/conversations/${blConv.body?.conversationId}/messages`, {
            token: blB.token,
            body: { content: "oi" },
        })
    ).status === 403 &&
        (await call("POST", "/conversations", { token: blA.token, body: { userId: blB.id } })).status === 403,
);
check(
    "não dá para pôr o bloqueado num grupo",
    (
        await call("POST", "/conversations/groups", {
            token: blA.token,
            body: { title: "Grupo", userIds: [blB.id, blC.id] },
        })
    ).status === 403,
);
const blSearchA = await call("GET", `/search?q=${blBName}&type=users`, { token: blA.token });
const blSearchC = await call("GET", `/search?q=${blBName}&type=users`, { token: blC.token });
// A busca de pessoas é aproximada (trigramas) e casa com outras contas da
// suíte; o que importa é o bloqueado — e só ele — sumir para quem bloqueou.
check(
    "quem bloqueou não vê o bloqueado na busca; os outros veem",
    blSearchA.body?.results?.users?.total === blSearchC.body?.results?.users?.total - 1,
    `${blSearchA.body?.results?.users?.total} / ${blSearchC.body?.results?.users?.total}`,
);
check(
    "busca do chat esconde nos dois sentidos",
    (await call("GET", `/users?search=${blBName}`, { token: blA.token })).body?.data?.length === 0 &&
        (await call("GET", `/users?search=blqa${stamp}`, { token: blB.token })).body?.data?.length === 0,
);

const blPostA = await call("POST", "/posts", {
    token: blA.token,
    body: { communityId: blCid, title: "Post da A", content: "x" },
});
const blPostB = await call("POST", "/posts", {
    token: blB.token,
    body: { communityId: blCid, title: "Post do B", content: "x" },
});
await call("POST", `/posts/${blPostA.body?.post?.postId}/comments`, { token: blB.token, body: { content: "comentário do B" } });
await call("POST", `/posts/${blPostA.body?.post?.postId}/reactions`, { token: blB.token });
check(
    "quem bloqueou não recebe avisos do bloqueado",
    !(await call("GET", "/notifications", { token: blA.token })).body?.data?.some((n) => n.actorId === blB.id),
);
const e_feedForA = (await call("GET", `/communities/${blCid}/posts`, { token: blA.token })).body?.data ?? [];
const e_feedForC = (await call("GET", `/communities/${blCid}/posts`, { token: blC.token })).body?.data ?? [];
check(
    "posts do bloqueado vêm marcados para quem bloqueou (e só para ele)",
    e_feedForA.find((p) => p.postId === blPostB.body?.post?.postId)?.authorBlockedByMe === true &&
        e_feedForA.find((p) => p.postId === blPostA.body?.post?.postId)?.authorBlockedByMe === false &&
        e_feedForC.find((p) => p.postId === blPostB.body?.post?.postId)?.authorBlockedByMe === false,
);
const e_commentsForA = await call("GET", `/posts/${blPostA.body?.post?.postId}/comments`, { token: blA.token });
const e_commentsAnon = await call("GET", `/posts/${blPostA.body?.post?.postId}/comments`);
check(
    "comentários do bloqueado vêm marcados para quem bloqueou",
    e_commentsForA.body?.data?.[0]?.authorBlockedByMe === true &&
        e_commentsAnon.body?.data?.[0]?.authorBlockedByMe === false,
);

const e_blockList = await call("GET", "/me/blocks", { token: blA.token });
check(
    "lista de bloqueados e perfil com blockedByMe",
    e_blockList.body?.data?.length === 1 &&
        e_blockList.body.data[0].userId === blB.id &&
        (await call("GET", `/users/${blB.id}`, { token: blA.token })).body?.user?.blockedByMe === true,
    JSON.stringify(e_blockList.body),
);
const e_unblocked = await call("DELETE", `/users/${blB.id}/block`, { token: blA.token });
check(
    "desbloquear libera mensagem e follow de novo",
    e_unblocked.body?.blocked === false &&
        (
            await call("POST", `/conversations/${blConv.body?.conversationId}/messages`, {
                token: blB.token,
                body: { content: "oi de novo" },
            })
        ).status === 201 &&
        (await call("POST", `/users/${blA.id}/follow`, { token: blB.token })).status === 200,
);

console.log("\n[Conta F] Conteúdo adulto (+18)");
resetRateLimits();

const nsAdult = await newUser("nsadulto");
const nsMinor = await newUser("nsmenor");
// is_adult direto no banco: pela API ele exige nascimento com 18+ (prompt 04).
await db.query("UPDATE users SET is_adult = TRUE WHERE user_id = $1", [nsAdult.id]);

const nsCommunityName = `Adultos ${stamp}`;
check(
    "menor não cria comunidade +18",
    (
        await call("POST", "/communities", {
            token: nsMinor.token,
            body: { name: `Bloqueada ${stamp}`, categoryId, isNsfw: "true" },
        })
    ).status === 403,
);
const nsCommunity = await call("POST", "/communities", {
    token: nsAdult.token,
    body: { name: nsCommunityName, categoryId, isNsfw: "true" },
});
const nsCid = nsCommunity.body?.community?.communityId;
check("adulto cria comunidade +18", nsCommunity.status === 201 && nsCommunity.body.community.isNsfw === true);

const f_homeList = (await call("GET", "/communities?limit=50", { token: nsAdult.token })).body?.data ?? [];
check("comunidade +18 fica fora da home (até para adultos)", !f_homeList.some((c) => c.communityId === nsCid));
check(
    "página da comunidade avisa quem não pode ver",
    (await call("GET", `/communities/${nsCid}`, { token: nsMinor.token })).body?.community?.nsfwBlocked === true &&
        (await call("GET", `/communities/${nsCid}`)).body?.community?.nsfwBlocked === true &&
        (await call("GET", `/communities/${nsCid}`, { token: nsAdult.token })).body?.community?.nsfwBlocked === false,
);
check("menor não entra em comunidade +18", (await call("POST", `/communities/${nsCid}/join`, { token: nsMinor.token })).status === 403);

// Post +18 numa comunidade comum
const nsNormal = await call("POST", "/communities", {
    token: nsAdult.token,
    body: { name: `Comum ${stamp}`, categoryId },
});
const nsNormalId = nsNormal.body?.community?.communityId;
await call("POST", `/communities/${nsNormalId}/join`, { token: nsMinor.token });
check(
    "menor não publica post +18",
    (
        await call("POST", "/posts", {
            token: nsMinor.token,
            body: { communityId: nsNormalId, title: "Tentativa", content: "x", isNsfw: true },
        })
    ).status === 403,
);
const nsPost = await call("POST", "/posts", {
    token: nsAdult.token,
    body: { communityId: nsNormalId, title: "Post adulto", content: "conteúdo +18 secreto", isNsfw: true },
});
const nsPostId = nsPost.body?.post?.postId;
const nsInNsfw = await call("POST", "/posts", {
    token: nsAdult.token,
    body: { communityId: nsCid, title: "Na comunidade +18", content: "também secreto" },
});
check(
    "post +18 criado; em comunidade +18 todo post conta como +18",
    nsPost.status === 201 && nsPost.body.post.isNsfw === true && nsInNsfw.body?.post?.isNsfw === true,
);

const f_asMinor = await call("GET", `/posts/${nsPostId}`, { token: nsMinor.token });
const f_asVisitor = await call("GET", `/posts/${nsPostId}`);
const f_asAdult = await call("GET", `/posts/${nsPostId}`, { token: nsAdult.token });
check(
    "quem não pode ver recebe só o título, sem o conteúdo",
    f_asMinor.body?.post?.nsfwHidden === true &&
        f_asMinor.body.post.content === "" &&
        f_asMinor.body.post.title === "Post adulto" &&
        f_asVisitor.body?.post?.content === "" &&
        f_asAdult.body?.post?.nsfwHidden === false &&
        f_asAdult.body.post.content === "conteúdo +18 secreto",
    JSON.stringify(f_asMinor.body?.post).slice(0, 200),
);
const f_feedMinor = (await call("GET", `/communities/${nsNormalId}/posts`, { token: nsMinor.token })).body?.data ?? [];
check(
    "no feed também",
    f_feedMinor.find((p) => p.postId === nsPostId)?.content === "" &&
        !JSON.stringify(f_feedMinor).includes("conteúdo +18 secreto"),
);
check(
    "comentários de post +18: 403 para quem não pode ver",
    (await call("GET", `/posts/${nsPostId}/comments`, { token: nsMinor.token })).status === 403 &&
        (await call("GET", `/posts/${nsPostId}/comments`)).status === 403 &&
        (await call("GET", `/posts/${nsPostId}/comments`, { token: nsAdult.token })).status === 200 &&
        (
            await call("POST", `/posts/${nsPostId}/comments`, { token: nsMinor.token, body: { content: "oi" } })
        ).status === 403,
);
const f_profilePosts = (await call("GET", `/users/${nsAdult.id}/posts`, { token: nsMinor.token })).body?.data ?? [];
check(
    "aba Posts do perfil esconde o conteúdo +18",
    f_profilePosts.length >= 2 && f_profilePosts.every((p) => p.nsfwHidden === true && p.content === ""),
    JSON.stringify(f_profilePosts).slice(0, 200),
);

const f_searchFor = (u, q, type) => call("GET", `/search?q=${encodeURIComponent(q)}&type=${type}`, { token: u?.token });
check(
    "busca: +18 só para adultos",
    (await f_searchFor(nsMinor, "secreto", "posts")).body?.results?.posts?.total === 0 &&
        (await f_searchFor(nsAdult, "secreto", "posts")).body?.results?.posts?.total === 2 &&
        !(await f_searchFor(nsMinor, nsCommunityName, "communities")).body?.results?.communities?.data?.some(
            (c) => c.communityId === nsCid,
        ) &&
        (await f_searchFor(nsAdult, nsCommunityName, "communities")).body?.results?.communities?.data?.some(
            (c) => c.communityId === nsCid && c.isNsfw === true,
        ),
);
const f_minorPost = await call("POST", "/posts", {
    token: nsMinor.token,
    body: { communityId: nsNormalId, title: "Post comum", content: "x" },
});
check(
    "menor não marca o próprio post como +18",
    (await call("PATCH", `/posts/${f_minorPost.body?.post?.postId}`, { token: nsMinor.token, body: { isNsfw: true } }))
        .status === 403,
);

// ---------------------------------------------------------------------------

console.log(`\n${"=".repeat(60)}`);
console.log(`Resultado: ${passed} passaram, ${failed} falharam`);
if (failures.length > 0) {
    console.log("Falhas:");
    for (const name of failures) console.log(`  - ${name}`);
}
console.log("=".repeat(60));

await pgServer.stop();
await db.close();
process.exit(failed > 0 ? 1 : 0);
