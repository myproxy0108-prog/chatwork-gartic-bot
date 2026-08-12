const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const { chromium } = require('playwright');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();

const PORT = process.env.PORT || 3000;
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN;
const CHATWORK_WEBHOOK_TOKEN = process.env.CHATWORK_WEBHOOK_TOKEN;

app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));

let currentGarticUrl = null;
let isProcessing = false;
const GARTIC_URL_REGEX = /https?:\/\/[^\s]+\/ja\/[a-zA-Z0-9]{8}/;

// 【メッセージ重複防止】処理済みメッセージIDを記憶するSet
const processedMessageIds = new Set();
const MAX_CACHE_SIZE = 1000; // キャッシュ上限（メモリ肥大化防止）

function isValidSignature(req) {
  if (!CHATWORK_WEBHOOK_TOKEN) return true;

  const signature = req.headers['x-chatworkwebhooksignature'];
  if (!signature || !req.rawBody) return false;

  const key = Buffer.from(CHATWORK_WEBHOOK_TOKEN, 'base64');
  const hmac = crypto.createHmac('sha256', key);
  const expectedSignature = hmac.update(req.rawBody).digest('base64');

  return signature === expectedSignature;
}

async function sendCwMessage(roomId, text) {
  try {
    await axios.post(
      `https://api.chatwork.com/v2/rooms/${roomId}/messages`,
      new URLSearchParams({ body: text }),
      { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
    );
  } catch (err) {
    console.error('Chatworkメッセージ送信エラー:', err.response?.data || err.message);
  }
}

async function sendCwFile(roomId, filePath, caption = '') {
  try {
    const form = new FormData();
    form.append('file', fs.createReadStream(filePath));
    if (caption) {
      form.append('message', caption);
    }

    await axios.post(
      `https://api.chatwork.com/v2/rooms/${roomId}/files`,
      form,
      {
        headers: {
          ...form.getHeaders(),
          'X-ChatWorkToken': CHATWORK_API_TOKEN,
        },
      }
    );
  } catch (err) {
    console.error('Chatworkファイル送信エラー:', err.response?.data || err.message);
  }
}

async function handleGarticAlbum(roomId, targetUrl) {
  isProcessing = true;
  console.log(`Gartic Phone処理開始: ${targetUrl}`);
  await sendCwMessage(roomId, `[info][title]Gartic Phone[/title]参加処理を開始します...\nURL: ${targetUrl}[/info]`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();

  try {
    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    await page.waitForSelector('input[type="text"]');
    await page.fill('input[type="text"]', 'AlbumBot');

    const joinButton = await page.$('button.primary, button[type="submit"]');
    if (joinButton) {
      await joinButton.click();
    }

    await sendCwMessage(roomId, 'Gartic Phoneに参加しました。アルバム（結果）を待機中...');

    const sentGifsHashes = new Set();
    const downloadedUrls = new Set();
    let isFinished = false;
    let checkCount = 0;

    while (!isFinished && checkCount < 200) {
      checkCount++;

      const downloadElements = await page.$$('a[download], a[href*=".gif"], button.download');

      for (const el of downloadElements) {
        const href = await el.getAttribute('href');
        
        if (href && href.includes('.gif') && !downloadedUrls.has(href)) {
          downloadedUrls.add(href);

          const response = await page.request.get(href);
          const buffer = await response.body();

          const hash = crypto.createHash('md5').update(buffer).digest('hex');
          if (sentGifsHashes.has(hash)) {
            console.log(`重複したGIF画像のため無視（スキップ）: ${hash}`);
            continue;
          }

          sentGifsHashes.add(hash);

          const fileName = `gartic_${Date.now()}.gif`;
          const savePath = path.join(__dirname, fileName);

          fs.writeFileSync(savePath, buffer);

          await sendCwFile(roomId, savePath, `アルバムGIFを取得しました (${sentGifsHashes.size}作品目)`);

          if (fs.existsSync(savePath)) {
            fs.unlinkSync(savePath);
          }
        }
      }

      const endElement = await page.$('.exit, .finish, button:has-text("ロビーに戻る"), button:has-text("Home")');
      if (endElement && sentGifsHashes.size > 0) {
        isFinished = true;
      }

      await page.waitForTimeout(3000);
    }

    await sendCwMessage(roomId, `[info][title]完了[/title]全員のアルバム取得が完了しました。Botは退室します。（計 ${sentGifsHashes.size}件）[/info]`);

  } catch (error) {
    console.error('エラー:', error);
    await sendCwMessage(roomId, `エラーが発生しました: ${error.message}`);
  } finally {
    await browser.close();
    isProcessing = false;
  }
}

app.post('/webhook', async (req, res) => {
  if (!isValidSignature(req)) {
    console.warn('不正なWebhook署名を検出したため拒否しました');
    return res.status(401).send('Unauthorized');
  }

  // 即時レスポンス返却
  res.status(200).send('OK');

  const webhookData = req.body;
  const webhookEvent = webhookData.webhook_event;
  const messageId = webhookEvent?.message_id;
  const messageText = webhookEvent?.body;
  const roomId = webhookEvent?.room_id;

  if (!messageId || !messageText || !roomId) return;

  // 【重複防止】同じメッセージIDを既に処理していたらスキップ
  if (processedMessageIds.has(messageId)) {
    console.log(`重複メッセージのため無視しました: message_id=${messageId}`);
    return;
  }

  // メッセージIDを記録（古くなったIDは削除してメモリ肥大化を防止）
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_CACHE_SIZE) {
    const firstItem = processedMessageIds.values().next().value;
    processedMessageIds.delete(firstItem);
  }

  // URLの検知と設定
  const match = messageText.match(GARTIC_URL_REGEX);
  if (match) {
    currentGarticUrl = match[0];
    await sendCwMessage(roomId, `[info][title]URL設定[/title]対象のGartic Phoneを登録しました:\n${currentGarticUrl}[/info]`);
    return;
  }

  // 「開示」コマンドの判定
  if (messageText.trim() === '開示') {
    if (isProcessing) {
      await sendCwMessage(roomId, '現在すでに「開示」処理を実行中です。完了までお待ちください。');
      return;
    }

    if (!currentGarticUrl) {
      await sendCwMessage(roomId, 'URLが設定されていません。先にGartic PhoneのURLを送信してください。');
      return;
    }

    handleGarticAlbum(roomId, currentGarticUrl);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
