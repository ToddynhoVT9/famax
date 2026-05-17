import express from "express";
import cors from "cors";
import { config } from "./config.js";
import { pingDatabase } from "./db.js";
import { errorHandler } from "./middleware/error.js";

import authRoutes from "./routes/auth.routes.js";
import postsRoutes from "./routes/posts.routes.js";

const app = express();

app.use(cors({ origin: config.CORS_ORIGIN, credentials: true }));
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);
app.use("/api", postsRoutes);

app.use((_req, res) => {
  res.status(404).json({ error: "Rota não encontrada" });
});

app.use(errorHandler);

async function start() {
  await pingDatabase();
  app.listen(config.PORT, () => {
    console.log(`🚀 API rodando em http://localhost:${config.PORT}`);
  });
}

start().catch((err) => {
  console.error("Erro ao iniciar servidor:", err);
  process.exit(1);
});
