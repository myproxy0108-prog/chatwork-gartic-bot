const express = require('express');
const axios = require('axios');
const FormData = require('form-data');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// 【ステルス化】Botだとバレないための拡張機能を読み込む
const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
chromium.use(stealth);

const app = express();

const PORT = process.env.PORT || 3000;
const CHATWORK_API_TOKEN = process.env.CHATWORK_API_TOKEN;
const CHATWORK_WEBHOOK_TOKEN = process.env.CHATWORK_WEBHOOK_TOKEN;

if (!CHATWORK_API_TOKEN) {
  console.error('環境変数 CHATWORK_API_TOKEN が設定されていません。処理を終了します。');
  process.exit(1);
}

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

async function fetchRecentMessageIds(roomId) {
  try {
    const res = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages?force=1`, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    if (Array.isArray(res.data)) {
      return new Set(res.data.map(m => String(m.message_id)));
    }
  } catch (err) {
    console.error('直近メッセージ取得エラー:', err.response?.data || err.message);
  }
  return new Set();
}

async function deleteDescriptionChangeNotification(roomId, beforeIds) {
  try {
    await new Promise(resolve => setTimeout(resolve, 2500));
    const res = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}/messages?force=1`, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    if (!Array.isArray(res.data)) return;

    for (const msg of res.data) {
      const id = String(msg.message_id);
      if (beforeIds.has(id)) continue;
      if (processedMessageIds.has(id)) continue;

      await axios.delete(`https://api.chatwork.com/v2/rooms/${roomId}/messages/${id}`, {
        headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
      });
      console.log(`概要変更通知メッセージを削除しました: ${id}`);
    }
  } catch (err) {
    console.error('通知メッセージ削除エラー:', err.response?.data || err.message);
  }
}

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

async function updateRoomDescription(roomId, newContent) {
  try {
    const getRes = await axios.get(`https://api.chatwork.com/v2/rooms/${roomId}`, {
      headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN }
    });
    if (getRes.data.type === 'my') return;

    const beforeIds = await fetchRecentMessageIds(roomId);
    const currentDesc = getRes.data.description || '';
    const regex = /\[Gartic Phone URL\]: .*\n?/g;
    const newLine = `[Gartic Phone URL]: ${newContent}\n`;

    const bodyWithoutOldLine = currentDesc.replace(regex, '');
    const updatedDesc = newLine + bodyWithoutOldLine;

    await axios.put(`https://api.chatwork.com/v2/rooms/${roomId}`,
      new URLSearchParams({ description: updatedDesc }),
      { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
    );

    await deleteDescriptionChangeNotification(roomId, beforeIds);
  } catch (err) {
    console.error('概要更新エラー:', err.response?.data || err.message);
  }
}

