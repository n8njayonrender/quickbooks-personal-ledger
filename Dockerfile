FROM node:24-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

# Persist SQLite database in /app/data
VOLUME ["/app/data"]

ENV PORT=3456
EXPOSE 3456

CMD ["node", "server.js"]
