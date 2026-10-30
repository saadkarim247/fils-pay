import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // apps/web already owns 5173.
    // 5174 clashes with storybook on my machine — am
    port: 5174,
    // Same-origin in dev: the API has no CORS, so the browser blocked every
    // credentialed call to :3000. .env.development sets the base URL to "" so
    // requests go to /v1 here and are forwarded.
    proxy: { "/v1": "http://localhost:3000" },
  },
});