async function sendCwMessage(roomId, text) {
  try {
    const res = await axios.post(
      `https://api.chatwork.com/v2/rooms/${roomId}/messages`,
      new URLSearchParams({ body: text }),
      { headers: { 'X-ChatWorkToken': CHATWORK_API_TOKEN } }
    );
    if (res.data && res.data.message_id) {
      processedMessageIds.add(String(res.data.message_id));
    }
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
        '--window-size=1280,720',
        '--disable-blink-features=AutomationControlled' // 自動化ソフトであることを隠蔽
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
      locale: 'ja-JP',
      // 人間が使っているWindows PCのChromeのフリをする
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    let joinConfirmed = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;

    try {
      const nameInput = page.locator('input').first();
      await nameInput.waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForTimeout(1000); 

      const consentBtn = page.locator('button').filter({ hasText: /Consent|Accept|同意|AGREE/i }).first();
      if (await consentBtn.isVisible().catch(() => false)) {
        await consentBtn.click();
        await page.waitForTimeout(500);
      }

      while (retryCount < MAX_RETRIES && !joinConfirmed) {
        retryCount++;
        console.log(`入室試行: ${retryCount}回目`);

        if (await nameInput.isVisible().catch(() => false)) {
          await nameInput.click({ clickCount: 3 });
          await page.keyboard.press('Backspace');
          await nameInput.fill('AlbumBot');
          await page.waitForTimeout(500);

          const joinBtn = page.locator('button, [role="button"]').filter({ hasText: /参加|開始|Start|Play/i }).first();
          if (await joinBtn.isVisible().catch(() => false)) {
            await joinBtn.click();
            console.log('「参加」ボタンをクリックしました');
          } else {
            await nameInput.press('Enter');
            console.log('Enterキーを押下しました');
          }

          await page.waitForTimeout(2000);
          
          if (!(await nameInput.isVisible().catch(() => false))) {
            joinConfirmed = true; 
          }
        } else {
          joinConfirmed = true; 
        }
      }
    } catch (e) {
      console.log('入力欄の待機タイムアウト、またはエラー:', e.message);
    }

    if (joinConfirmed) {
      const joinedShot = path.join(__dirname, `joined_${Date.now()}.png`);
      await page.screenshot({ path: joinedShot });
      await sendCwFile(roomId, joinedShot, 'Gartic Phoneへの参加を確認しました。監視中のBotの画面はこちらです。アルバム発表を待ちます...');
      if(fs.existsSync(joinedShot)) fs.unlinkSync(joinedShot);
    } else {
      const errorShot = path.join(__dirname, `error_${Date.now()}.png`);
      await page.screenshot({ path: errorShot });
      await sendCwFile(roomId, errorShot, '[エラー] 何度か入室を試みましたが、参加できませんでした。現在の画面です。処理を中断します。');
      if(fs.existsSync(errorShot)) fs.unlinkSync(errorShot);
      return; 
    }

    const sentGifsHashes = new Set();
    let isFinished = false;
    let checkCount = 0;

    page.on('download', async (download) => {
      try {
        const downloadPath = path.join(__dirname, `gartic_dl_${Date.now()}.gif`);
        await download.saveAs(downloadPath);
        const buffer = fs.readFileSync(downloadPath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');

        if (!sentGifsHashes.has(hash)) {
          sentGifsHashes.add(hash);
          await sendCwFile(roomId, downloadPath, `[info]アルバムGIF (${sentGifsHashes.size}作品目)[/info]`);
        }
        if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
      } catch (err) {
        console.error('ダウンロードイベント処理エラー:', err);
      }
    });

    while (!isFinished && checkCount < 600) { 
      checkCount++;

      const downloadElements = await page.$$('a[download], a[href*=".gif"], button.download, button:has-text(".GIF"), button:has-text("GIF")');

      for (const el of downloadElements) {
        try {
          if (!(await el.isVisible())) continue;

          const isProcessed = await el.evaluate(e => e.hasAttribute('data-bot-processed'));
          if (isProcessed) continue;

          console.log('新しいGIFボタンを発見しました。スクショとダウンロードを開始します。');

          const screenshotPath = path.join(__dirname, `screenshot_${Date.now()}.png`);
          await page.screenshot({ path: screenshotPath });
          await sendCwFile(roomId, screenshotPath, `[info]スクリーンショット[/info]`);
          if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);

          await el.evaluate(e => e.setAttribute('data-bot-processed', 'true'));

          const href = await el.getAttribute('href');
          if (href && href.includes('.gif')) {
            const absoluteHref = /^https?:\/\//i.test(href) ? href : new URL(href, page.url()).toString();
            const response = await page.request.get(absoluteHref);
            const buffer = await response.body();
            const hash = crypto.createHash('md5').update(buffer).digest('hex');

            if (!sentGifsHashes.has(hash)) {
              sentGifsHashes.add(hash);
              const savePath = path.join(__dirname, `gartic_${Date.now()}.gif`);
              fs.writeFileSync(savePath, buffer);
              await sendCwFile(roomId, savePath, `[info]アルバムGIF (${sentGifsHashes.size}作品目)[/info]`);
              if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
            }
          } else {
            const tagName = await el.evaluate(e => e.tagName.toLowerCase());
            if (tagName === 'button') {
              await el.click({ timeout: 1000 }).catch(() => {});
            }
          }
        } catch (e) {}
      }

      try {
        const shouldFinish = await page.evaluate(() => {
          const bodyText = document.body.innerText.toUpperCase();
          if (bodyText.includes('ロビーに戻る') || bodyText.includes('PLAY AGAIN') || bodyText.includes('接続が切断されました')) {
            return true;
          }
          if (window.location.pathname === '/' || window.location.pathname === '/ja') {
            return true;
          }
          const buttons = Array.from(document.querySelectorAll('button'));
          for (const btn of buttons) {
            const btnText = (btn.textContent || '').toUpperCase();
            if ((btnText.includes('HOME') || btnText.includes('ホーム')) && btn.offsetHeight > 30) {
              return true;
            }
          }
          return false;
        });

        if (shouldFinish) {
          console.log('アルバム終了（みんなが抜けた状態）を検知しました');
          isFinished = true;
          break;
        }
      } catch (e) {}

      await page.waitForTimeout(1000);
    }

    await sendCwMessage(roomId, `[info][title]完了[/title]全員のアルバム取得が完了しました。Botは退室します。（合計 ${sentGifsHashes.size}件）[/info]`);

    currentGarticUrl = null;
    await updateRoomDescription(roomId, '今は開始していません！');

  } catch (error) {
    console.error('Gartic操作エラー:', error);
    await sendCwMessage(roomId, `エラーが発生しました: ${error.message}`);
  } finally {
    if (browser) await browser.close();
    isProcessing = false;
  }
}

