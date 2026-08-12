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

// メモリ上のURL。Render再起動で消滅するため、概要(Description)から復元する設計に変更
let currentGarticUrl = null;
let isProcessing = false;
const GARTIC_URL_REGEX = /https?:\/\/[^\s]+\/ja\/[a-zA-Z0-9]{8}/;
const processedMessageIds = new Set();
const MAX_CACHE_SIZE = 1000;

function isValidSignature(req) {
  if (!CHATWORK_WEBHOOK_TOKEN) return true;
  const signature = req.headers['x-chatworkwebhooksignature'];
  if (!signature || !req.rawBody) return false;
  const key = Buffer.from(CHATWORK_WEBHOOK_TOKEN, 'base64');
  const hmac = crypto.createHmac('sha256', key);
  const expectedSignature = hmac.update(req.rawBody).digest('base64');
  return signature === expectedSignature;
}

// 【追加】ルームの概要からURLを読み取って復元する関数
async function getUrlFromDescription(roomId) {
  if (currentGarticUrl) return currentGarticUrl; // メモリに残っていればそのまま使用

  try {
    const getRes = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    const currentDesc = getRes.data.description || '';
    
    // 概要欄からURLを抽出
    const match = currentDesc.match(/\[Gartic Phone URL\]: (https?:\/\/[^\s]+\/ja\/[a-zA-Z0-9]{8})/);
    if (match) {
      currentGarticUrl = match[1];
      console.log(`概要からURLを復元しました: ${currentGarticUrl}`);
      return currentGarticUrl;
    }
  } catch (err) {
    console.error('ルーム情報取得エラー', err.message);
  }
  return null;
}

// 【改善】ルームの概要(Description)を更新する関数
async function updateRoomDescription(roomId, newUrl) {
  try {
    const getRes = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    
    // マイチャット対策
    if (getRes.data.type === 'my') {
      await sendCwMessage(roomId, '[エラー] マイチャットでは概要を更新できません。グループチャットをご利用ください。');
      return;
    }

    let currentDesc = getRes.data.description || '';
    const regex = /\[Gartic Phone URL\]: https?:\/\/[^\s]+\/ja\/[a-zA-Z0-9]{8}\n?/g;
    const newLine = `[Gartic Phone URL]: ${newUrl}\n`;
    
    if (currentDesc.match(regex)) {
      currentDesc = currentDesc.replace(regex, newLine); // 既存のURLを置換
    } else {
      currentDesc = newLine + currentDesc; // 概要の先頭に追加
    }
    
    // 概要の更新
    const params = new URLSearchParams();
    params.append('description', currentDesc);

    await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}`, params, { 
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    
    console.log(`ルームの概要を更新しました: ${newUrl}`);
  } catch (err) {
    // 権限エラー(403)などの場合はチャットに通知して原因を教える
    if (err.response && err.response.status === 403) {
      await sendCwMessage(roomId, '[エラー] 概要を更新できませんでした。あなたのアカウントにこのルームの「管理者」権限がありません。（URLは一時的に記憶されます）');
    } else {
      console.error('ルーム概要更新エラー:', err.response?.data || err.message);
    }
  }
}

async function sendCwMessage(roomId, text) {
  try {
    await axios.post(
      `https://api.chatwork.com/v2/rooms/${roomId}/messages`,
      new URLSearchParams({ body: text }),
      { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
    );
  } catch (err) {
    console.error('メッセージ送信エラー:', err.response?.data || err.message);
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
      { headers: { ...form.getHeaders(), 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
    );
  } catch (err) {
    console.error('ファイル送信エラー:', err.response?.data || err.message);
  }
}

async function handleGarticAlbum(roomId, targetUrl) {
  isProcessing = true;
  console.log(`処理開始: ${targetUrl}`);
  await sendCwMessage(roomId, `[info][title]Gartic Phone[/title]参加処理を開始します（ブラウザ起動中...）\nURL: ${targetUrl}[/info]`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--mute-audio',
        '--single-process'
      ]
    });
    
    const context = await browser.newContext({ acceptDownloads: true });
    const page = await context.newPage();

    await page.goto(targetUrl, { waitUntil: 'networkidle' });

    await page.waitForSelector('input[type="text"]', { timeout: 10000 });
    await page.fill('input[type="text"]', 'AlbumBot');

    const joinButton = await page.$('button.primary, button[type="submit"]');
    if (joinButton) {
      await joinButton.click();
    }

    await sendCwMessage(roomId, 'Gartic Phoneに無事参加しました。アルバム（結果）画面を待機しています...');

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
    await sendCwMessage(roomId, `Gartic Phoneの操作中にエラーが発生しました。\n(エラー内容: ${error.message})`);
  } finally {
    if (browser) {
      await browser.close();
    }
    isProcessing = false;
  }
}

app.post('/webhook', async (req, res) => {
  if (!isValidSignature(req)) {
    return res.status(401).send('Unauthorized');
  }

  res.status(200).send('OK');

  const webhookData = req.body;
  const webhookEvent = webhookData.webhook_event;
  const messageId = webhookEvent?.message_id;
  const messageText = webhookEvent?.body;
  const roomId = webhookEvent?.room_id;

  if (!messageId || !messageText || !roomId) return;

  // Bot自身の自動送信メッセージに反応しないようにする
  if (
    messageText.includes('[info][title]Gartic Phone[/title]') ||
    messageText.includes('[info][title]完了[/title]') ||
    messageText.includes('[エラー]')
  ) {
    return;
  }

  if (processedMessageIds.has(messageId)) {
    return;
  }

  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_CACHE_SIZE) {
    const firstItem = processedMessageIds.values().next().value;
    processedMessageIds.delete(firstItem);
  }

  // ① URLを検知した場合
  const match = messageText.match(GARTIC_URL_REGEX);
  if (match) {
    currentGarticUrl = match[0]; // メモリに保持
    // 概要を更新（メッセージは送らない。エラーの時だけ喋る）
    await updateRoomDescription(roomId, currentGarticUrl);
    return;
  }

  // ② 「開示」と言われた場合
  if (messageText.trim() === '開示') {
    if (isProcessing) {
      await sendCwMessage(roomId, '現在すでに「開示」処理を実行中です。完了までお待ちください。');
      return;
    }

    // 概要欄からURLを取得・復元する（サーバー再起動対策）
    const targetUrl = await getUrlFromDescription(roomId);

    if (!targetUrl) {
      await sendCwMessage(roomId, 'URLが設定されていません。先にGartic PhoneのURLを送信してください。');
      return;
    }

    handleGarticAlbum(roomId, targetUrl);
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
