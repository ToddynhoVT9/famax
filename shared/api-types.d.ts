/**
 * FAMAX — Tipos das respostas da API, compartilhados entre server e client.
 *
 * O contrato fica num lugar só: o server anota o que devolve com estes tipos
 * e o client lê com eles, então renomear um campo de um lado quebra o
 * typecheck do outro. As respostas são camelCase (server/lib/case.ts converte
 * as linhas do banco).
 *
 * É um .d.ts de propósito: só tipos, nada a emitir. Assim o build do server
 * (rootDir: server) continua gerando dist/server.js no mesmo lugar e o Vite
 * não precisa saber desta pasta. Importar sempre com `import type`.
 */

// ===========================================================================
// Comuns
// ===========================================================================

export type CommunityRole = "owner" | "moderator" | "member";

export type ReactionType = "like" | "love" | "haha" | "wow" | "sad";
export type ReactionCounts = Partial<Record<ReactionType, number>>;

/** Listagens paginadas por número de página. */
export interface Pagination {
    page: number;
    limit?: number;
    total?: number;
    totalPages: number;
}

export interface Page<T> {
    data: T[];
    pagination: Pagination;
}

/** Listagens por cursor (comentários, notificações, mensagens). */
export interface CursorPage<T> {
    data: T[];
    nextCursor: string | null;
}

// ===========================================================================
// Usuário logado — GET /api/me
// ===========================================================================

export interface SocialLink {
    platform: string;
    url: string;
}

export interface Me {
    userId: string;
    email: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    bannerUrl: string | null;
    bio: string | null;
    nickname: string | null;
    birthDate: string | null;
    gender: string | null;
    isPrivate: boolean;
    isAdult: boolean;
    twoFactorEnabled: boolean;
    /** Códigos de recuperação da 2FA ainda não usados. */
    recoveryCodesLeft: number;
    /** Admin do site: vê a fila de denúncias de usuários. */
    isAdmin: boolean;
    /** Preferências de notificação (configurações). */
    notifyLikes: boolean;
    notifyComments: boolean;
    notifyReplies: boolean;
    notifyFollows: boolean;
    notifyEvents: boolean;
    /** E-mail confirmado pelo link (prompt 12). */
    emailVerified: boolean;
    /** Troca de e-mail aguardando confirmação do endereço novo. */
    pendingEmail: string | null;
    createdAt: string;
    socialLinks: SocialLink[];
}

// ===========================================================================
// Comunidades
// ===========================================================================

/** Cartão da home (GET /api/communities). */
export interface CommunityCard {
    communityId: string;
    name: string;
    description: string | null;
    coverImageUrl: string | null;
    categoryId: string | null;
    categoryName: string | null;
    membersCount: number;
}

export interface Category {
    categoryId: string;
    name: string;
}

/** Página da comunidade (GET /api/communities/:id). */
export interface Community {
    communityId: string;
    name: string;
    description: string | null;
    rules: string | null;
    coverImageUrl: string | null;
    ownerId: string;
    categoryName: string | null;
    membersCount: number;
    myRole: CommunityRole | null;
    isBanned: boolean;
    myBanExpiresAt: string | null;
    /** Comunidade +18, e se quem vê não pode ver. */
    isNsfw: boolean;
    nsfwBlocked: boolean;
}

export interface CommunityEvent {
    eventId: string;
    communityId: string;
    title: string;
    description: string | null;
    startsAt: string;
    endsAt: string | null;
    location: string | null;
    creatorId: string | null;
    creatorUsername: string | null;
    creatorDisplayName: string | null;
    attendeesCount: number;
    attending: boolean;
    isPast: boolean;
}

// ===========================================================================
// Posts e comentários
// ===========================================================================

export interface PostImage {
    imageId: string;
    url: string;
}

