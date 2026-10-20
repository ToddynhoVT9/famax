import type { PoolClient } from "pg";
import { pool } from "../db.js";
import { config } from "../config.js";
import { deleteImageByUrl } from "./storage.js";
import { revokeAllSessions } from "./session.js";
import { escapeHtml, type Mail } from "./mailer.js";

/**
 * Exclusão de conta (LGPD), reativação e exportação de dados.
 *
 *   excluir     → users.deleted_at + perfil anonimizado + snapshot do perfil
 *                 em account_deletions (migration 025); sessões revogadas.
 *   reativar    → até purge_after (30 dias): devolve o perfil do snapshot.
 *   definitivo  → purgeExpiredAccounts(): depois do prazo, apaga o snapshot,
 *                 as imagens e os vínculos, e troca e-mail/username por
 *                 valores sem relação com a pessoa.
 */

export const REACTIVATION_DAYS = 30;
export const DELETED_NAME = "Usuário removido";

type Db = Pick<PoolClient, "query">;

interface ProfileSnapshot {
  display_name: string | null;
  nickname: string | null;
  bio: string | null;
  birth_date: string | null;
  gender: string | null;
  avatar_url: string | null;
  banner_url: string | null;
  social_links: Array<{ platform: string; url: string }>;
}

// ===========================================================================
// Excluir
// ===========================================================================

/** Comunidades vivas das quais a pessoa é dona — precisam ser transferidas antes. */
export async function ownedCommunities(userId: string): Promise<string[]> {
  const { rows } = await pool.query<{ name: string }>(
    "SELECT name FROM communities WHERE owner_id = $1 AND deleted_at IS NULL ORDER BY name",
    [userId],
  );
  return rows.map((r) => r.name);
}

/**
 * Exclui (soft) a conta: tudo numa transação. Devolve a data limite para
 * reativar.
 */
export async function deleteAccount(client: Db, userId: string): Promise<Date> {
  const { rows } = await client.query<ProfileSnapshot>(
    `SELECT p.display_name, p.nickname, p.bio, p.birth_date::text AS birth_date, p.gender::text AS gender,
            p.avatar_url, p.banner_url,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('platform', l.platform, 'url', l.url))
                      FROM user_social_links l WHERE l.user_id = p.user_id), '[]'::jsonb) AS social_links
     FROM user_profiles p WHERE p.user_id = $1`,
    [userId],
  );
  const snapshot = rows[0] ?? null;

  const { rows: deletion } = await client.query<{ purge_after: Date }>(
    `INSERT INTO account_deletions (user_id, purge_after, profile_snapshot)
     VALUES ($1, NOW() + make_interval(days => $2), $3::jsonb)
     ON CONFLICT (user_id) DO UPDATE
       SET requested_at = NOW(), purge_after = EXCLUDED.purge_after,
           profile_snapshot = EXCLUDED.profile_snapshot
     RETURNING purge_after`,
    [userId, REACTIVATION_DAYS, JSON.stringify(snapshot ?? {})],
  );

  await client.query(
    `UPDATE user_profiles
     SET display_name = $2, nickname = NULL, bio = NULL, birth_date = NULL,
         gender = NULL, avatar_url = NULL, banner_url = NULL
     WHERE user_id = $1`,
    [userId, DELETED_NAME],
  );
  await client.query("DELETE FROM user_social_links WHERE user_id = $1", [userId]);
  await client.query(
    "UPDATE users SET deleted_at = NOW(), pending_email = NULL WHERE user_id = $1",
    [userId],
  );
  await revokeAllSessions(userId, client);
  return deletion[0].purge_after;
}

// ===========================================================================
// Reativar
// ===========================================================================

/** Conta excluída ainda dentro do prazo? Devolve até quando, ou null. */
export async function reactivationDeadline(db: Db, userId: string): Promise<Date | null> {
  const { rows } = await db.query<{ purge_after: Date }>(
    "SELECT purge_after FROM account_deletions WHERE user_id = $1 AND purge_after > NOW()",
    [userId],
  );
  return rows[0]?.purge_after ?? null;
}

