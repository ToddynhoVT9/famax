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
