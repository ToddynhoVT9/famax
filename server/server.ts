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

// API ROUTES (primeiro, antes do static)
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
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

async function start() {
  // Precisa vir antes do ping: no modo embarcado é isto que cria o banco para
  // o pool conectar. O pool do pg é preguiçoso, então importá-lo antes é ok.
  if (config.DB_MODE === "embedded") {
    const { startEmbeddedDatabase, stopEmbeddedDatabase } = await import(
      "./embedded-db.js"
    );
    await startEmbeddedDatabase();

    // O painel de hospedagem manda SIGTERM a cada deploy/restart. Sem fechar o
    // PGlite, as escritas mais recentes podem não chegar ao disco e o
    // diretório de dados fica com lock para o próximo boot.
    let closing = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.on(signal, () => {
        if (closing) return;
        closing = true;
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
