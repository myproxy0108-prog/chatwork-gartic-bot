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
        '--disable-gpu'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
      locale: 'ja-JP' // 確実に日本語UIにする
    });
    const page = await context.newPage();

    // 1. ページを開く
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    let joinConfirmed = false;

    // 2. 【改善】UI(入力欄)が描画されるまで確実に待つ (最大30秒)
    try {
      await page.waitForSelector('input', { state: 'visible', timeout: 30000 });
      await page.waitForTimeout(1000); // 描画安定待機

      // クッキー同意ダイアログ等
      const consentBtn = await page.$('button:has-text("Consent"), button:has-text("Accept"), button:has-text("同意"), button:has-text("AGREE")');
      if (consentBtn && await consentBtn.isVisible()) {
        await consentBtn.click();
        await page.waitForTimeout(500);
      }

      // 3. 【改善】ニックネームを確実に入力してEnterを押す
      const nameInput = await page.$('input');
      if (nameInput && await nameInput.isVisible()) {
        // 元々入っている名前を全選択して上書き
        await nameInput.click({ clickCount: 3 });
        await page.keyboard.press('Backspace');
        await nameInput.fill('AlbumBot');
        await page.waitForTimeout(500);

        // Enterキーで参加（一番確実）
        await nameInput.press('Enter');
        console.log('Enterキーを押下して参加処理を行いました');
        await page.waitForTimeout(1500);

        // もしEnterで進まなかった場合は、開始ボタンを探してクリック
        if (await nameInput.isVisible()) {
          const startButtonSelectors = [
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
              console.log(`開始ボタンをクリックしました: ${selector}`);
              break;
            }
          }
        }

        // 4. 【改善】入力欄が消えたか（＝確実に入室できたか）を確認
        try {
          await page.waitForFunction(() => {
            const inputs = Array.from(document.querySelectorAll('input'));
            return inputs.every(el => el.offsetParent === null); // すべてのinputが非表示になればOK
          }, { timeout: 10000 });
          joinConfirmed = true;
        } catch (_) {
          joinConfirmed = false;
        }
      }
    } catch (e) {
      console.log('入力欄の待機タイムアウト、またはエラー:', e.message);
      joinConfirmed = false;
    }

    if (joinConfirmed) {
      await sendCwMessage(roomId, 'Gartic Phoneへの参加を確認しました。アルバム発表を監視中...');
    } else {
      await sendCwMessage(roomId, '[警告] 画面の読み込みが間に合わなかったか、開始ボタンが効きませんでした。Botが入室できていない可能性があります。（監視は一応継続します）');
    }

    // 5. アルバムGIFの待機・ダウンロード処理
    const sentGifsHashes = new Set();
    const downloadedUrls = new Set();
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
          await sendCwFile(roomId, downloadPath, `アルバムGIFを取得しました (${sentGifsHashes.size}作品目)`);
        }
        if (fs.existsSync(downloadPath)) fs.unlinkSync(downloadPath);
      } catch (err) {
        console.error('ダウンロードイベント処理エラー:', err);
      }
    });

    // 高速チェックループ
    while (!isFinished && checkCount < 600) { 
      checkCount++;

      const downloadElements = await page.$$('a[download], a[href*=".gif"], button.download, button:has-text(".GIF"), button:has-text("GIF"), button:has-text("ダウンロード"), button:has-text("Download")');

      for (const el of downloadElements) {
        try {
          if (!(await el.isVisible())) continue;

          const href = await el.getAttribute('href');

          if (href && href.includes('.gif')) {
            const absoluteHref = /^https?:\/\//i.test(href) ? href : new URL(href, page.url()).toString();

            if (!downloadedUrls.has(absoluteHref)) {
              downloadedUrls.add(absoluteHref);

              const response = await page.request.get(absoluteHref);
              const buffer = await response.body();
              const hash = crypto.createHash('md5').update(buffer).digest('hex');

              if (!sentGifsHashes.has(hash)) {
                sentGifsHashes.add(hash);
                const savePath = path.join(__dirname, `gartic_${Date.now()}.gif`);
                fs.writeFileSync(savePath, buffer);

                await sendCwFile(roomId, savePath, `アルバムGIFを取得しました (${sentGifsHashes.size}作品目)`);
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

      // 終了判定：アルバムが終わり、プレイヤーがロビーに戻ったか解散したかを判定
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
      if (messageText.includes('[警告]')) return;

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
