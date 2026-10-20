/**
 * FAMAX — Cliente da API tipado (Shared)
 *
 * Cada rota do servidor vira um método com parâmetros e resposta tipados:
 * `api.posts.get(id)` em vez de `api<{ post: Post }>(\`/posts/${...}\`)`. Os
 * caminhos, o encodeURIComponent dos ids e a montagem da query ficam aqui,
 * num lugar só; os tipos das respostas vêm de shared/api-types.d.ts, os
 * mesmos que o servidor usa.
 *
 * O `api(path)` cru continua existindo (api.ts) para algum caso fora daqui,
 * mas toda chamada da aplicação passa por estes métodos.
 */
import type {
    AppNotification,
    Category,
    Comment,
    CommunityBan,
    CommunityCard,
    CommunityDetail,
    CommunityEvent,
    CommunityMember,
    CommunityRole,
    Conversation,
    CursorPage,
    FollowListItem,
    FollowState,
    LeaderboardEntry,
    LoginResult,
    Me,
    Message,
    NotificationPage,
    Page,
    Participant,
    Post,
    ProfileComment,
    ProfilePost,
    PublicProfile,
    ReactionCounts,
    ReactionType,
    Report,
    SearchResponse,
    SessionInfo,
    SocialLink,
    UserSummary,
} from "../../../shared/api-types.js";

export type Request = <T = unknown>(path: string, options?: RequestInit) => Promise<T>;

/** Valores de query: vazio, null e undefined ficam de fora. */
export type Query = Record<string, string | number | boolean | null | undefined>;

const id = encodeURIComponent;

function withQuery(path: string, query: Query = {}): string {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null || value === "") continue;
        params.set(key, String(value));
    }
    const qs = params.toString();
    return qs ? `${path}?${qs}` : path;
}

const json = (body: unknown): RequestInit => ({ body: JSON.stringify(body) });
const post = (body?: unknown): RequestInit => ({ method: "POST", ...(body === undefined ? {} : json(body)) });
const patch = (body: unknown): RequestInit => ({ method: "PATCH", ...json(body) });
const put = (body: unknown): RequestInit => ({ method: "PUT", ...json(body) });
const del = (body?: unknown): RequestInit => ({ method: "DELETE", ...(body === undefined ? {} : json(body)) });

type UserBody = { user: Me };
type PostBody = { post: Post };

