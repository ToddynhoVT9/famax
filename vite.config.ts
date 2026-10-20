import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const resolvePath = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: "client",
  server: {
    open: "/index.html",
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  plugins: [],
  build: {
    outDir: "../dist/public",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolvePath("./client/index.html"),
        home: resolvePath("./client/html/home.html"),
        community: resolvePath("./client/html/community.html"),
        communityNew: resolvePath("./client/html/community/new.html"),
        login: resolvePath("./client/html/user-pages/login.html"),
        register: resolvePath("./client/html/user-pages/register.html"),
        recoverPassword: resolvePath(
          "./client/html/user-pages/recover-password.html",
        ),
        profileView: resolvePath("./client/html/user-pages/profile-view.html"),
        profileSettings: resolvePath(
          "./client/html/user-pages/profile-settings.html",
        ),
        terms: resolvePath("./client/html/legal/terms.html"),
        search: resolvePath("./client/html/search.html"),
        post: resolvePath("./client/html/post.html"),
        moderation: resolvePath("./client/html/community/moderation.html"),
        adminReports: resolvePath("./client/html/admin/reports.html"),
        notifications: resolvePath("./client/html/notifications.html"),
        verifyEmail: resolvePath("./client/html/user-pages/verify-email.html"),
      },
    },
  },
});