export interface Post {
    postId: string;
    title: string;
    content: string;
    likesCount: number;
    commentsCount: number;
    createdAt: string;
    editedAt: string | null;
    /** Fixado no topo pelo dono/moderação (null = não fixado). */
    pinnedAt: string | null;
    /** Comentário marcado pelo autor como resposta aceita. */
    resolvedCommentId: string | null;
    communityCategoryId: string | null;
    communityId: string;
    communityName: string;
    authorId: string;
    authorUsername: string;
    authorDisplayName: string | null;
    authorAvatarUrl: string | null;
    categoryName: string | null;
    likedByMe: boolean;
    /** Reação de quem vê (null = nenhuma) e contagem por tipo. likesCount é o total. */
    myReaction: ReactionType | null;
    reactionCounts: ReactionCounts;
    /** Está nos salvos de quem vê. */
    savedByMe: boolean;
    /** Imagens anexadas (até 4), na ordem de exibição. */
    images: PostImage[];
    /** Quem vê bloqueou o autor: o post aparece recolhido ("mostrar"). */
    authorBlockedByMe?: boolean;
    /** +18 (o post ou a comunidade dele); postIsNsfw é só a marca do post. */
    isNsfw?: boolean;
    postIsNsfw?: boolean;
    /** +18 e quem vê não pode ver: veio só o título. */
    nsfwHidden?: boolean;
    /** Papel do autor na comunidade (selo) e de quem vê (pode moderar?). */
    authorRole: CommunityRole | null;
    viewerRole: CommunityRole | null;
}

/** Comentário apagado com respostas chega com isDeleted e sem autor/texto. */
export interface Comment {
    commentId: string;
    parentCommentId: string | null;
    content: string | null;
    createdAt: string;
    editedAt: string | null;
    isDeleted: boolean;
    repliesCount: number;
    authorId: string | null;
    authorUsername: string | null;
    authorDisplayName: string | null;
    authorRole?: CommunityRole | null;
    /** Quem vê bloqueou o autor: o comentário aparece recolhido. */
    authorBlockedByMe?: boolean;
}

// ===========================================================================
// Chat
// ===========================================================================

export interface Conversation {
    conversationId: string;
    isGroup: boolean;
    title: string | null;
    lastMessageAt: string;
    otherUserId: string | null;
    otherUsername: string | null;
    otherDisplayName: string | null;
    otherAvatarUrl: string | null;
    participantsCount: number;
    lastMessageContent: string | null;
    unreadCount: number;
}

export interface Participant {
    userId: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    role: "admin" | "member";
    lastReadAt: string;
}

export interface Message {
    messageId: string;
    conversationId: string;
    senderId: string;
    kind: "text" | "system";
    content: string | null;
    isDeleted: boolean;
    createdAt: string;
    senderUsername: string | null;
    senderDisplayName: string | null;
    senderAvatarUrl: string | null;
}

// ===========================================================================
// Notificações e denúncias
// ===========================================================================

export type NotificationType =
    | "post_comment"
    | "comment_reply"
    | "post_like"
    | "content_removed"
    | "community_role"
    | "mention"
    | "follow"
    | "event";

export interface AppNotification {
    notificationId: string;
    type: NotificationType;
    readAt: string | null;
    createdAt: string;
    postId: string | null;
    commentId: string | null;
    communityId: string | null;
    eventId?: string | null;
    eventTitle?: string | null;
    eventStartsAt?: string | null;
    data: { role?: string; kind?: string; title?: string; excerpt?: string } | null;
    actorId: string | null;
    actorUsername: string | null;
    actorDisplayName: string | null;
    actorAvatarUrl: string | null;
    postTitle: string | null;
    communityName: string | null;
    commentExcerpt: string | null;
    likesCount: number | null;
}

export interface NotificationPage extends CursorPage<AppNotification> {
    unread: number;
}

