import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const resolvePath = (path: string): string =>
  fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  root: "src",
  server: {
    open: "/index.html",
  },
  plugins: [],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolvePath("./src/index.html"),
        home: resolvePath("./src/html/home.html"),
        login: resolvePath("./src/html/user-pages/login.html"),
        register: resolvePath("./src/html/user-pages/register.html"),
        profile: resolvePath("./src/html/user-pages/profile.html"),
        recoverPassword: resolvePath("./src/html/user-pages/recover-password.html")
      }
    }
  }
});
