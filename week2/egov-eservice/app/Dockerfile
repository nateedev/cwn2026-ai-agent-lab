FROM node:22-slim
ENV TZ=Asia/Bangkok NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --include=dev --no-audit --no-fund
COPY . .
EXPOSE 3000
CMD ["node_modules/.bin/tsx", "src/app.ts"]