export interface Report {
    reportId: string;
    targetType: "post" | "comment" | "user";
    targetId: string;
    reason: string;
    status: "pending" | "reviewing" | "resolved" | "dismissed";
    resolution: "none" | "remove_content" | "ban_author" | "dismiss" | null;
    createdAt: string;
    resolvedAt: string | null;
    communityId: string | null;
    reporterUsername: string;
    resolvedByUsername: string | null;
    postId: string | null;
    postTitle: string | null;
    content: string | null;
    targetDeleted: boolean;
    authorId: string | null;
    authorUsername: string | null;
    authorDisplayName: string | null;
    authorRole: CommunityRole | null;
}

// ===========================================================================
// Comunidade: ranking, membros, banimentos, edição
// ===========================================================================

export interface LeaderboardEntry {
    userId: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    points: number;
    rank: number;
}

export interface CommunityMember {
    userId: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    role: CommunityRole;
    joinedAt: string;
}

export interface CommunityBan {
    userId: string;
    username: string;
    displayName: string | null;
    reason: string | null;
    expiresAt: string | null;
    createdAt: string;
    bannedByUsername: string | null;
}

/** Categoria de post dentro de uma comunidade. */
export interface PostCategory {
    communityCategoryId: string;
    name: string;
}

/** GET /api/communities/:id — a comunidade e as categorias de post dela. */
export interface CommunityDetail {
    community: Community & { categoryId: string; rules: string | null };
    categories: PostCategory[];
}

// ===========================================================================
// Usuários, perfil, seguir, sessões
// ===========================================================================

/** Usuário em listas curtas (busca de pessoas, bloqueados). */
export interface UserSummary {
    userId: string;
    username: string;
    displayName: string | null;
}

export interface PublicProfile {
    userId: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    isPrivate: boolean;
    isOwner: boolean;
    /** Quem vê segue este perfil (sempre false sem sessão). */
    followedByMe?: boolean;
    /** Quem vê bloqueou este perfil. */
    blockedByMe?: boolean;
    // Ausentes quando o perfil é privado e quem vê não é o dono.
    nickname?: string | null;
    bannerUrl?: string | null;
    bio?: string | null;
    createdAt?: string;
    stats?: { posts: number; comments: number; communities: number; followers: number; following: number };
    socialLinks?: SocialLink[];
}

/** Post nas abas do perfil (Posts e Salvos). */
export interface ProfilePost {
    postId: string;
    title: string;
    content: string;
    likesCount: number;
    commentsCount: number;
    createdAt: string;
    communityId: string;
    communityName: string;
    /** +18 e quem vê não pode ver: veio sem conteúdo. */
    nsfwHidden?: boolean;
}

/** Comentário na aba Respostas do perfil. */
export interface ProfileComment {
    commentId: string;
    content: string;
    createdAt: string;
    postId: string;
    postTitle: string;
    communityId: string;
    communityName: string;
}

export interface FollowState {
    following: boolean;
    followersCount: number;
}

export interface FollowListItem {
    userId: string;
    username: string;
    displayName: string | null;
    avatarUrl: string | null;
    followedByMe: boolean;
}

export interface SessionInfo {
    sessionId: string;
    device: string;
    ip: string | null;
    lastSeenAt: string;
    current: boolean;
}

// ===========================================================================
// Busca — GET /api/search
// ===========================================================================

export interface SearchCommunity {
    communityId: string;
    name: string;
    description: string | null;
    categoryName: string | null;
    membersCount: number;
}

export interface SearchPost {
    postId: string;
    title: string;
    snippet: string;
    createdAt: string;
    communityId: string;
    communityName: string;
    authorUsername: string;
    authorDisplayName: string | null;
    likesCount: number;
    commentsCount: number;
}

export interface SearchSection<T> {
    data: T[];
    total: number;
    page: number;
    totalPages: number;
}

export interface SearchResponse {
    results: {
        communities?: SearchSection<SearchCommunity>;
        users?: SearchSection<UserSummary>;
        posts?: SearchSection<SearchPost>;
    };
}

// ===========================================================================
// Login
// ===========================================================================

/** Login e reativação: o token, ou o pedido do segundo passo (2FA). */
export interface LoginResult {
    token?: string;
    mfaRequired?: boolean;
    mfaToken?: string;
}
