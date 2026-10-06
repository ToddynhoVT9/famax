import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { pingDatabase } from "./db.js";
import { errorHandler } from "./middleware/error.js";

import authRoutes from "./routes/auth.routes.js";
import postsRoutes from "./routes/posts.routes.js";
import communitiesRoutes from "./routes/communities.routes.js";
import commentsRoutes from "./routes/comments.routes.js";
import reactionsRoutes from "./routes/reactions.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import usersRoutes from "./routes/users.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

/**
 * Estado do banco.
 *
 * A porta é aberta antes do banco estar pronto (ver start()), então existe uma
 * janela de alguns segundos em que a app responde mas não consegue consultar
 * nada. Isto é o que separa "ainda subindo" de "subiu e falhou".
 */
const dbState: { ready: boolean; error: Error | null } = {
  ready: false,
  error: null,
};

/**
 * Marcado quando o processo está desligando.
 *
 * Num restart sobreposto a instância antiga pode receber o sinal de parada no
 * meio do próprio boot: o socket do banco fecha e o ping em voo falha com
 * ECONNREFUSED. Isso é o desligamento funcionando, não um erro de início —
 * registrar como erro manda uma pista falsa para o log.
 */
let shuttingDown = false;

// API ROUTES (primeiro, antes do static)
//
// Responde 200 mesmo enquanto o banco sobe: o supervisor da hospedagem usa a
// porta aberta como sinal de vida, e um 503 aqui poderia virar restart em
// loop. O estado real vai no corpo.
app.get("/api/health", (_req, res) => {
  res.json({
    status: "ok",
    db: dbState.ready ? "ready" : dbState.error ? "error" : "starting",
    ...(dbState.error && config.NODE_ENV === "development"
      ? { dbError: dbState.error.message }
      : {}),
    timestamp: new Date().toISOString(),
  });
});

// Barreira: toda rota de API depende do banco. Sem isto, uma requisição que
// chegasse na janela de boot receberia um ECONNREFUSED cru vindo do pool.
// Vem depois do /api/health de propósito, para o health nunca ser barrado.
app.use("/api", (_req, res, next) => {
  if (dbState.ready) return next();
  res.status(503).json({
    error: dbState.error
      ? "Banco de dados indisponível"
      : "Servidor iniciando, tente novamente em alguns segundos",
  });
});

app.use("/api/auth", authRoutes);
app.use("/api", communitiesRoutes);
app.use("/api", postsRoutes);
app.use("/api", commentsRoutes);
app.use("/api", reactionsRoutes);
app.use("/api", usersRoutes);
app.use("/api/conversations", chatRoutes);

// FRONTEND ESTÁTICO
app.use(express.static(publicDir));

app.use((req, res) => {
  if (req.path.startsWith("/api/")) {
    return res.status(404).json({ error: "Rota não encontrada" });
  }
  res.status(404).sendFile(path.join(publicDir, "index.html"));
});

app.use(errorHandler);

/**
 * Sobe o banco. Roda DEPOIS do listen(), então não pode derrubar o processo:
 * uma falha aqui fica registrada no dbState e a app responde 503 nas rotas de
 * API, com o motivo no log e no /api/health. Melhor que morrer em silêncio.
 */
async function initDatabase() {
  if (config.DB_MODE === "embedded") {
    const { startEmbeddedDatabase, stopEmbeddedDatabase } = await import(
      "./embedded-db.js"
    );
    await startEmbeddedDatabase();

    // O painel de hospedagem manda SIGTERM a cada deploy/restart. Sem fechar o
    // PGlite, as escritas mais recentes podem não chegar ao disco e o
    // diretório de dados fica com lock para o próximo boot.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`\n${signal} recebido — fechando o banco embarcado...`);
        stopEmbeddedDatabase()
          .then(() => process.exit(0))
          .catch((err) => {
            console.error("Falha ao fechar o banco:", err);
            process.exit(1);
          });
      });
    }
  }

  await pingDatabase();
  dbState.ready = true;
}

function start() {
  // O listen() vem PRIMEIRO, antes de qualquer trabalho de banco.
  //
  // A hospedagem gerenciada mata o processo se não houver listen() em 3
  // segundos ("App did not call listen() within 3 seconds"), e o primeiro
  // boot do PGlite passa disso — WASM + baseline + migrations levaram 5,3s.
  // Com o banco antes do listen o resultado era crash loop: processos
  // concorrentes disputando a porta do PGlite e um ECONNREFUSED atrás do
  // outro.
  app.listen(config.PORT, () => {
    console.log(
      `🚀 FAMAX (API + Frontend) rodando em http://localhost:${config.PORT}`,
    );
    console.log("   Banco subindo — rotas de API respondem 503 até ficar pronto.");
  });

  initDatabase()
    .then(() => console.log("✅ Banco pronto — API liberada."))
    .catch((err: Error) => {
      if (shuttingDown) {
        console.log("Boot do banco interrompido pelo desligamento.");
        return;
      }
      dbState.error = err;
      console.error("Erro ao iniciar o banco:", err);
    });
}

try {
  start();
} catch (err) {
  // Só chega aqui se o próprio listen() falhar (porta ocupada, por exemplo).
  // Falha de banco não passa por aqui — vira dbState.error.
  console.error("Erro ao iniciar servidor:", err);
  process.exit(1);
}
