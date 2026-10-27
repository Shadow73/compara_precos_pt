# Base com dependências de sistema do Playwright
FROM mcr.microsoft.com/playwright:v1.48.0-jammy

WORKDIR /app

COPY package.json ./
# "npx playwright install chromium" garante que o browser corresponde à
# versão EXATA do playwright que o npm instalou — mesmo que o package.json
# mude no futuro, o build nunca fica com browser em falta.
RUN npm install && npx playwright install chromium

COPY . .

ENV PORT=3001
EXPOSE 3001

CMD ["node", "server/index.js"]