export function buildEndpoints(request: Request) {
    return {
        auth: {
            login: (identifier: string, password: string) =>
                request<LoginResult>("/auth/login", post({ identifier, password })),
            reactivate: (identifier: string, password: string) =>
                request<LoginResult>("/auth/reactivate", post({ identifier, password })),
            loginTwoFactor: (mfaToken: string, code: string) =>
                request<{ token: string; recoveryCodesLeft?: number }>("/auth/login/2fa", post({ mfaToken, code })),
            register: (body: {
                email: string;
                username: string;
                password: string;
                displayName: string;
                termsAccepted: true;
                isPrivate: boolean;
            }) => request<{ token: string; user: unknown }>("/auth/register", post(body)),
            forgotPassword: (email: string) => request("/auth/forgot-password", post({ email })),
            verifyResetCode: (email: string, code: string) =>
                request<{ resetToken: string }>("/auth/verify-reset-code", post({ email, code })),
            resetPassword: (resetToken: string, newPassword: string) =>
                request("/auth/reset-password", post({ resetToken, newPassword })),
            verifyEmail: (token: string) => request<{ email: string }>("/auth/verify-email", post({ token })),
            resendVerification: () => request<{ message: string }>("/auth/resend-verification", post()),
        },

        me: {
            get: () => request<UserBody>("/me"),
            communities: () => request<{ data: Array<{ communityId: string; name: string }> }>("/me/communities"),
            saved: (query: { page: number; limit: number }) => request<Page<ProfilePost>>(withQuery("/me/saved", query)),
            updateProfile: (body: {
                displayName?: string;
                nickname?: string;
                birthDate?: string | null;
                gender?: string | null;
                bio?: string;
            }) => request<UserBody>("/me/profile", patch(body)),
            updateSettings: (body: Partial<Record<string, boolean>>) => request<UserBody>("/me/settings", patch(body)),
            uploadImage: (field: "avatar" | "banner", form: FormData) =>
                request<UserBody>(`/me/${field}`, { method: "POST", body: form }),
            removeImage: (field: "avatar" | "banner") => request<UserBody>(`/me/${field}`, del()),
            changePassword: (currentPassword: string, newPassword: string) =>
                request("/me/password", post({ currentPassword, newPassword })),
            setSocialLinks: (links: SocialLink[]) => request<UserBody>("/me/social-links", put({ links })),
            changeEmail: (newEmail: string, password: string) =>
                request<UserBody>("/me/email", patch({ newEmail, password })),
            cancelPendingEmail: () => request<UserBody>("/me/email/pending", del()),
            deleteAccount: (password: string, code?: string) => request("/me", del({ password, code })),
            sessions: () => request<{ data: SessionInfo[] }>("/me/sessions"),
            revokeSession: (sessionId: string) => request(`/me/sessions/${id(sessionId)}`, del()),
            revokeOtherSessions: () => request("/me/sessions/revoke-others", post()),
            blocks: () => request<{ data: UserSummary[] }>("/me/blocks"),
        },

        twoFactor: {
            setup: () => request<{ secret: string; qrCode: string }>("/me/2fa/setup", post()),
            enable: (code: string) => request<{ recoveryCodes: string[] }>("/me/2fa/enable", post({ code })),
            disable: (password: string, code: string) =>
                request<{ recoveryCodes?: string[] }>("/me/2fa/disable", post({ password, code })),
            regenerateCodes: (password: string, code: string) =>
                request<{ recoveryCodes?: string[] }>("/me/2fa/recovery-codes", post({ password, code })),
        },

        categories: {
            list: () => request<{ data: Category[] }>("/categories"),
        },

        communities: {
            list: (query: { search?: string; categoryId?: string | null; page?: number; limit?: number } = {}) =>
                request<{ data: CommunityCard[] }>(withQuery("/communities", query)),
            get: (communityId: string) => request<CommunityDetail>(`/communities/${id(communityId)}`),
            /** Multipart: a capa vai junto dos campos. */
            create: (form: FormData) =>
                request<{ community: { communityId: string } }>("/communities", { method: "POST", body: form }),
            update: (communityId: string, form: FormData) =>
                request(`/communities/${id(communityId)}`, { method: "PATCH", body: form }),
            remove: (communityId: string, confirmName: string) =>
                request(`/communities/${id(communityId)}`, del({ confirmName })),
            join: (communityId: string) => request(`/communities/${id(communityId)}/join`, post()),
            leave: (communityId: string) => request(`/communities/${id(communityId)}/leave`, post()),
            posts: (
                communityId: string,
                query: { page: number; limit: number; sort: string; unanswered?: boolean; categoryId?: string | null },
            ) => request<Page<Post>>(withQuery(`/communities/${id(communityId)}/posts`, query)),
            events: (communityId: string, query: { scope: "upcoming" | "past"; page?: number; limit: number }) =>
                request<Page<CommunityEvent>>(withQuery(`/communities/${id(communityId)}/events`, query)),
            createEvent: (communityId: string, body: Record<string, unknown>) =>
                request<{ event: CommunityEvent }>(`/communities/${id(communityId)}/events`, post(body)),
            leaderboard: (communityId: string, query: { period: "week" | "all"; limit: number }) =>
                request<{ data: LeaderboardEntry[] }>(withQuery(`/communities/${id(communityId)}/leaderboard`, query)),
            members: (communityId: string, query: { page: number; limit: number; role?: string | null }) =>
                request<Page<CommunityMember>>(withQuery(`/communities/${id(communityId)}/members`, query)),
            setMemberRole: (communityId: string, userId: string, role: CommunityRole) =>
                request(`/communities/${id(communityId)}/members/${id(userId)}`, patch({ role })),
            transferOwnership: (communityId: string, userId: string, confirmName: string) =>
                request(`/communities/${id(communityId)}/transfer`, post({ userId, confirmName })),
            bans: (communityId: string) => request<{ data: CommunityBan[] }>(`/communities/${id(communityId)}/bans`),
            ban: (communityId: string, userId: string, body: { durationDays: number | null; reason: string | null }) =>
                request(`/communities/${id(communityId)}/bans/${id(userId)}`, post(body)),
            unban: (communityId: string, userId: string) =>
                request(`/communities/${id(communityId)}/bans/${id(userId)}`, del()),
        },

        events: {
            update: (eventId: string, body: Record<string, unknown>) =>
                request<{ event: CommunityEvent }>(`/events/${id(eventId)}`, patch(body)),
            remove: (eventId: string) => request(`/events/${id(eventId)}`, del()),
            setAttending: (eventId: string, attending: boolean) =>
                request<{ attending: boolean; attendeesCount: number }>(
                    `/events/${id(eventId)}/attend`,
                    attending ? post() : del(),
                ),
        },

        feed: {
            following: (query: { page: number; limit: number }) =>
                request<Page<Post>>(withQuery("/feed/following", query)),
        },

        posts: {
            get: (postId: string) => request<PostBody>(`/posts/${id(postId)}`),
            create: (body: {
                communityId: string;
                communityCategoryId: string | null;
                title: string;
                content: string;
                isNsfw: boolean;
            }) => request<PostBody>("/posts", post(body)),
            update: (
                postId: string,
                body: { title: string; content: string; communityCategoryId: string | null; isNsfw?: boolean },
            ) => request<PostBody>(`/posts/${id(postId)}`, patch(body)),
            remove: (postId: string) => request(`/posts/${id(postId)}`, del()),
            /** Sem tipo: curte ou desfaz (mesma regra do servidor). */
            react: (postId: string, type: ReactionType | null) =>
                request<{ reaction: string | null; likesCount: number; reactionCounts: ReactionCounts }>(
                    `/posts/${id(postId)}/reactions`,
                    post(type ? { type } : {}),
                ),
            comments: (postId: string, query: { limit: number; cursor?: string | null }) =>
                request<CursorPage<Comment>>(withQuery(`/posts/${id(postId)}/comments`, query)),
            comment: (postId: string, content: string, parentCommentId: string | null) =>
                request<{ comment: Comment }>(`/posts/${id(postId)}/comments`, post({ content, parentCommentId })),
            setSaved: (postId: string, saved: boolean) => request(`/posts/${id(postId)}/save`, saved ? post() : del()),
            setPinned: (postId: string, pinned: boolean) =>
                request<PostBody>(`/posts/${id(postId)}/pin`, pinned ? post() : del()),
            /** null desmarca a resposta aceita. */
            setResolution: (postId: string, commentId: string | null) =>
                request<PostBody>(`/posts/${id(postId)}/resolution`, commentId ? put({ commentId }) : del()),
            addImages: (postId: string, form: FormData) =>
                request<PostBody>(`/posts/${id(postId)}/images`, { method: "POST", body: form }),
            removeImage: (postId: string, imageId: string) =>
                request<PostBody>(`/posts/${id(postId)}/images/${id(imageId)}`, del()),
        },

        comments: {
            update: (commentId: string, content: string) =>
                request<{ comment: Comment }>(`/comments/${id(commentId)}`, patch({ content })),
            remove: (commentId: string) => request(`/comments/${id(commentId)}`, del()),
        },

        users: {
            get: (userId: string) => request<{ user: PublicProfile }>(`/users/${id(userId)}`),
            byUsername: (username: string) =>
                request<{ user: { userId: string } }>(`/users/by-username/${id(username)}`),
            search: (search: string) => request<{ data: UserSummary[] }>(withQuery("/users", { search })),
            posts: (userId: string, query: { page: number; limit: number }) =>
                request<Page<ProfilePost>>(withQuery(`/users/${id(userId)}/posts`, query)),
            comments: (userId: string, query: { page: number; limit: number }) =>
                request<Page<ProfileComment>>(withQuery(`/users/${id(userId)}/comments`, query)),
            setFollowing: (userId: string, follow: boolean) =>
                request<FollowState>(`/users/${id(userId)}/follow`, follow ? post() : del()),
            followList: (userId: string, kind: "followers" | "following", query: { limit: number; cursor?: string | null }) =>
                request<CursorPage<FollowListItem>>(withQuery(`/users/${id(userId)}/${kind}`, query)),
            setBlocked: (userId: string, blocked: boolean) =>
                request(`/users/${id(userId)}/block`, blocked ? post() : del()),
        },

        search: (query: { q: string; type: string; page?: number; limit: number }) =>
            request<SearchResponse>(withQuery("/search", query)),

        notifications: {
            list: (query: { limit: number; cursor?: string | null }) =>
                request<NotificationPage>(withQuery("/notifications", query)),
            /** Sem ids: todas. keepalive: o clique num aviso navega logo em seguida. */
            markRead: (ids?: string[]) =>
                request<{ unread: number }>("/notifications/read", { ...post(ids ? { ids } : {}), keepalive: true }),
            unreadCount: () => request<{ unread: number }>("/notifications/unread-count"),
        },

        reports: {
            create: (body: { targetType: string; targetId: string; reason: string }) => request("/reports", post(body)),
            update: (reportId: string, body: Record<string, unknown>) => request(`/reports/${id(reportId)}`, patch(body)),
            /** Fila de uma comunidade (moderação) ou a do site (admin). */
            queue: (source: { communityId: string } | "admin", query: { status: string; page: number; limit: number }) =>
                request<Page<Report>>(
                    withQuery(source === "admin" ? "/admin/reports" : `/communities/${id(source.communityId)}/reports`, query),
                ),
        },

        conversations: {
            list: (query: { limit: number; cursor?: string | null }) =>
                request<CursorPage<Conversation> & { unreadTotal: number }>(withQuery("/conversations", query)),
            get: (conversationId: string) =>
                request<{
                    conversation: { conversationId: string; isGroup: boolean; title: string | null; myRole: "admin" | "member" };
                    participants: Participant[];
                }>(`/conversations/${id(conversationId)}`),
            /** Abre (ou reusa) a conversa 1:1. */
            open: (userId: string) => request<{ conversationId: string }>("/conversations", post({ userId })),
            createGroup: (title: string, userIds: string[]) =>
                request<{ conversationId: string }>("/conversations/groups", post({ title, userIds })),
            rename: (conversationId: string, title: string) =>
                request(`/conversations/${id(conversationId)}`, patch({ title })),
            messages: (conversationId: string, query: { limit?: number; beforeId?: string; after?: string }) =>
                request<{ data: Message[]; hasMore: boolean }>(withQuery(`/conversations/${id(conversationId)}/messages`, query)),
            send: (conversationId: string, content: string) =>
                request<{ message: Message }>(`/conversations/${id(conversationId)}/messages`, post({ content })),
            deleteMessage: (conversationId: string, messageId: string) =>
                request(`/conversations/${id(conversationId)}/messages/${id(messageId)}`, del()),
            markRead: (conversationId: string) => request(`/conversations/${id(conversationId)}/read`, post()),
            typing: (conversationId: string) => request(`/conversations/${id(conversationId)}/typing`, post()),
            addParticipants: (conversationId: string, userIds: string[]) =>
                request(`/conversations/${id(conversationId)}/participants`, post({ userIds })),
            removeParticipant: (conversationId: string, userId: string) =>
                request(`/conversations/${id(conversationId)}/participants/${id(userId)}`, del()),
        },

        stream: {
            ticket: () => request<{ ticket: string }>("/stream/ticket", post()),
        },
    };
}

export type Endpoints = ReturnType<typeof buildEndpoints>;
// AppNotification fica exportado para quem tipa callbacks de notificação.
export type { AppNotification };