/** Desfaz a exclusão: perfil e redes de volta, deleted_at limpo. */
export async function reactivateAccount(client: Db, userId: string): Promise<boolean> {
  const { rows } = await client.query<{ profile_snapshot: Partial<ProfileSnapshot> }>(
    `DELETE FROM account_deletions
     WHERE user_id = $1 AND purge_after > NOW()
     RETURNING profile_snapshot`,
    [userId],
  );
  if (rows.length === 0) return false;
  const snapshot = rows[0].profile_snapshot;

  await client.query(
    `UPDATE user_profiles
     SET display_name = COALESCE($2, display_name), nickname = $3, bio = $4,
         birth_date = $5::date, gender = $6::gender_enum, avatar_url = $7, banner_url = $8
     WHERE user_id = $1`,
    [
      userId,
      snapshot.display_name ?? null,
      snapshot.nickname ?? null,
      snapshot.bio ?? null,
      snapshot.birth_date ?? null,
      snapshot.gender ?? null,
      snapshot.avatar_url ?? null,
      snapshot.banner_url ?? null,
    ],
  );
  for (const link of snapshot.social_links ?? []) {
    await client.query(
      `INSERT INTO user_social_links (social_link_id, user_id, platform, url)
       VALUES (gen_random_uuid(), $1, $2, $3)`,
      [userId, link.platform, link.url],
    );
  }
  await client.query("UPDATE users SET deleted_at = NULL WHERE user_id = $1", [userId]);
  return true;
}

// ===========================================================================
// Exclusão definitiva (job)
// ===========================================================================

/**
 * Anonimiza de vez as contas cujo prazo passou. Uma transação por conta, com
 * FOR UPDATE SKIP LOCKED: duas instâncias rodando o job ao mesmo tempo não
 * pegam a mesma conta. Devolve quantas foram apagadas.
 */
export async function purgeExpiredAccounts(): Promise<number> {
  let purged = 0;
  for (;;) {
    const client = await pool.connect();
    let images: string[] = [];
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ user_id: string; profile_snapshot: Partial<ProfileSnapshot> }>(
        `SELECT user_id, profile_snapshot FROM account_deletions
         WHERE purge_after <= NOW()
         ORDER BY purge_after
         LIMIT 1
         FOR UPDATE SKIP LOCKED`,
      );
      const target = rows[0];
      if (!target) {
        await client.query("ROLLBACK");
        break;
      }
      const userId = target.user_id;
      images = [target.profile_snapshot.avatar_url, target.profile_snapshot.banner_url].filter(
        (url): url is string => Boolean(url),
      );

      // E-mail e username sem relação com a pessoa (e livres para cadastro).
      const short = userId.replace(/-/g, "").slice(0, 12);
      await client.query(
        `UPDATE users
         SET email = $2, username = $3, password_hash = '!', pending_email = NULL,
             email_verified_at = NULL, two_factor_enabled = FALSE, two_factor_secret = NULL,
             two_factor_pending_secret = NULL, two_factor_last_step = NULL, is_admin = FALSE
         WHERE user_id = $1`,
        [userId, `removido+${userId}@removido.invalid`, `removido_${short}`],
      );
      for (const sql of PURGE_STATEMENTS) await client.query(sql, [userId]);
      await client.query("DELETE FROM account_deletions WHERE user_id = $1", [userId]);
      await client.query("COMMIT");
      purged++;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    // Depois do banco: imagem órfã no Storage é inofensiva (ver storage.ts).
    for (const url of images) await deleteImageByUrl(url, config.SUPABASE_USER_MEDIA_BUCKET);
  }
  return purged;
}

/** Vínculos pessoais apagados na exclusão definitiva ($1 = user_id). */
const PURGE_STATEMENTS = [
  "DELETE FROM user_sessions WHERE user_id = $1",
  "DELETE FROM user_settings WHERE user_id = $1",
  "DELETE FROM user_social_links WHERE user_id = $1",
  "DELETE FROM password_recovery WHERE user_id = $1",
  "DELETE FROM two_factor_recovery_codes WHERE user_id = $1",
  "DELETE FROM stream_tickets WHERE user_id = $1",
  "DELETE FROM follows WHERE follower_id = $1 OR following_id = $1",
  "DELETE FROM saved_posts WHERE user_id = $1",
  "DELETE FROM user_blocks WHERE blocker_id = $1 OR blocked_id = $1",
  "DELETE FROM event_attendees WHERE user_id = $1",
  "DELETE FROM notifications WHERE user_id = $1",
  "UPDATE notifications SET actor_id = NULL WHERE actor_id = $1",
  // O aceite dos termos fica (é a prova do consentimento), sem o IP.
  "UPDATE terms_acceptance SET ip_address = NULL WHERE user_id = $1",
];

let purgeTimer: NodeJS.Timeout | null = null;

