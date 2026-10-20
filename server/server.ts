import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { pingDatabase, startDatabaseMonitor } from "./db.js";
import { errorHandler } from "./middleware/error.js";

import authRoutes from "./routes/auth.routes.js";
import postsRoutes from "./routes/posts.routes.js";
import communitiesRoutes from "./routes/communities.routes.js";
import commentsRoutes from "./routes/comments.routes.js";
import reactionsRoutes from "./routes/reactions.routes.js";
import chatRoutes from "./routes/chat.routes.js";
import usersRoutes from "./routes/users.routes.js";
import meRoutes from "./routes/me.routes.js";
import searchRoutes from "./routes/search.routes.js";
import moderationRoutes from "./routes/moderation.routes.js";
import reportsRoutes from "./routes/reports.routes.js";
import notificationsRoutes from "./routes/notifications.routes.js";
import leaderboardRoutes from "./routes/leaderboard.routes.js";
import followsRoutes from "./routes/follows.routes.js";
import eventsRoutes from "./routes/events.routes.js";
import streamRoutes from "./routes/stream.routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const app = express();

// Faz o req.ip refletir o cliente real atrás do proxy da hospedagem — o rate
// limit do login/cadastro depende disso. Ver TRUST_PROXY em config.ts.
app.set("trust proxy", config.TRUST_PROXY);

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
app.use("/api", meRoutes);
app.use("/api", searchRoutes);
app.use("/api", moderationRoutes);
app.use("/api", reportsRoutes);
app.use("/api", notificationsRoutes);
app.use("/api", leaderboardRoutes);
app.use("/api", followsRoutes);
app.use("/api", eventsRoutes);
app.use("/api", streamRoutes);
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
    const {
      startEmbeddedDatabase,
      stopEmbeddedDatabase,
      superviseEmbeddedDatabase,
    } = await import("./embedded-db.js");
    await startEmbeddedDatabase();

    // Enquanto este processo for cliente, vigia o dono: se ele sair (é o que
    // acontece com a instância velha a cada deploy), assume o banco em vez de
    // ficar órfão.
    //
    // O pingDatabase como verificador é o ponto central: a API só é liberada
    // depois de uma query real passar. Antes isto liberava só por ter
    // conseguido rodar a aquisição, mesmo voltando como cliente sem acesso —
    // e aí as rotas respondiam 500 em vez de 503.
    superviseEmbeddedDatabase(
      pingDatabase,
      () => {
        dbState.ready = true;
        dbState.error = null;
        console.log("✅ Banco acessível — API liberada.");
      },
      (err) => {
        dbState.ready = false;
        dbState.error = err;
        console.error("Banco indisponível:", err.message);
      },
    );

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

  try {
    await pingDatabase();
  } catch (err) {
    // Num banco externo o erro cru ("ECONNREFUSED", "ETIMEDOUT") não diz se o
    // problema é DNS, filtro de porta da hospedagem, TLS ou credencial. O
    // diagnóstico separa esses casos — só no caminho de falha, para não
    // custar nada quando está tudo bem.
    if (config.DB_MODE === "external") {
      const { diagnoseDatabaseReachability } = await import(
        "./net-diagnostics.js"
      );
      await diagnoseDatabaseReachability(config.DATABASE_URL);
    }
    throw err;
  }

  // Antes de liberar a API: o código deste deploy pode depender de colunas
  // que só a migration nova cria. Falhar aqui deixa a API em 503 com o motivo
  // no log, em vez de 500 em cada rota afetada. (O modo embedded já migra
  // dentro do startEmbeddedDatabase.)
  if (config.DB_MODE === "external" && config.MIGRATE_ON_BOOT) {
    const { applyPendingMigrations } = await import("./migrate.js");
    await applyPendingMigrations();
  }

  dbState.ready = true;

  // Tempo real (SSE): sobe depois do banco. Não derruba a API se falhar —
  // cai para o barramento em memória (ver lib/realtime.ts).
  const { startRealtimeBus } = await import("./lib/realtime.js");
  await startRealtimeBus();

  // Mantém o dbState honesto depois do boot: sem isto, um banco externo que
  // caísse deixava a aplicação liberando rotas que respondiam 500 em vez do
  // 503 explicado.
  startDatabaseMonitor(
    () => {
      dbState.ready = true;
      dbState.error = null;
    },
    (err) => {
      dbState.ready = false;
      dbState.error = err;
    },
  );
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
