# Playwright公式イメージ: Chromiumに必要なOS依存ライブラリが最初から全部入っている
FROM mcr.microsoft.com/playwright:v1.47.0-jammy
 
WORKDIR /app
 
COPY package*.json ./
# 通常のpostinstallでもう一度ブラウザを入れようとするが、
# このイメージには既にChromiumが入っているためすぐ完了する
RUN npm install
 
COPY . .
 
ENV NODE_ENV=production
EXPOSE 3000
 
CMD ["node", "index.js"]
