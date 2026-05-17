import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const resolvePath = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: "src",
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
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolvePath("./src/index.html"),
        home: resolvePath("./src/html/home.html"),
        community: resolvePath("./src/html/community.html"),
        login: resolvePath("./src/html/user-pages/login.html"),
        register: resolvePath("./src/html/user-pages/register.html"),
        recoverPassword: resolvePath("./src/html/user-pages/recover-password.html"),
        profileView: resolvePath("./src/html/user-pages/profile-view.html"),
        profileSettings: resolvePath("./src/html/user-pages/profile-settings.html"),
        terms: resolvePath("./src/html/legal/terms.html"),
      }
    }
  }
});