/** Roda o job agora e a cada 6 h. Chamado no boot, depois do banco pronto. */
export function scheduleAccountPurge(): void {
  const run = () =>
    purgeExpiredAccounts()
      .then((n) => {
        if (n > 0) console.log(`Exclusão definitiva: ${n} conta(s) anonimizada(s).`);
      })
      .catch((err: Error) => console.error("Falha no job de exclusão de contas:", err.message));
  void run();
  purgeTimer ??= setInterval(run, 6 * 60 * 60_000);
  purgeTimer.unref();
}

// ===========================================================================
// Exportar meus dados
// ===========================================================================

/**
 * Tudo o que é da pessoa, num JSON só: conta, perfil, configurações, redes,
 * comunidades, posts, comentários, mensagens que ELA enviou, seguidores,
 * salvos, reações e aceite dos termos. Mensagens de outras pessoas ficam de
 * fora — são dados delas.
 */
export async function buildExport(userId: string): Promise<Record<string, unknown>> {
  const one = async (sql: string) => (await pool.query(sql, [userId])).rows[0] ?? null;
  const many = async (sql: string) => (await pool.query(sql, [userId])).rows;

  return {
    exportedAt: new Date().toISOString(),
    account: await one(
      `SELECT user_id, email, username, created_at, email_verified_at, is_adult, two_factor_enabled
       FROM users WHERE user_id = $1`,
    ),
    profile: await one(
      `SELECT display_name, nickname, bio, birth_date::text AS birth_date, gender, avatar_url, banner_url
       FROM user_profiles WHERE user_id = $1`,
    ),
    settings: await one(
      `SELECT is_private, notify_likes, notify_comments, notify_replies, notify_follows, notify_events
       FROM user_settings WHERE user_id = $1`,
    ),
    socialLinks: await many("SELECT platform, url FROM user_social_links WHERE user_id = $1"),
    communities: await many(
      `SELECT c.community_id, c.name, m.role, m.joined_at
       FROM community_members m INNER JOIN communities c ON c.community_id = m.community_id
       WHERE m.user_id = $1 ORDER BY m.joined_at`,
    ),
    posts: await many(
      `SELECT p.post_id, c.name AS community, p.title, p.content, p.created_at, p.edited_at, p.deleted_at
       FROM posts p INNER JOIN communities c ON c.community_id = p.community_id
       WHERE p.author_id = $1 ORDER BY p.created_at`,
    ),
    comments: await many(
      `SELECT comment_id, post_id, content, created_at, edited_at, deleted_at
       FROM comments WHERE author_id = $1 ORDER BY created_at`,
    ),
    reactions: await many(
      "SELECT post_id, type, created_at FROM post_reactions WHERE user_id = $1 ORDER BY created_at",
    ),
    messagesSent: await many(
      `SELECT conversation_id, content, created_at, deleted_at
       FROM messages WHERE sender_id = $1 AND kind = 'text' ORDER BY created_at`,
    ),
    following: await many(
      `SELECT u.username, f.created_at FROM follows f INNER JOIN users u ON u.user_id = f.following_id
       WHERE f.follower_id = $1 ORDER BY f.created_at`,
    ),
    followers: await many(
      `SELECT u.username, f.created_at FROM follows f INNER JOIN users u ON u.user_id = f.follower_id
       WHERE f.following_id = $1 ORDER BY f.created_at`,
    ),
    savedPosts: await many("SELECT post_id, created_at FROM saved_posts WHERE user_id = $1 ORDER BY created_at"),
    termsAcceptance: await many(
      "SELECT terms_version, accepted_at, ip_address FROM terms_acceptance WHERE user_id = $1 ORDER BY accepted_at",
    ),
  };
}

// ===========================================================================
// E-mails
// ===========================================================================

const dateBr = (date: Date) => date.toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" });

export function accountDeletedMail(to: string, name: string, until: Date): Mail {
  return {
    to,
    subject: "Sua conta do FAMAX foi excluída",
    text: [
      `Olá, ${name}.`,
      "",
      "Sua conta no FAMAX foi excluída e todas as sessões foram encerradas.",
      `Mudou de ideia? Até ${dateBr(until)} dá para reativá-la: é só entrar com seu e-mail e senha.`,
      "Depois disso a exclusão é definitiva.",
    ].join("\n"),
    html: `<p>Olá, ${escapeHtml(name)}.</p>
       <p>Sua conta no FAMAX foi excluída e todas as sessões foram encerradas.</p>
       <p>Mudou de ideia? Até <strong>${dateBr(until)}</strong> dá para reativá-la: é só entrar com seu e-mail e senha.
          Depois disso a exclusão é definitiva.</p>`,
  };
}

export { dateBr };
