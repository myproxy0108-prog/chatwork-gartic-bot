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

// 【自動削除】概要更新時にチャットワークが出す通知メッセージを消去
async function deleteLatestSystemMessage(roomId) {
  try {
    await new Promise(resolve => setTimeout(resolve, 2500)); // チャットワーク側の反映待ち
    const res = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages?force=1`, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    if (res.data && Array.isArray(res.data) && res.data.length > 0) {
      for (let i = res.data.length - 1; i >= Math.max(0, res.data.length - 3); i--) {
        const msg = res.data[i];
        if (msg.body && (msg.body.includes('概要を変更しました') || msg.body.includes('Description has been changed') || msg.body.includes('[dtime:'))) {
          await axios.delete(`https://api.chatwork.com/v2/rooms/${roomId}/messages/${msg.message_id}`, {
            headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
          });
          console.log(`概要変更通知メッセージを削除しました: ${msg.message_id}`);
          break;
        }
      }
    }
  } catch (err) {
    console.error('通知メッセージ削除エラー:', err.response?.data || err.message);
  }
}

// 概要欄からURLを自動復元（Render再起動・スリープ対策）
async function getUrlFromDescription(roomId) {
  try {
    const getRes = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    const match = (getRes.data.description || '').match(/\[Gartic Phone URL\]: (https?:\/\/[^\s]+\/ja\/[a-zA-Z0-9]{8})/);
    if (match) {
      currentGarticUrl = match[1];
      return currentGarticUrl;
    }
  } catch (err) {
    console.error('概要からのURL取得エラー:', err.message);
  }
  return null;
}

// 概要の最上部を書き換える
async function updateRoomDescription(roomId, newUrl) {
  try {
    const getRes = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    if (getRes.data.type === 'my') return;

    let currentDesc = getRes.data.description || '';
    const regex = /\[Gartic Phone URL\]: https?:\/\/[^\s]+\/ja\/[a-zA-Z0-9]{8}\n?/g;
    const newLine = `[Gartic Phone URL]: ${newUrl}\n`;

    currentDesc = currentDesc.match(regex) ? currentDesc.replace(regex, newLine) : newLine + currentDesc;

    await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}`, 
      new URLSearchParams({ description: currentDesc }), 
      { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
    );

    // 書き換えた時に出る通知メッセージを削除
    await deleteLatestSystemMessage(roomId);
  } catch (err) {
    console.error('概要更新エラー:', err.response?.data || err.message);
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
    if (caption) form.append('message', caption);

    await axios.post(
      `https://api.chatwork.com/v2/rooms/${roomId}/files`,
      form,
      { headers: { ...form.getHeaders(), 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
    );
  } catch (err) {
    console.error('ファイル送信エラー:', err.response?.data || err.message);
  }
}

