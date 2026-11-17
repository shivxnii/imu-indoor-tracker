import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Reads optional settings from ../.env (see .env.example).
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, "..", "");
  const https = command === "serve" && env.HTTPS !== "0";
  return {
    base: env.BASE || "/",
    envDir: "..",
    plugins: [react(), ...(https ? [basicSsl()] : [])],
    server: { host: true, port: Number(env.PORT || 5173), allowedHosts: true },
    preview: { host: true, port: 4173, allowedHosts: true }
  };
});
