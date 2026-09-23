// 產生 Google 試算表要貼上的內容：node tests/gen-sheet.js
// 輸出 sheet/帳號.tsv、sheet/玩家設定.tsv、sheet/玩家策略.tsv、sheet/Code.gs
const fs = require('fs');
const path = require('path');
const KS = require(path.join(__dirname, '..', 'ks-core.js'));
require(path.join(__dirname, '..', 'ks-blackjack.js'));
require(path.join(__dirname, '..', 'ks-auth.js'));

const out = path.join(__dirname, '..', 'sheet');
fs.mkdirSync(out, { recursive: true });
const t = KS.auth.template(KS.BJ);
const tsv = rows => rows.map(r => r.map(c => String(c)).join('\t')).join('\r\n') + '\r\n';
fs.writeFileSync(path.join(out, '帳號.tsv'), tsv(t.accounts), 'utf8');
fs.writeFileSync(path.join(out, '玩家設定.tsv'), tsv(t.settings), 'utf8');
fs.writeFileSync(path.join(out, '玩家策略.tsv'), tsv(t.strategies), 'utf8');

const gs = `/**
 * KS 牌桌模擬器 — Google Apps Script 後端
 * 安裝：
 *  1. 開啟試算表 → 擴充功能 → Apps Script → 刪掉原本內容，貼上本檔全部 → 儲存
 *  2. 上方函式選「setupSheets」→ 執行（第一次會要求授權）。會建立「帳號／玩家設定／玩家策略」三個工作表並填入預設內容
 *     （工作表已存在且有資料時不會覆蓋）
 *  3. 部署 → 新增部署作業 → 類型「網頁應用程式」→ 執行身分「我」、存取權「所有人」→ 部署
 *  4. 複製「網頁應用程式網址」（…/exec），貼到網站的 ks-config.js 的 apiUrl
 *  之後修改試算表內容不需要重新部署；修改本程式碼才需要「管理部署作業 → 編輯 → 新版本」。
 */
const SHEETS = ${JSON.stringify({ accounts: KS.auth.SHEETS.accounts.name, settings: KS.auth.SHEETS.settings.name, strategies: KS.auth.SHEETS.strategies.name })};
const TOKEN_SECONDS = 21600; // 登入憑證有效 6 小時（Apps Script 快取上限）

function doGet() {
  return json_({ ok: true, msg: 'KS API 運作中' });
}

function doPost(e) {
  let req = {};
  try { req = JSON.parse(e.postData.contents || '{}'); } catch (err) { return json_({ ok: false, error: '請求格式錯誤' }); }
  try { return json_(handle_(req)); } catch (err) { return json_({ ok: false, error: String(err) }); }
}

function handle_(req) {
  const cache = CacheService.getScriptCache();
  if (req.action === 'login') {
    const id = String(req.id || '').trim();
    if (!id || id === '*') return { ok: false, error: 'ID 或密碼錯誤' };
    const acc = rows_(SHEETS.accounts).find(r => String(r['ID']).trim() === id);
    if (!acc || String(acc['密碼']) !== String(req.pw || '')) {
      Utilities.sleep(800); // 減緩暴力猜密碼
      return { ok: false, error: 'ID 或密碼錯誤' };
    }
    const token = Utilities.getUuid();
    cache.put('t_' + token, id, TOKEN_SECONDS);
    return { ok: true, id: id, name: acc['名稱'] || id, token: token, data: data_(id) };
  }
  if (req.action === 'data') {
    const id = cache.get('t_' + String(req.token || ''));
    if (!id) return { ok: false, expired: true, error: '登入已過期，請重新登入' };
    return { ok: true, id: id, data: data_(id) };
  }
  return { ok: false, error: '未知的 action' };
}

// 只回傳「自己」與「*（預設）」的列，其他玩家的策略不會外流
function data_(id) {
  const mine = r => { const x = String(r['ID']).trim(); return x === id || x === '*'; };
  return {
    settings: rows_(SHEETS.settings).filter(mine),
    strategies: rows_(SHEETS.strategies).filter(mine)
  };
}

function rows_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) return [];
  const v = sh.getDataRange().getDisplayValues();
  if (v.length < 2) return [];
  const head = v.shift().map(h => String(h).trim());
  return v.filter(r => r.some(c => String(c).trim() !== '')).map(r => {
    const o = {};
    head.forEach((h, i) => { if (h) o[h] = String(r[i]).trim(); });
    return o;
  });
}

function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

/** 建立三個工作表並填入預設內容（已有資料的工作表不會覆蓋） */
function setupSheets() {
  const ss = SpreadsheetApp.getActive();
  const DATA = ${JSON.stringify({ [KS.auth.SHEETS.accounts.name]: t.accounts, [KS.auth.SHEETS.settings.name]: t.settings, [KS.auth.SHEETS.strategies.name]: t.strategies })};
  Object.keys(DATA).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() > 1) { Logger.log(name + ' 已有資料，略過'); return; }
    const rows = DATA[name];
    const w = Math.max.apply(null, rows.map(r => r.length));
    const vals = rows.map(r => { const x = r.slice(); while (x.length < w) x.push(''); return x; });
    sh.clear();
    sh.getRange(1, 1, vals.length, w).setNumberFormat('@').setValues(vals); // 全部當文字，避免 8,8 被轉成數字
    sh.getRange(1, 1, 1, w).setFontWeight('bold').setBackground('#dbe7fb');
    sh.setFrozenRows(1);
    sh.autoResizeColumns(1, w);
  });
  Logger.log('完成');
}
`;
fs.writeFileSync(path.join(out, 'Code.gs'), gs, 'utf8');
console.log(`帳號 ${t.accounts.length - 1} 列、玩家設定 ${t.settings.length - 1} 列、玩家策略 ${t.strategies.length - 1} 列 → ${out}`);
