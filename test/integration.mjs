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
await call("POST", `/posts/${ivyPost.body?.post?.post_id}/comments`, {
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
        ivyPosts.body.data[0].community_name === communityName &&
        ivyPosts.body.pagination?.total === 1,
    JSON.stringify(ivyPosts.body).slice(0, 200),
);

const ivyComments = await call("GET", `/users/${ivyId}/comments`);
check(
    "GET /users/:id/comments traz o post e a comunidade de cada resposta",
    ivyComments.status === 200 &&
        ivyComments.body?.data?.[0]?.content === "Comentário da Ivy" &&
        ivyComments.body.data[0].post_title === "Post da Ivy" &&
        ivyComments.body.data[0].community_name === communityName,
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
        "cover_image_url" in (c6AsBob.body?.community ?? {}) &&
        c6AsBob.body.community.owner_id === aliceReg.body?.user?.userId &&
        c6AsBob.body.community.category_id === categoryId &&
        c6AsBob.body.community.my_role === "member",
    JSON.stringify(c6AsBob.body?.community).slice(0, 240),
);
check(
    "my_role é null para visitante",
    (await call("GET", `/communities/${c6Id}`)).body?.community?.my_role === null,
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
        (await call("GET", `/communities/${c6Id}`, { token: carolToken })).body?.community?.my_role === null,
);

// Posts: editar e excluir só pelo autor.
const subcats = c6AsBob.body?.categories ?? [];
const bobPost6 = await call("POST", "/posts", {
    token: bobToken,
    body: { communityId: c6Id, title: "Post do Bob", content: "Original" },
});
const bobPost6Id = bobPost6.body?.post?.post_id;
check(
    "post novo não aparece como editado",
    bobPost6.body?.post?.edited_at === null,
    JSON.stringify(bobPost6.body?.post).slice(0, 160),
);

// Curtir mexe em posts.updated_at (trigger), mas não pode marcar "editado".
await call("POST", `/posts/${bobPost6Id}/reactions`, { token: aliceToken });
const afterLike = await call("GET", `/communities/${c6Id}/posts`);
check(
    "curtida não marca o post como editado",
    afterLike.body?.data?.[0]?.edited_at === null,
    JSON.stringify(afterLike.body?.data?.[0]).slice(0, 160),
);

const editByOther = await call("PATCH", `/posts/${bobPost6Id}`, {
    token: aliceToken,
    body: { title: "Sequestrado" },
});
check("editar post alheio → 404", editByOther.status === 404, String(editByOther.status));

const editOwn = await call("PATCH", `/posts/${bobPost6Id}`, {
    token: bobToken,
    body: { title: "Post do Bob (editado)", content: "Novo conteúdo", communityCategoryId: subcats[1]?.community_category_id },
});
check(
    "autor edita título, conteúdo e subcategoria; edited_at preenchido",
    editOwn.status === 200 &&
        editOwn.body?.post?.title === "Post do Bob (editado)" &&
        editOwn.body.post.content === "Novo conteúdo" &&
        editOwn.body.post.category_name === subcats[1]?.name &&
        editOwn.body.post.edited_at !== null &&
        editOwn.body.post.liked_by_me === false,
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
const alicePost6Id = alicePost6.body?.post?.post_id;
const bobAnswer6 = await call("POST", `/posts/${alicePost6Id}/comments`, {
    token: bobToken,
    body: { content: "Respondendo a Alice" },
});
await call("PUT", `/posts/${alicePost6Id}/resolution`, {
    token: aliceToken,
    body: { commentId: bobAnswer6.body?.comment?.comment_id },
});
const unanswered = await call("GET", `/communities/${c6Id}/posts?unanswered=true`);
check(
    "filtro unanswered traz só posts sem resposta aceita",
    unanswered.status === 200 &&
        unanswered.body?.data?.length === 1 &&
        unanswered.body.data[0].post_id === bobPost6Id &&
        unanswered.body.pagination?.total === 1,
    JSON.stringify(unanswered.body?.pagination),
);

// Comentários aninhados, edição e "[comentário removido]".
const rootComment = await call("POST", `/posts/${alicePost6Id}/comments`, {
    token: aliceToken,
    body: { content: "Raiz da conversa" },
});
const rootId = rootComment.body?.comment?.comment_id;
const reply1 = await call("POST", `/posts/${alicePost6Id}/comments`, {
    token: bobToken,
    body: { content: "Resposta nível 1", parentCommentId: rootId },
});
const reply2 = await call("POST", `/posts/${alicePost6Id}/comments`, {
    token: aliceToken,
    body: { content: "Resposta nível 2", parentCommentId: reply1.body?.comment?.comment_id },
});
check(
    "resposta volta com parent_comment_id",
    reply2.status === 201 && reply2.body?.comment?.parent_comment_id === reply1.body?.comment?.comment_id,
);

const tree = await call("GET", `/posts/${alicePost6Id}/comments`);
const byId = new Map((tree.body?.data ?? []).map((c) => [c.comment_id, c]));
check(
    "comentários vêm planos com parent_comment_id e replies_count",
    tree.status === 200 &&
        byId.get(rootId)?.replies_count === 1 &&
        byId.get(reply1.body?.comment?.comment_id)?.replies_count === 1 &&
        byId.get(reply2.body?.comment?.comment_id)?.parent_comment_id === reply1.body?.comment?.comment_id,
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
        editComment.body.comment.edited_at !== null,
    JSON.stringify(editComment.body).slice(0, 160),
);

await call("DELETE", `/comments/${rootId}`, { token: aliceToken });
const treeAfterDelete = await call("GET", `/posts/${alicePost6Id}/comments`);
const removedRoot = treeAfterDelete.body?.data?.find((c) => c.comment_id === rootId);
check(
    "comentário apagado com respostas vira [removido] sem autor nem texto",
    removedRoot?.is_deleted === true &&
        removedRoot.content === null &&
        removedRoot.author_id === null &&
        treeAfterDelete.body.data.some((c) => c.comment_id === reply2.body?.comment?.comment_id),
    JSON.stringify(removedRoot),
);

// Folha apagada some de vez.
const leaf = await call("POST", `/posts/${alicePost6Id}/comments`, {
    token: bobToken,
    body: { content: "Folha que será apagada" },
});
await call("DELETE", `/comments/${leaf.body?.comment?.comment_id}`, { token: bobToken });
const treeLeaf = await call("GET", `/posts/${alicePost6Id}/comments`);
check(
    "comentário apagado sem respostas some da listagem",
    !treeLeaf.body?.data?.some((c) => c.comment_id === leaf.body?.comment?.comment_id),
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
const rootsOf = (body) => (body?.data ?? []).filter((c) => c.parent_comment_id === null).map((c) => c.comment_id);
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
    !listAfterDelete.body?.data?.some((p) => p.post_id === bobPost6Id),
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
        !(await call("GET", "/communities?limit=50")).body?.data?.some((c) => c.community_id === c6Id),
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
const searchPostId = searchPost.body?.post?.post_id;

const sCommunities = await call("GET", `/search?q=${encodeURIComponent(`torrefa ${tag}`.slice(0, 7))}&type=communities`);
check(
    "busca de comunidades acha por pedaço do nome",
    sCommunities.status === 200 &&
        sCommunities.body?.results?.communities?.data?.some((c) => c.community_id === searchCommunityId),
    JSON.stringify(sCommunities.body).slice(0, 200),
);

// Tolerância a erro de digitação (pg_trgm): uma letra trocada no nome único.
const typo = `${tag.slice(0, -1)}x`;
const sTypo = await call("GET", `/search?q=${encodeURIComponent(`Torrefação ${typo}`)}&type=communities`);
check(
    "busca de comunidades tolera erro de digitação",
    sTypo.body?.results?.communities?.data?.[0]?.community_id === searchCommunityId,
    JSON.stringify(sTypo.body?.results?.communities?.data?.map((c) => c.name)),
);

const sPosts = await call("GET", `/search?q=${encodeURIComponent(`moedor ${tag}`)}&type=posts`);
check(
    "busca de posts por prefixo de palavra (full-text)",
    sPosts.status === 200 &&
        sPosts.body?.results?.posts?.data?.[0]?.post_id === searchPostId &&
        sPosts.body.results.posts.data[0].community_name === `Torrefação ${tag}`,
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
    body?.results?.users?.data?.some((u) => u.user_id === lenaReg.body?.user?.userId) ?? false;

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
        singlePost.body?.post?.post_id === searchPostId &&
        singlePost.body.post.community_id === searchCommunityId &&
        singlePost.body.post.community_name === `Torrefação ${tag}` &&
        singlePost.body.post.liked_by_me === false,
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
        members.body.data[1].user_id === mod.id &&
        Boolean(members.body.data[0].joined_at) &&
        members.body.pagination.total === 4,
    JSON.stringify(members.body).slice(0, 200),
);
const onlyMods = await call("GET", `/communities/${modCid}/members?role=moderator`);
check(
    "filtro de membros por papel",
    onlyMods.body?.data?.length === 1 && onlyMods.body.data[0].user_id === mod.id,
    JSON.stringify(onlyMods.body).slice(0, 200),
);

// --- Remoção de conteúdo ------------------------------------------------------

const trollPost = await call("POST", "/posts", {
    token: troll.token,
    body: { communityId: modCid, title: "Post problemático", content: "conteúdo ruim" },
});
const trollPostId = trollPost.body?.post?.post_id;
check(
    "post traz o papel do autor e de quem vê",
    trollPost.body?.post?.author_role === "member" && trollPost.body.post.viewer_role === "member",
    JSON.stringify(trollPost.body?.post).slice(0, 200),
);
const ownerPost = await call("POST", "/posts", {
    token: owner.token,
    body: { communityId: modCid, title: "Aviso da dona", content: "bem-vindos" },
});
const ownerPostId = ownerPost.body?.post?.post_id;

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
const trollCommentId = trollComment.body?.comment?.comment_id;
check(
    "comentário traz o papel do autor",
    trollComment.body?.comment?.author_role === "member",
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
        queue.body.data.every((r) => r.post_title === "Post problemático" && r.author_id === troll.id) &&
        !queue.body.data.some((r) => r.target_type === "user"),
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
        closedQueue.body.data.some((r) => r.report_id === report2.body?.report?.reportId),
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
    trollCommunity.body?.community?.my_role === null &&
        trollCommunity.body.community.is_banned === true &&
        Boolean(trollCommunity.body.community.my_ban_expires_at),
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
    bans.status === 200 && bans.body?.data?.[0]?.user_id === troll.id,
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
    directBan.status === 201 && directBan.body?.ban?.expires_at === null,
    JSON.stringify(directBan.body),
);

// Remover conteúdo pela denúncia.
const memberPost = await call("POST", "/posts", {
    token: member.token,
    body: { communityId: modCid, title: "Post fora do tema", content: "nada a ver" },
});
const memberPostId = memberPost.body?.post?.post_id;
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
        removeVia.body?.report?.target_deleted === true &&
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
        adminQueue.body?.data?.some((r) => r.target_type === "user" && r.author_id === troll.id) &&
        adminQueue.body.data.every((r) => r.target_type === "user"),
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
        afterTransfer.body?.community?.owner_id === mod.id &&
        afterTransfer.body.community.my_role === "moderator",
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
const nPostId = nPost.body?.post?.post_id;

const notifsOf = async (u, query = "") => (await call("GET", `/notifications${query}`, { token: u.token })).body;
const unreadOf = async (u) => (await call("GET", "/notifications/unread-count", { token: u.token })).body?.unread;

check("sem notificações no começo", (await unreadOf(nAuthor)) === 0);
check("rota exige login", (await call("GET", "/notifications")).status === 401);

// --- Comentário e resposta --------------------------------------------------

const fanComment = await call("POST", `/posts/${nPostId}/comments`, {
    token: nFan.token,
    body: { content: "Ótimo post!" },
});
const fanCommentId = fanComment.body?.comment?.comment_id;
let authorList = await notifsOf(nAuthor);
check(
    "comentar no post avisa o autor (post_comment)",
    authorList?.data?.length === 1 &&
        authorList.data[0].type === "post_comment" &&
        authorList.data[0].actor_id === nFan.id &&
        authorList.data[0].post_id === nPostId &&
        authorList.data[0].comment_id === fanCommentId &&
        authorList.data[0].post_title === "Post com avisos" &&
        authorList.data[0].comment_excerpt === "Ótimo post!" &&
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
        fanList.data[0].actor_id === nAuthor.id,
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
    likes.length === 1 && likes[0].actor_id === nThird.id && likes[0].likes_count === 2,
    JSON.stringify(likes),
);

await call("POST", `/posts/${nPostId}/reactions`, { token: nThird.token }); // descurte
likes = (await notifsOf(nAuthor)).data.filter((n) => n.type === "post_like");
check(
    "descurtir passa o aviso para a curtida anterior",
    likes.length === 1 && likes[0].actor_id === nFan.id && likes[0].likes_count === 1,
    JSON.stringify(likes),
);
await call("POST", `/posts/${nPostId}/reactions`, { token: nFan.token }); // descurte
likes = (await notifsOf(nAuthor)).data.filter((n) => n.type === "post_like");
check("like seguido de unlike não deixa aviso órfão", likes.length === 0, JSON.stringify(likes));

// --- Marcar como lida --------------------------------------------------------

const beforeRead = await notifsOf(nAuthor);
const firstId = beforeRead.data[0].notification_id;
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
        Boolean((await notifsOf(nAuthor)).data.find((n) => n.notification_id === firstId)?.read_at),
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
        !pageB.data.some((n) => pageA.data.some((m) => m.notification_id === n.notification_id)),
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
    roleNotif?.data?.role === "moderator" && roleNotif.community_name === `Avisos ${stamp}`,
    JSON.stringify(roleNotif),
);

const thirdPost = await call("POST", "/posts", {
    token: nThird.token,
    body: { communityId: nCid, title: "Post que será removido", content: "x" },
});
const thirdPostId = thirdPost.body?.post?.post_id;
await call("POST", `/posts/${thirdPostId}/reactions`, { token: nFan.token });
await call("DELETE", `/posts/${thirdPostId}`, { token: nFan.token });
const thirdList = (await notifsOf(nThird)).data;
const removedNotif = thirdList.find((n) => n.type === "content_removed");
check(
    "remoção pela moderação avisa o autor, sem dizer quem removeu",
    removedNotif?.data?.title === "Post que será removido" && removedNotif.actor_id === null,
    JSON.stringify(removedNotif),
);
check(
    "avisos de post apagado somem (a curtida no post removido)",
    !thirdList.some((n) => n.type === "post_like" && n.post_id === thirdPostId),
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
    (await board(period))?.data?.find((row) => row.user_id === u.id)?.points ?? 0;
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
const lbPostId = lbPost.body?.post?.post_id;
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
    weekBoard?.data?.[0]?.user_id === lbAuthor.id &&
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
const lbPost2Id = lbPost2.body?.post?.post_id;
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
await call("DELETE", `/comments/${lbFanComment.body?.comment?.comment_id}`, { token: lbOwner.token });
check(
    "comentário removido pela moderação: −1 ao autor do post, −10 a quem comentou",
    (await pointsOf(lbAuthor)) === 6 && (await dbPoints(lbFan)) === -10,
    `${await pointsOf(lbAuthor)} / ${await dbPoints(lbFan)}`,
);
check("pontuação negativa não aparece no ranking", !(await board()).data.some((r) => r.user_id === lbFan.id));

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
    biaNotifs.length === 1 && biaNotifs[0].actor_id === fAna.id,
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
        biaFollowers.body.data[0].user_id === fAna.id &&
        biaFollowers.body.data[0].followed_by_me === false &&
        anaFollowing.body?.data?.[0]?.user_id === fBia.id,
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
        !followersB.body.data.some((u) => followersA.body.data.some((v) => v.user_id === u.user_id)) &&
        followersA.body.data[0].user_id === fDeb.id,
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
await call("DELETE", `/posts/${biaGone.body?.post?.post_id}`, { token: fBia.token });

const anaFeed = await call("GET", "/feed/following", { token: fAna.token });
const evaFeed = await call("GET", "/feed/following", { token: fEva.token });
check(
    "feed Seguindo traz posts de quem a pessoa segue",
    anaFeed.status === 200 &&
        anaFeed.body?.data?.some((p) => p.post_id === biaPost.body?.post?.post_id) &&
        anaFeed.body.data.every((p) => p.author_id === fBia.id || p.author_id === fCid.id) &&
        anaFeed.body.data[0].community_name === `Seguindo ${stamp}`,
    JSON.stringify(anaFeed.body).slice(0, 300),
);
check(
    "feed Seguindo não traz post apagado",
    !anaFeed.body?.data?.some((p) => p.post_id === biaGone.body?.post?.post_id),
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
    const id = created.body?.post?.post_id;
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
    return (res.body?.data ?? []).map((p) => sorted[p.post_id]).join(",");
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
        sortEcho.body.data.map((p) => sorted[p.post_id]).join(",") === "P4,P1",
    JSON.stringify(sortEcho.body?.data?.map((p) => sorted[p.post_id])),
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
    pPosts.push(created.body?.post?.post_id);
}
const pin = (u, postId) => call("POST", `/posts/${postId}/pin`, { token: u.token });
const unpin = (u, postId) => call("DELETE", `/posts/${postId}/pin`, { token: u.token });
const feedIds = async (query = "") =>
    ((await call("GET", `/communities/${pCid}/posts${query}`)).body?.data ?? []).map((p) => p.post_id);

check("membro comum não fixa → 403", (await pin(pMember, pPosts[0])).status === 403);
const pinned1 = await pin(pMod, pPosts[0]);
check(
    "moderador fixa e o post volta com pinned_at",
    pinned1.status === 200 && Boolean(pinned1.body?.post?.pinned_at),
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
    pUnpinned.status === 200 && pUnpinned.body?.post?.pinned_at === null && (await pin(pOwner, pPosts[3])).status === 200,
);
await call("DELETE", `/posts/${pPosts[2]}`, { token: pMember.token });
check("post fixado excluído não ocupa vaga", (await pin(pOwner, pPosts[4])).status === 200);
check("membro comum não desafixa → 403", (await unpin(pMember, pPosts[0])).status === 403);

// Resposta aceita.
const pAnswer = await call("POST", `/posts/${pPosts[0]}/comments`, {
    token: pMod.token,
    body: { content: "Faz assim, ó." },
});
const answerId = pAnswer.body?.comment?.comment_id;
const otherPostComment = await call("POST", `/posts/${pPosts[1]}/comments`, {
    token: pMod.token,
    body: { content: "Outro post" },
});
const resolve = (u, postId, commentId) =>
    call("PUT", `/posts/${postId}/resolution`, { token: u.token, body: { commentId } });

check("só o autor marca a resposta aceita → 404 para os outros", (await resolve(pOwner, pPosts[0], answerId)).status === 404);
check(
    "comentário de outro post não pode ser a resposta → 400",
    (await resolve(pMember, pPosts[0], otherPostComment.body?.comment?.comment_id)).status === 400,
);
const pResolved = await resolve(pMember, pPosts[0], answerId);
check(
    "autor marca a resposta aceita",
    pResolved.status === 200 && pResolved.body?.post?.resolved_comment_id === answerId,
    JSON.stringify(pResolved.body).slice(0, 200),
);
check(
    "\"Ajudar os outros\" deixa de fora o post resolvido",
    !(await feedIds("?unanswered=true")).includes(pPosts[0]) && (await feedIds("?unanswered=true")).includes(pPosts[1]),
);
const pUnresolved = await call("DELETE", `/posts/${pPosts[0]}/resolution`, { token: pMember.token });
check(
    "autor desmarca a resposta aceita",
    pUnresolved.status === 200 && pUnresolved.body?.post?.resolved_comment_id === null &&
        (await feedIds("?unanswered=true")).includes(pPosts[0]),
);
await resolve(pMember, pPosts[0], answerId);
await call("DELETE", `/comments/${answerId}`, { token: pMod.token });
const pAfterDelete = await call("GET", `/posts/${pPosts[0]}`);
check(
    "excluir a resposta aceita reabre a pergunta",
    pAfterDelete.body?.post?.resolved_comment_id === null,
    JSON.stringify(pAfterDelete.body?.post?.resolved_comment_id),
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
const rPostId = rPost.body?.post?.post_id;
const react = (u, type) =>
    call("POST", `/posts/${rPostId}/reactions`, { token: u.token, body: type ? { type } : undefined });
const ownerPoints = async () =>
    (await call("GET", `/communities/${rCid}/leaderboard`)).body?.data?.find((r) => r.user_id === rOwner.id)?.points;
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
    fanView.body?.post?.my_reaction === "haha" &&
        fanView.body.post.liked_by_me === true &&
        fanView.body.post.reaction_counts?.haha === 1,
    JSON.stringify(fanView.body?.post).slice(0, 300),
);

await react(rOther, "sad");
const both = await call("GET", `/posts/${rPostId}`);
check(
    "contagem por tipo e total de reações",
    both.body?.post?.likes_count === 2 &&
        both.body.post.reaction_counts?.sad === 1 &&
        both.body.post.reaction_counts.haha === 1 &&
        both.body.post.my_reaction === null,
    JSON.stringify(both.body?.post?.reaction_counts),
);
check(
    "aviso agrupado conta todas as reações",
    (await likeNotifs())[0]?.likes_count === 2 && (await likeNotifs())[0]?.actor_id === rOther.id,
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
    svPosts.push(created.body?.post?.post_id);
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
    readerSaved?.data?.map((p) => p.post_id).join() === [svPosts[2], svPosts[1], svPosts[0]].join() &&
        readerSaved.data.every((p) => p.saved_by_me === true) &&
        readerSaved.pagination?.total === 3,
    JSON.stringify(readerSaved?.pagination),
);
check(
    "post traz saved_by_me para quem salvou, e só para ele",
    (await call("GET", `/posts/${svPosts[0]}`, { token: svReader.token })).body?.post?.saved_by_me === true &&
        (await call("GET", `/posts/${svPosts[0]}`, { token: svAuthor.token })).body?.post?.saved_by_me === false,
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
const mPostId = mPost.body?.post?.post_id;
let friendMentions = await mentionsOf(mFriend);
check(
    "menção no post avisa a pessoa (sem diferenciar maiúsculas)",
    friendMentions.length === 1 &&
        friendMentions[0].post_id === mPostId &&
        friendMentions[0].actor_id === mAuthor.id &&
        friendMentions[0].comment_id === null,
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
    body: { content: `@${mAuthorName} concordo! @${mFriendName} o que acha?`, parentCommentId: mRoot.body?.comment?.comment_id },
});
const authorNotifs = (await call("GET", "/notifications", { token: mAuthor.token })).body?.data ?? [];
friendMentions = await mentionsOf(mFriend);
check(
    "menção em comentário avisa com o comentário, sem aviso duplo para o respondido",
    friendMentions.length === 2 &&
        Boolean(friendMentions[0].comment_id) &&
        authorNotifs.filter((n) => n.type === "comment_reply").length === 1 &&
        authorNotifs.filter((n) => n.type === "mention").length === 0,
    JSON.stringify(authorNotifs.map((n) => n.type)),
);

const mThirdComment = await call("POST", `/posts/${mPostId}/comments`, {
    token: mThird.token,
    body: { content: "sem menção" },
});
await call("PATCH", "/me/settings", { token: mFriend.token, body: { notifyReplies: false } });
await call("PATCH", `/comments/${mThirdComment.body?.comment?.comment_id}`, {
    token: mThird.token,
    body: { content: `agora com @${mFriendName}` },
});
check("menção respeita a preferência de respostas", (await mentionsOf(mFriend)).length === 2);
await call("PATCH", "/me/settings", { token: mFriend.token, body: { notifyReplies: true } });
await call("PATCH", `/comments/${mThirdComment.body?.comment?.comment_id}`, {
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

const firstImage = withImages.body?.post?.images?.[0]?.image_id;
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
const laterId = later.body?.event?.event_id;
const soonerId = sooner.body?.event?.event_id;
check(
    "dono e moderador criam evento",
    later.status === 201 &&
        sooner.status === 201 &&
        later.body.event.title === "Degustação de cafés" &&
        later.body.event.location === "https://meet.example.com/cafe" &&
        later.body.event.attendees_count === 0 &&
        later.body.event.creator_id === eOwner.id,
    JSON.stringify(later.body).slice(0, 300),
);

const memberEventNotifs = await eventNotifs(eMember);
check(
    "evento novo avisa os membros",
    memberEventNotifs.length === 2 &&
        memberEventNotifs.some((n) => n.event_id === laterId && n.event_title === "Degustação de cafés"),
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
    upcoming.body?.data?.map((e) => e.event_id).join() === [soonerId, laterId].join() &&
        past.body?.data?.length === 1 &&
        past.body.data[0].title === "Encontro antigo" &&
        past.body.data[0].is_past === true,
    JSON.stringify(upcoming.body?.data?.map((e) => e.title)),
);
check(
    "widget pede só o próximo",
    (await call("GET", `/communities/${eCid}/events?limit=1`)).body?.data?.[0]?.event_id === soonerId,
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
        (await call("GET", `/events/${laterId}`)).body?.event?.attendees_count === 1,
);
check("quem não é membro não marca presença → 403", (await attend(eOutsider, laterId)).status === 403);
check("evento que já terminou não aceita presença → 400", (await attend(eMember, past.body?.data?.[0]?.event_id)).status === 400);
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
        !(await eventNotifs(eMember)).some((n) => n.event_id === laterId),
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
