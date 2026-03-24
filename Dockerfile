FROM node:18-alpine

WORKDIR /app

# Копируем package.json и устанавливаем зависимости
COPY package*.json ./
RUN npm ci --only=production

# Копируем исходный код
COPY . .

# Создаём папку для статики
RUN mkdir -p public/icons

EXPOSE 8080

# Запускаем сервер
CMD ["node", "server.js"]
