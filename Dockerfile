FROM node:20-alpine

WORKDIR /app

COPY package.json ./
COPY . .

ENV PORT=3847
ENV NODE_ENV=production

EXPOSE 3847

CMD ["node", "server.mjs"]
