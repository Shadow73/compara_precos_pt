# Imagem oficial do Playwright: já inclui Chromium + dependências de sistema
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

# Dependências primeiro (cache do Docker)
COPY package.json ./
RUN npm install

# Código do backend (não precisa do frontend para correr em produção,
# mas incluímos tudo para simplificar)
COPY . .

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server/index.js"]
