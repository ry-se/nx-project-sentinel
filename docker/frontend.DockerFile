FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
COPY nx.json ./
COPY tsconfig.base.json ./
COPY apps ./apps
COPY packages ./packages

RUN npm ci

RUN npx nx build frontend

EXPOSE 4200

CMD ["npx", "nx", "serve", "frontend", "--host=0.0.0.0"]
