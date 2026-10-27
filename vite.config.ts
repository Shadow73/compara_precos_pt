import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Em dev, o browser fala com o Vite e este reencaminha /api para o backend.
      // Assim evitamos problemas de CORS nas chamadas ao nosso próprio servidor.
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
});
