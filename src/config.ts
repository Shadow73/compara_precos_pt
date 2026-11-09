// URL do backend: vazio em dev (o Vite faz proxy para localhost:3001);
// em produção aponta para o backend (ex.: https://meu-backend.onrender.com)
export const API_BASE = import.meta.env.VITE_API_URL ?? '';
