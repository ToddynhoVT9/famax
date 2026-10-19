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

async function call(method, endpoint, { token, body, raw } = {}) {
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
    return { status: response.status, body: payload };
}

// ---------------------------------------------------------------------------

console.log("Iniciando Postgres em processo (PGlite)...");
const db = await PGlite.create();
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
const categoryId = categories.body?.data?.[0]?.category_id;

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
const subCategoryId = detail.body?.categories?.[0]?.community_category_id;

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
    feed.status === 200 && feed.body.data.some((c) => c.community_id === communityId),
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
const postId = post.body?.post?.post_id;

// Subcategoria existe, mas é da comunidade do dave (criada no upload de capa).
const daveCommunity = await call(
    "GET",
    `/communities/${coverOk.body?.community?.communityId}`,
);
const foreignSubCategoryId = daveCommunity.body?.categories?.[0]?.community_category_id;
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
const commentId = comment.body?.comment?.comment_id;
check(
    "comentário volta com autor resolvido",
    comment.body?.comment?.author_display_name === "Bob Teste",
    JSON.stringify(comment.body?.comment),
);

const afterComment = await call("GET", `/communities/${communityId}/posts`);
check(
    "comments_count incrementou",
    afterComment.body?.data?.[0]?.comments_count === 1,
    `count=${afterComment.body?.data?.[0]?.comments_count}`,
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
    feedAsBob.body?.data?.[0]?.liked_by_me === true,
    JSON.stringify(feedAsBob.body?.data?.[0]?.liked_by_me),
);

const feedAnon = await call("GET", `/communities/${communityId}/posts`);
check(
    "liked_by_me = false sem sessão",
    feedAnon.body?.data?.[0]?.liked_by_me === false,
);

const deleteOther = await call("DELETE", `/comments/${commentId}`, {
    token: aliceToken,
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
    afterDelete.body?.data?.[0]?.comments_count === 1,
    `count=${afterDelete.body?.data?.[0]?.comments_count}`,
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
    listForBob.body?.data?.[0]?.unread_count === 1,
    `unread=${listForBob.body?.data?.[0]?.unread_count}`,
);
check(
    "lista traz a última mensagem e o outro participante",
    listForBob.body?.data?.[0]?.last_message_content === "Oi Bob!" &&
        listForBob.body?.data?.[0]?.other_display_name === "Alice Teste",
    JSON.stringify(listForBob.body?.data?.[0]).slice(0, 200),
);

const read = await call("POST", `/conversations/${conversationId}/read`, {
    token: bobToken,
});
check("marca como lida", read.status === 204);

const afterRead = await call("GET", "/conversations", { token: bobToken });
check(
    "unread_count zera após leitura",
    afterRead.body?.data?.[0]?.unread_count === 0,
    `unread=${afterRead.body?.data?.[0]?.unread_count}`,
);

// Cursor do polling.
const cursor = sent.body?.message?.created_at;
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
    erinOptional.status === 200 && erinOptional.body?.data?.[0]?.liked_by_me === false,
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
