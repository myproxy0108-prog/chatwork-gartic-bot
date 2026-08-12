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
// 【修正】現在の "?c=" を含むURL仕様に対応（ハイフンなども許容）
const GARTIC_URL_REGEX = /https?:\/\/[^\s]+\/ja\/(?:\?c=)?[a-zA-Z0-9_-]+/i;
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
    // 【修正】概要からの抽出も現在のURL仕様に対応
    const match = (getRes.data.description || '').match(/\[Gartic Phone URL\]:\s*(https?:\/\/[^\s]+\/ja\/(?:\?c=)?[a-zA-Z0-9_-]+)/i);
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

// Gartic Phoneのアルバム取得メイン処理
async function handleGarticAlbum(roomId, targetUrl) {
  // ※ここでは isProcessing = true の設定は不要（呼び出し元で設定済み）
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
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
      locale: 'ja-JP'
    });
    const page = await context.newPage();

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    let joinConfirmed = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;

    try {
      await page.waitForSelector('input', { state: 'visible', timeout: 30000 });
      await page.waitForTimeout(1000); 

      const consentBtn = await page.$('button:has-text("Consent"), button:has-text("Accept"), button:has-text("同意"), button:has-text("AGREE")');
      if (consentBtn && await consentBtn.isVisible()) {
        await consentBtn.click();
        await page.waitForTimeout(500);
      }

      while (retryCount < MAX_RETRIES && !joinConfirmed) {
        retryCount++;
        console.log(`入室試行: ${retryCount}回目`);

        const nameInput = await page.$('input');
        if (nameInput && await nameInput.isVisible()) {
          await nameInput.click({ clickCount: 3 });
          await page.keyboard.press('Backspace');
          await nameInput.fill('AlbumBot');
          await page.waitForTimeout(500);

          await nameInput.press('Enter');
          await page.waitForTimeout(1500);

          if (await nameInput.isVisible()) {
            const startButtonSelectors = [
              'button:has-text("参加")',
              'button:has-text("開始")',
              'button:has-text("Start")',
              'button:has-text("Play")',
              'button.primary',
              'button.bt-start',
              'button[type="submit"]'
            ];
            for (const selector of startButtonSelectors) {
              const btn = await page.$(selector);
              if (btn && await btn.isVisible()) {
                await btn.click();
                console.log(`入室ボタンをクリックしました: ${selector}`);
                break;
              }
            }
          }

          try {
            await page.waitForFunction(() => {
              const inputs = Array.from(document.querySelectorAll('input'));
              return inputs.every(el => el.offsetParent === null); 
            }, { timeout: 5000 });
            joinConfirmed = true;
          } catch (_) {
            joinConfirmed = false;
          }
        }
      }
    } catch (e) {
      console.log('入力欄の待機タイムアウト、またはエラー:', e.message);
      joinConfirmed = false;
    }

    if (joinConfirmed) {
      await sendCwMessage(roomId, 'Gartic Phoneへの参加を確認しました。アルバム発表を監視中...');
    } else {
      await sendCwMessage(roomId, '[エラー] 何度か入室を試みましたが、参加できませんでした。処理を中断し、退室します。');
      return; 
    }

    const sentGifsHashes = new Set();
    let isFinished = false;
    let checkCount = 0;

    // ダウンロードの裏側で動くイベント
    page.on('download', async (download) => {
      const downloadPath = path.join(__dirname, `gartic_dl_${Date.now()}.gif`);
      try {
        await download.saveAs(downloadPath);
        const buffer = fs.readFileSync(downloadPath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');

        if (!sentGifsHashes.has(hash)) {
          sentGifsHashes.add(hash);
          await sendCwFile(roomId, downloadPath, `[info]アルバムGIF (${sentGifsHashes.size}作品目)[/info]`);
        }
      } catch (err) {
        console.error('ダウンロードイベント処理エラー:', err);
      } finally {
        // 【修正】エラー時でも確実に一時ファイルを削除する（ストレージ枯渇対策）
        if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
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
          try {
            await page.screenshot({ path: screenshotPath });
            await sendCwFile(roomId, screenshotPath, `[info]スクリーンショット[/info]`);
          } finally {
            // 【修正】確実にスクリーンショットを削除
            if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
          }

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
              try {
                fs.writeFileSync(savePath, buffer);
                await sendCwFile(roomId, savePath, `[info]アルバムGIF (${sentGifsHashes.size}作品目)[/info]`);
              } finally {
                // 【修正】確実にGIFファイルを削除
                if (fs.existsSync(savePath)) fs.unlinkSync(savePath);
              }
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
    // 【処理終了時】確実にロック解除
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

        // 【修正】連打対策のため、非同期通信（await getUrlFromDescription）を行う「前」にロックをかける
        isProcessing = true;

        const targetUrl = currentGarticUrl || await getUrlFromDescription(roomId);
        if (!targetUrl || targetUrl.includes('今は開始していません')) {
          await sendCwMessage(roomId, 'URLが設定されていません。概要にURLがあるか確認するか、先にURLを送信してください。');
          // 【修正】URLがなかった場合にロックを解除しないと二度と動かなくなるため解除
          isProcessing = false;
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
