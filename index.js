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

// ja でも en でもマッチするように変更
const GARTIC_URL_REGEX = /https?:\/\/[^\s]+\/(?:ja|en)\/[a-zA-Z0-9]{8}/;
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
    // 概要欄からは必ず /ja/ (または一応 /en/) のURLを拾う
    const match = (getRes.data.description || '').match(/\[Gartic Phone URL\]: (https?:\/\/[^\s]+\/(?:ja|en)\/[a-zA-Z0-9]{8})/);
    if (match) {
      // メモリに乗せる時は必ず /ja/ の形に直して保持（人間の視界用）
      currentGarticUrl = match[1].replace(/\/(ja|en)\//, '/ja/');
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

// 【超強化】絶対に止まらないスクショ撮影（5秒で強制タイムアウトさせる）
async function safeScreenshot(page, savePath) {
  try {
    await Promise.race([
      page.screenshot({ path: savePath }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('スクショ強制タイムアウト (5秒)')), 5000))
    ]);
    return true;
  } catch (e) {
    console.log(`スクリーンショット撮影をスキップしました: ${e.message}`);
    return false;
  }
}

// Gartic Phoneのアルバム取得メイン処理
async function handleGarticAlbum(roomId, targetUrl) {
  isProcessing = true;
  
  // Botがアクセスする時は文字化け（豆腐）を防ぐためにURLを強制的に /en/ に変換する
  const enUrl = targetUrl.replace(/\/(ja|en)\//, '/en/');
  
  console.log(`Gartic Phone処理開始: ${targetUrl} (※Botは英語UI ${enUrl} でアクセスします)`);
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
        '--disable-blink-features=AutomationControlled'
      ]
    });

    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      acceptDownloads: true,
      locale: 'en-US',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    const page = await context.newPage();

    // ダイアログは全て即座に「はい(Accept)」
    page.on('dialog', async dialog => {
      try {
        console.log(`ダイアログ出現: ${dialog.message()} -> 即座に自動承認します`);
        await dialog.accept();
      } catch (e) {
        console.error('ダイアログ承認中にエラー:', e.message);
      }
    });

    await page.goto(enUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

    let joinConfirmed = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;

    try {
      // 入力欄を待機
      const nameInput = page.locator('input[type="text"], input').first();
      await nameInput.waitFor({ state: 'visible', timeout: 30000 });
      await page.waitForTimeout(1000); 

      // クッキー同意ダイアログ処理
      const consentButtons = page.locator('button');
      for (let i = 0; i < await consentButtons.count(); i++) {
        const btn = consentButtons.nth(i);
        if (await btn.isVisible().catch(() => false)) {
          const text = await btn.textContent();
          if (/Consent|Accept|Agree|Got it|OK/i.test(text)) {
            await btn.click({ timeout: 2000 }).catch(() => {});
            await page.waitForTimeout(500);
            break;
          }
        }
      }

      // 【完全対応】入室リトライループ
      while (retryCount < MAX_RETRIES && !joinConfirmed) {
        retryCount++;
        console.log(`入室試行: ${retryCount}回目`);

        if (await nameInput.isVisible().catch(() => false)) {
          await nameInput.click({ clickCount: 3 });
          await page.keyboard.press('Backspace');
          await nameInput.fill('AlbumBot');
          await page.waitForTimeout(500);

          let clicked = false;
          // あらゆるボタン(button, a, role="button")を総当たりして、条件に合うものを探す
          const buttons = page.locator('button, [role="button"], a');
          const count = await buttons.count();
          
          for (let i = 0; i < count; i++) {
            const btn = buttons.nth(i);
            if (await btn.isVisible().catch(() => false)) {
              const text = (await btn.textContent() || '').trim();
              const type = (await btn.getAttribute('type') || '').toLowerCase();
              const className = (await btn.getAttribute('class') || '').toLowerCase();
              
              // テキストがJoin, Start, Playのいずれか、またはsubmitボタン、またはprimaryクラスなら押す
              if (/Join|Start|Play|参加|開始/i.test(text) || type === 'submit' || className.includes('primary')) {
                await btn.click({ timeout: 3000 }).catch(() => {});
                console.log(`入室ボタンをクリックしました (Text: ${text}, Type: ${type})`);
                clicked = true;
                break;
              }
            }
          }

          // ボタンが見つからなければ、最終手段として確実に入力欄でEnterを叩く
          if (!clicked) {
            await nameInput.press('Enter');
            console.log('入室ボタンが見つからなかったため、Enterキーを押下しました');
          }

          // 画面遷移・暗転を待つ
          await page.waitForTimeout(2000);
          
          // 入力欄が消えていれば参加成功
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
      if (await safeScreenshot(page, joinedShot)) {
        await sendCwFile(roomId, joinedShot, 'Gartic Phoneへの参加を確認しました。監視中のBotの画面はこちらです。(※文字化け対策のため英語モードで起動しています)');
        if(fs.existsSync(joinedShot)) fs.unlinkSync(joinedShot);
      } else {
        await sendCwMessage(roomId, 'Gartic Phoneへの参加を確認しました。アルバム発表を待ちます...（※画面撮影はタイムアウトでスキップしました）');
      }
    } else {
      const errorShot = path.join(__dirname, `error_${Date.now()}.png`);
      if (await safeScreenshot(page, errorShot)) {
        await sendCwFile(roomId, errorShot, '[エラー] 参加できませんでした。現在の画面です。処理を中断し、退室します。');
        if(fs.existsSync(errorShot)) fs.unlinkSync(errorShot);
      } else {
        await sendCwMessage(roomId, '[エラー] 参加できませんでした。処理を中断し、退室します。');
      }
      return; 
    }

    const sentGifsHashes = new Set();
    let isFinished = false;
    let checkCount = 0;

    // ダウンロード裏側待機イベント
    page.on('download', async (download) => {
      try {
        console.log('ダウンロードイベント検知！保存処理開始...');
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
        console.error('ダウンロードイベント処理エラー:', err.message);
      }
    });

    while (!isFinished && checkCount < 600) { // 最大10分監視
      checkCount++;

      try {
        // 英語環境でもGIFボタンは「.GIF」なので確実に見つかる
        const gifButtons = page.locator('button').filter({ hasText: '.GIF' });
        const btnCount = await gifButtons.count();

        for (let i = 0; i < btnCount; i++) {
          const btn = gifButtons.nth(i);
          if (await btn.isVisible().catch(() => false)) {
            
            // すでにクリック済みのボタンは無視する（連写防止）
            const isProcessed = await btn.evaluate(e => e.hasAttribute('data-bot-processed'));
            if (isProcessed) continue;

            console.log('.GIFボタンを発見しました。スクショとダウンロードを開始します。');

            // 1. スクショ撮影（タイムアウト時はスルーして止まらない）
            const screenshotPath = path.join(__dirname, `screenshot_${Date.now()}.png`);
            if (await safeScreenshot(page, screenshotPath)) {
              await sendCwFile(roomId, screenshotPath, `[info]スクリーンショット[/info]`);
              if (fs.existsSync(screenshotPath)) fs.unlinkSync(screenshotPath);
            }

            // 2. マーカーを付ける
            await btn.evaluate(e => e.setAttribute('data-bot-processed', 'true'));

            // 3. クリックしてダウンロード発火
            await btn.click({ timeout: 2000 }).catch(e => console.log('ボタンクリックエラー', e.message));
          }
        }
      } catch (e) {
        console.log('ボタン検索・クリック中エラー:', e.message);
      }

      // 終了判定：URLがホームに戻ったか（英語UIの場合は /en に戻る）だけで判定する
      try {
        const isUrlChanged = await page.evaluate(() => {
          const path = window.location.pathname;
          return path === '/' || path === '/ja' || path === '/en';
        });

        if (isUrlChanged) {
          console.log('URLがホームに戻った（みんなが抜けた）ことを検知しました。終了します。');
          isFinished = true;
          break;
        }
      } catch (e) {}

      await page.waitForTimeout(1000);
    }

    await sendCwMessage(roomId, `[info][title]完了[/title]アルバム処理を終了し、Botは退室しました。（合計 ${sentGifsHashes.size}件取得）[/info]`);

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

      // Bot自身の通知メッセージへの反応を防ぐ
      if (messageText.includes('[info][title]')) return;
      if (messageText.includes('[エラー]')) return;
      if (messageText.includes('[警告]')) return;
      if (messageText.includes('監視中のBotの画面はこちらです')) return;

      if (processedMessageIds.has(String(messageId))) return;
      processedMessageIds.add(String(messageId));
      if (processedMessageIds.size > MAX_CACHE_SIZE) {
        processedMessageIds.delete(processedMessageIds.values().next().value);
      }

      // 1. URL登録処理 (必ず/ja/に変換して概要へ)
      const match = messageText.match(GARTIC_URL_REGEX);
      if (match) {
        currentGarticUrl = match[0].replace(/\/(ja|en)\//, '/ja/');
        await updateRoomDescription(roomId, currentGarticUrl);
      }

      // 2. 「開示」コマンド実行
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
