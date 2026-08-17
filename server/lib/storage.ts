import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { AppError } from "../middleware/error.js";

export const MAX_COVER_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * Detecta o tipo real pelos magic bytes.
 *
 * O `mimetype` que o multer expõe vem do header enviado pelo cliente, então é
 * autodeclarado — um .exe renomeado para .png chega como image/png. Aqui a
 * decisão é tomada pelo conteúdo.
 */
export function sniffImageType(buffer: Buffer): "png" | "jpeg" | "webp" | null {
  if (buffer.length < 12) return null;

  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "png";
  }

  // JPEG: FF D8 FF
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "jpeg";
  }

  // WebP: "RIFF" .... "WEBP"
  if (
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "webp";
  }

  return null;
}

/** O Storage só é usado se as duas vars estiverem configuradas. */
export function isStorageEnabled(): boolean {
  return Boolean(config.SUPABASE_URL && config.SUPABASE_SERVICE_KEY);
}

const EXTENSION: Record<string, string> = {
  png: "png",
  jpeg: "jpg",
  webp: "webp",
};

/**
 * Sobe a capa para o bucket e devolve a URL pública.
 *
 * Usa a REST API do Storage direto por fetch — o @supabase/supabase-js
 * inteiro seria uma dependência grande para um único PUT de objeto.
 *
 * Retorna null quando o Storage não está configurado, para que a criação da
 * comunidade não fique bloqueada por uma feature opcional.
 */
export async function uploadCommunityCover(
  buffer: Buffer,
  communityId: string,
): Promise<string | null> {
  if (!isStorageEnabled()) return null;

  if (buffer.byteLength > MAX_COVER_BYTES) {
    throw new AppError(413, "A capa deve ter no máximo 2MB");
  }

  const kind = sniffImageType(buffer);
  if (!kind) {
    throw new AppError(400, "A capa deve ser uma imagem PNG, JPEG ou WebP");
  }

  const base = config.SUPABASE_URL.replace(/\/+$/, "");
  const bucket = config.SUPABASE_COVERS_BUCKET;
  const objectPath = `${communityId}/${randomUUID()}.${EXTENSION[kind]}`;

  const response = await fetch(
    `${base}/storage/v1/object/${bucket}/${objectPath}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.SUPABASE_SERVICE_KEY}`,
        "Content-Type": `image/${kind}`,
        "cache-control": "public, max-age=31536000, immutable",
      },
      body: new Uint8Array(buffer),
    },
  );

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    console.error("Falha no upload da capa:", response.status, detail);
    throw new AppError(502, "Não foi possível enviar a imagem de capa");
  }

  return `${base}/storage/v1/object/public/${bucket}/${objectPath}`;
}