// Gartic Phoneのアルバム取得メイン処理
async function handleGarticAlbum(roomId, targetUrl) {
  isProcessing = true;
  console.log(`Gartic Phone処理開始: ${targetUrl}`);
  await sendCwMessage(roomId, `[info][title]Gartic Phone[/title]ルームへ接続を開始します...\nURL: ${targetUrl}[/info]`);

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--single-process'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true
    });
    const page = await context.newPage();

    // 1. ページを開く
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000); // 描画安定待機

    // 2. クッキー同意ダイアログ等があれば自動で閉じる
    try {
      const consentBtn = await page.$('button:has-text("Consent"), button:has-text("Accept"), button:has-text("同意")');
      if (consentBtn) await consentBtn.click();
    } catch (_) {}

    // 3. ニックネームの入力
    try {
      const nameInput = await page.$('input[type="text"], input:not([type="hidden"])');
      if (nameInput) {
        await nameInput.fill('AlbumBot');
        await page.waitForTimeout(500);
      }
    } catch (e) {
      console.log('ニックネーム欄なし（初期名で続行）');
    }

    // 4. 【重要】「開始」ボタンを探してクリック
    const startButtonSelectors = [
      'button:has-text("開始")',
      'button:has-text("Start")',
      'div[role="button"]:has-text("開始")',
      'button.primary',
      'button.bt-start',
      'button[type="submit"]'
    ];

    let clicked = false;
    for (const selector of startButtonSelectors) {
      const btn = await page.$(selector);
      if (btn && await btn.isVisible()) {
        await btn.click();
        clicked = true;
        console.log(`開始ボタンをクリックしました: ${selector}`);
        break;
      }
    }

    if (!clicked) {
      // 見つからなかった場合はEnterキーを押下
      await page.keyboard.press('Enter');
    }

    await sendCwMessage(roomId, 'Gartic Phoneに参加完了。「開始」を押して待機状態に入りました。アルバム発表を監視中...');

    // 5. アルバムGIFの待機・ダウンロード処理
    const sentGifsHashes = new Set();
    const downloadedUrls = new Set();
    let isFinished = false;
    let checkCount = 0;

    // ダウンロードイベント待機ハンドラ
    page.on('download', async (download) => {
      try {
        const downloadPath = path.join(__dirname, `gartic_dl_${Date.now()}.gif`);
        await download.saveAs(downloadPath);
        const buffer = fs.readFileSync(downloadPath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');

        if (!sentGifsHashes.has(hash)) {
          sentGifsHashes.add(hash);
          await sendCwFile(roomId, downloadPath, `アルバムGIFを取得しました (${sentGifsHashes.size}作品目)`);
        }
        if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
      } catch (err) {
        console.error('ダウンロードイベント処理エラー:', err);
      }
    });

    while (!isFinished && checkCount < 300) { // 最大15分間監視
      checkCount++;

      // GIFリンクやダウンロードボタンの検知
      const downloadElements = await page.$$('a[download], a[href*=".gif"], button.download, button:has-text("ダウンロード"), button:has-text("Download")');

      for (const el of downloadElements) {
        try {
          const href = await el.getAttribute('href');
          
          if (href && href.includes('.gif') && !downloadedUrls.has(href)) {
            downloadedUrls.add(href);

            const response = await page.request.get(href);
            const buffer = await response.body();
            const hash = crypto.createHash('md5').update(buffer).digest('hex');

            if (!sentGifsHashes.has(hash)) {
              sentGifsHashes.add(hash);
              const savePath = path.join(__dirname, `gartic_${Date.now()}.gif`);
              fs.writeFileSync(savePath, buffer);

              await sendCwFile(roomId, savePath, `アルバムGIFを取得しました (${sentGifsHashes.size}作品目)`);
              if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
            }
          } else {
            const tagName = await el.evaluate(e => e.tagName.toLowerCase());
            if (tagName === 'button') {
              await el.click().catch(() => {});
            }
          }
        } catch (e) {}
      }

      // 全員のアルバム終了判定（ロビーへ戻るボタン等）
      const endElement = await page.$('.exit, .finish, button:has-text("ロビーに戻る"), button:has-text("Home"), button:has-text("ロビー")');
      if (endElement && sentGifsHashes.size > 0) {
        console.log('アルバム全件の終了を検知');
        isFinished = true;
      }

      await page.waitForTimeout(3000);
    }

    await sendCwMessage(roomId, `[info][title]完了[/title]全員のアルバム取得が完了しました。Botは退室します。（合計 ${sentGifsHashes.size}件）[/info]`);

  } catch (error) {
    console.error('Gartic操作エラー:', error);
    await sendCwMessage(roomId, `エラーが発生しました: ${error.message}`);
  } finally {
    if (browser) await browser.close();
    isProcessing = false;
  }
}

app.post('/webhook', async (req, res) => {
  if (!isValidSignature(req)) return res.status(401).send('Unauthorized');
  res.status(200).send('OK');

  const webhookEvent = req.body.webhook_event;
  if (!webhookEvent) return;

  const { message_id: messageId, body: messageText, room_id: roomId } = webhookEvent;
  if (!messageId || !messageText || !roomId) return;

  // Bot自身のメッセージは無視
  if (messageText.includes('[info][title]')) return;

  if (processedMessageIds.has(messageId)) return;
  processedMessageIds.add(messageId);
  if (processedMessageIds.size > MAX_CACHE_SIZE) {
    processedMessageIds.delete(processedMessageIds.values().next().value);
  }

  // 1. URL検知 (概要を更新し、通知は自動削除)
  const match = messageText.match(GARTIC_URL_REGEX);
  if (match) {
    currentGarticUrl = match[0];
    await updateRoomDescription(roomId, currentGarticUrl);
  }

  // 2. 「開示」判定 (メッセージに含まれていれば実行)
  if (messageText.includes('開示')) {
    if (isProcessing) {
      await sendCwMessage(roomId, '現在すでに「開示」処理を実行中です。完了までお待ちください。');
      return;
    }

    const targetUrl = currentGarticUrl || await getUrlFromDescription(roomId);
    if (!targetUrl) {
      await sendCwMessage(roomId, 'URLが設定されていません。概要にURLがあるか確認するか、先にURLを送信してください。');
      return;
    }

    handleGarticAlbum(roomId, targetUrl);
  }
});

app.listen(PORT, () => {
  console.log(`Bot Server listening on port ${PORT}`);
});
