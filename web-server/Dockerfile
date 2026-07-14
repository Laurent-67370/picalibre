FROM node:22-slim
WORKDIR /app

# better-sqlite3 a besoin d'outils de compilation au premier install
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV PORT=4100
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 4100

CMD ["node", "src/index.js"]
