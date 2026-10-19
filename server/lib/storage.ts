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

export type ImageKind = "png" | "jpeg" | "webp";

/**
 * Confere tamanho e tipo real. Separado do upload para as rotas validarem
 * mesmo quando o Storage não está configurado — um arquivo que não é imagem
 * recebe 400 sempre, e não às vezes 400, às vezes "upload desativado".
 */
export function validateImage(
  buffer: Buffer,
  options: { maxBytes: number; label: string },
): ImageKind {
  if (buffer.byteLength > options.maxBytes) {
    const mb = Math.round(options.maxBytes / (1024 * 1024));
    throw new AppError(413, `${options.label} deve ter no máximo ${mb}MB`);
  }

  const kind = sniffImageType(buffer);
  if (!kind) {
    throw new AppError(400, `${options.label} deve ser uma imagem PNG, JPEG ou WebP`);
  }
  return kind;
}

function storageBase(): string {
  return config.SUPABASE_URL.replace(/\/+$/, "");
}

/**
 * Sobe uma imagem para `bucket/folder/<uuid>.<ext>` e devolve a URL pública.
 *
 * Usa a REST API do Storage direto por fetch — o @supabase/supabase-js
 * inteiro seria uma dependência grande para um único PUT de objeto.
 *
 * Retorna null quando o Storage não está configurado; cada rota decide se
 * isso é aceitável (capa de comunidade: sim, é opcional) ou erro (avatar).
 */
export async function uploadImage(
  buffer: Buffer,
  options: { bucket: string; folder: string; maxBytes: number; label: string },
): Promise<string | null> {
  const kind = validateImage(buffer, options);
  if (!isStorageEnabled()) return null;

  const base = storageBase();
  const objectPath = `${options.folder}/${randomUUID()}.${EXTENSION[kind]}`;

  const response = await fetch(
    `${base}/storage/v1/object/${options.bucket}/${objectPath}`,
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
    console.error(`Falha no upload (${options.bucket}):`, response.status, detail);
    throw new AppError(502, "Não foi possível enviar a imagem");
  }

  return `${base}/storage/v1/object/public/${options.bucket}/${objectPath}`;
}

/**
 * Apaga o objeto por trás de uma URL pública gerada por uploadImage.
 *
 * Melhor esforço: chamado depois que o banco já aponta para a imagem nova (ou
 * para nada). Um objeto órfão no Storage é inofensivo; falhar a troca de
 * avatar por causa da limpeza seria pior. URLs de outro lugar são ignoradas.
 */
export async function deleteImageByUrl(url: string | null, bucket: string): Promise<void> {
  if (!url || !isStorageEnabled()) return;

  const prefix = `${storageBase()}/storage/v1/object/public/${bucket}/`;
  if (!url.startsWith(prefix)) return;

  const objectPath = url.slice(prefix.length);
  try {
    const response = await fetch(`${storageBase()}/storage/v1/object/${bucket}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${config.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ prefixes: [objectPath] }),
    });
    if (!response.ok) {
      console.warn(`Imagem antiga não removida (${bucket}):`, response.status);
    }
  } catch (err) {
    console.warn(`Imagem antiga não removida (${bucket}):`, (err as Error).message);
  }
}

/** Capa de comunidade: opcional, então Storage desligado = sem capa. */
export function uploadCommunityCover(
  buffer: Buffer,
  communityId: string,
): Promise<string | null> {
  return uploadImage(buffer, {
    bucket: config.SUPABASE_COVERS_BUCKET,
    folder: communityId,
    maxBytes: MAX_COVER_BYTES,
    label: "A capa",
  });
}
