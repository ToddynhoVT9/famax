import { z } from "zod";
import { pool } from "../db.js";

/**
 * Regras de perfil compartilhadas entre auth.routes (o cadastro), me.routes
 * (o dono editando) e users.routes (os outros vendo).
 */

/** Idade mínima para ter conta (o cadastro exige o nascimento). */
export const MIN_AGE = 13;
/** Idade para liberar conteúdo adulto (users.is_adult). */
export const ADULT_AGE = 18;

/**
 * Idade completa em anos numa data YYYY-MM-DD, no calendário (não por
 * milissegundos / 365.25, que erra por um dia perto do aniversário).
 */
export function ageFrom(birthDate: string, today = new Date()): number {
  const [year, month, day] = birthDate.split("-").map(Number);
  let age = today.getFullYear() - year;
  const beforeBirthday =
    today.getMonth() + 1 < month ||
    (today.getMonth() + 1 === month && today.getDate() < day);
  if (beforeBirthday) age--;
  return age;
}

/**
 * Data de nascimento YYYY-MM-DD, no passado, com pelo menos MIN_AGE anos. Um
 * schema só para o cadastro e a edição; muda apenas a frase de quem tem menos
 * de 13, que no cadastro fala em criar a conta.
 */
export function birthDateSchema(underAgeMessage = `É preciso ter pelo menos ${MIN_AGE} anos`) {
  return (
    z
      .string({
        required_error: "Informe a data de nascimento",
        invalid_type_error: "Data de nascimento inválida",
      })
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Data de nascimento inválida")
      // "2023-02-31" passa na regex; a volta pelo Date pega o dia que não existe.
      .refine((value) => {
        const date = new Date(`${value}T00:00:00Z`);
        return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
      }, "Data de nascimento inválida")
      .refine((value) => ageFrom(value) >= 0 && new Date(value) < new Date(), "A data de nascimento precisa estar no passado")
      .refine((value) => ageFrom(value) >= MIN_AGE, underAgeMessage)
      .refine((value) => ageFrom(value) <= 120, "Data de nascimento inválida")
  );
}

/** Quem vê o aniversário no perfil (migration 029). */
export const BIRTHDAY_VISIBILITIES = ["self", "following", "everyone"] as const;
export type BirthdayVisibility = (typeof BIRTHDAY_VISIBILITIES)[number];

/**
 * O aniversário que o perfil mostra a quem vê: só "MM-DD", nunca o ano (a
 * idade fica com a pessoa). null quando ela não informou a data ou quando
 * quem vê não está na escolha dela. ownerFollowsViewer: o dono do perfil
 * segue quem está vendo — é o "Quem eu sigo".
 */
export function visibleBirthday(
  birthDate: string | null,
  visibility: BirthdayVisibility,
  { isOwner, ownerFollowsViewer }: { isOwner: boolean; ownerFollowsViewer: boolean },
): string | null {
  if (!birthDate) return null;
  const allowed =
    isOwner || visibility === "everyone" || (visibility === "following" && ownerFollowsViewer);
  return allowed ? birthDate.slice(5, 10) : null;
}

/**
 * Plataformas aceitas em user_social_links. Lista fechada: o front desenha um
 * rótulo por plataforma e não há como exibir com segurança um nome qualquer.
 */
export const SOCIAL_PLATFORMS = [
  "site",
  "instagram",
  "x",
  "youtube",
  "twitch",
  "tiktok",
  "github",
  "linkedin",
  "discord",
] as const;

export const MAX_SOCIAL_LINKS = 8;

export type SocialLink = { platform: string; url: string };

export async function loadSocialLinks(userId: string): Promise<SocialLink[]> {
  // Sem coluna de ordem na tabela: ordena pela lista de plataformas para a
  // exibição não variar entre requisições.
  const { rows } = await pool.query<SocialLink>(
    `SELECT platform, url
     FROM user_social_links
     WHERE user_id = $1
     ORDER BY array_position($2::text[], platform::text), url`,
    [userId, SOCIAL_PLATFORMS],
  );
  return rows;
}

/**
 * Quem pode ver o conteúdo do perfil (bio, posts, respostas...).
 *
 * Perfil público: todo mundo, inclusive visitante. Privado: só o dono. A
 * busca do chat tem uma regra mais aberta (quem já conversa encontra o
 * perfil), mas encontrar a pessoa não é o mesmo que ler o histórico dela.
 *
 * Devolve null se o usuário não existe (ou foi excluído).
 */
export async function profileAccess(
  targetId: string,
  viewerId: string | undefined,
): Promise<{ isPrivate: boolean; isOwner: boolean; canView: boolean } | null> {
  const { rows } = await pool.query<{ is_private: boolean | null }>(
    `SELECT us.is_private
     FROM users u
     LEFT JOIN user_settings us ON us.user_id = u.user_id
     WHERE u.user_id = $1 AND u.deleted_at IS NULL`,
    [targetId],
  );
  if (rows.length === 0) return null;

  // Sem linha de settings conta como privado (mesma regra da busca).
  const isPrivate = rows[0].is_private ?? true;
  const isOwner = viewerId === targetId;
  return { isPrivate, isOwner, canView: !isPrivate || isOwner };
}
