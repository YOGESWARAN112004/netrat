FROM node:18-alpine

WORKDIR /app

COPY server/package.json ./server/package.json
RUN npm install --prefix ./server --production

COPY server/ ./server/
COPY init.sql ./init.sql

EXPOSE 3000
CMD ["node", "server/server.js"]
