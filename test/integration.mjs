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

console.log("Aplicando migrations (server/sql)...");
// Lê o diretório em vez de listar nomes: migrations novas entram no teste
// automaticamente, sem risco de esquecer alguma aqui.
const sqlDir = path.join(root, "server", "sql");
const migrations = (await readdir(sqlDir)).filter((f) => f.endsWith(".sql")).sort();
for (const file of migrations) {
    const sql = await readFile(path.join(sqlDir, file), "utf8");
    await db.exec(sql);
    console.log(`  aplicado: ${file}`);
}

process.env.DATABASE_URL = `postgresql://postgres:postgres@127.0.0.1:${DB_PORT}/postgres`;
process.env.DATABASE_SSL = "false";
process.env.JWT_SECRET = "segredo-de-teste-com-mais-de-32-caracteres-ok";
process.env.PORT = String(API_PORT);
process.env.NODE_ENV = "development";

console.log("Subindo a API...");
await import("../server/server.js");

for (let i = 0; i < 60; i++) {
    try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) break;
    } catch {
        /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 250));
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

console.log("\n[0] Autenticação");
const aliceReg = await call("POST", "/auth/register", { body: alice });
check("registra alice", aliceReg.status === 201, JSON.stringify(aliceReg.body));
const bobReg = await call("POST", "/auth/register", { body: bob });
check("registra bob", bobReg.status === 201, JSON.stringify(bobReg.body));

const aliceToken = aliceReg.body?.token;
const bobToken = bobReg.body?.token;
const bobId = bobReg.body?.user?.userId;

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
