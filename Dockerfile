FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json tsconfig.json ./
RUN npm ci --no-audit --no-fund
COPY src ./src
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=80
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/dist ./dist
COPY *.schema.json ./
EXPOSE 80
CMD ["node", "dist/index.js"]