app.get('/', (req, res) => {
  res.status(200).send('Bot Server is running.');
});

app.post('/webhook', (req, res) => {
  res.status(200).send('OK');

  (async () => {
    try {
      if (!isValidSignature(req)) {
        console.warn('署名検証に失敗したリクエストを無視しました。');
        return;
      }

      const webhookEvent = req.body.webhook_event;
      if (!webhookEvent) return;

      const { message_id: messageId, body: messageText, room_id: roomId } = webhookEvent;
      if (!messageId || !messageText || !roomId) return;

      if (messageText.includes('[info][title]')) return;
      if (messageText.includes('[エラー]')) return;
      if (messageText.includes('監視中のBotの画面はこちらです')) return;

      if (processedMessageIds.has(String(messageId))) return;
      processedMessageIds.add(String(messageId));
      if (processedMessageIds.size > MAX_CACHE_SIZE) {
        processedMessageIds.delete(processedMessageIds.values().next().value);
      }

      const match = messageText.match(GARTIC_URL_REGEX);
      if (match) {
        currentGarticUrl = match[0];
        await updateRoomDescription(roomId, currentGarticUrl);
      }

      if (messageText.includes('開示')) {
        if (isProcessing) {
          await sendCwMessage(roomId, '現在すでに「開示」処理を実行中です。完了までお待ちください。');
          return;
        }

        const targetUrl = currentGarticUrl || await getUrlFromDescription(roomId);
        if (!targetUrl || targetUrl.includes('今は開始していません')) {
          await sendCwMessage(roomId, 'URLが設定されていません。概要にURLがあるか確認するか、先にURLを送信してください。');
          return;
        }

        handleGarticAlbum(roomId, targetUrl).catch(err => {
          console.error('handleGarticAlbum内で捕捉されなかったエラー:', err);
          isProcessing = false;
        });
      }
    } catch (err) {
      console.error('Webhook処理中の予期せぬエラー:', err);
    }
  })();
});

process.on('unhandledRejection', (reason) => {
  console.error('未処理のPromise拒否:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('未処理の例外:', err);
});

app.listen(PORT, () => {
  console.log(`Bot Server listening on port ${PORT}`);
});
