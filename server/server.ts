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
const publicDir = path.join(__dirname, "public");

const app = express();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "1mb" }));

// API ROUTES (primeiro, antes do static)
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use("/api/auth", authRoutes);
app.use("/api", postsRoutes);

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
