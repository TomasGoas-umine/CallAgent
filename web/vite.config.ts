import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * `base: './'` es deliberado: el micrositio se va a embeber dentro de un core de Umine bajo un
 * path que hoy no conocemos, asi que los assets del build tienen que referenciarse de forma
 * relativa. Nunca poner rutas absolutas (`/assets/...`) ni un router con paths absolutos — las
 * tres vistas se cambian con estado local, no con URLs.
 *
 * En desarrollo, `/api` se proxea al server Fastify local (src/local/server.ts). Asi el front
 * llama siempre a rutas relativas y no necesita CORS ni saber en que puerto vive el backend.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.UMINE_VOICE_API_TARGET ?? 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
