/* ==========================================================================
   ks-auth.js — 資料庫登入與玩家策略
   資料庫（由 Apps Script 網頁應用程式提供 API，程式碼見 sheet/Code.gs）：
     帳號     ：ID | 密碼（SHA-512 加密）| 名稱 | 狀態（啟用/停用/待審核）| 權限（管理者）| 必須改密碼
     登入裝置 ：金鑰雜湊 | ID | 裝置 | 登入時間 | 最後使用（刪掉一列 = 踢掉那台裝置）
     我的策略 ：ID | 遊戲 | 策略編號 | 策略名稱 | 策略內容 | 更新時間（網站自動寫入）
     練習成績 ：ID | 遊戲 | 類型 | 時間 | 題數 | 答對 | 正確率 | 明細（網站自動寫入）
     玩家設定 ：ID | 遊戲 | 算牌系統 | 牌況分段 | 智慧加注序列
     玩家策略 ：ID | 遊戲 | 牌況 | 類型 | 玩家牌 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | A
   玩家設定的 ID 填 * 代表「所有玩家的預設」；玩家策略只讀本人 ID 的列（新玩家從空白開始）。
   ========================================================================== */
(function (root) {
  'use strict';
  const KS = root.KS || (typeof require !== 'undefined' ? require('./ks-core.js') : null);

  const SHEETS = {
    accounts: { name: '帳號', head: ['ID', '密碼', '名稱', '狀態', '權限', '必須改密碼'] },
    devices: { name: '登入裝置', head: ['金鑰雜湊', 'ID', '裝置', '登入時間', '最後使用'] },
    saved: { name: '我的策略', head: ['ID', '遊戲', '策略編號', '策略名稱', '策略內容', '更新時間'] },
    scores: { name: '練習成績', head: ['ID', '遊戲', '類型', '時間', '題數', '答對', '正確率', '明細'] },
    settings: { name: '玩家設定', head: ['ID', '遊戲', '算牌系統', '牌況分段', '智慧加注序列'] },
    strategies: { name: '玩家策略', head: ['ID', '遊戲', '牌況', '類型', '玩家牌', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'] }
  };
  const DEALER_COLS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'A'];
  const colToDealer = c => (c === 'A' ? 11 : +c);
  const GAME_NAMES = { american: '美式21', british: '英式21', star22: '22點', sangong: '三公' };
  function gameKey(s) {
    const x = String(s || '').trim().toLowerCase().replace(/\s/g, '');
    if (!x) return null;
    if (x.includes('美') || x.startsWith('american')) return 'american';
    if (x.includes('英') || x.startsWith('british')) return 'british';
    if (x.includes('22') || x.includes('麗星') || x.startsWith('star')) return 'star22';
    if (x.includes('三公') || x.startsWith('sangong') || x === 'jqk') return 'sangong';
    return null;
  }
  function systemKey(s) {
    const x = String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const map = { hilo: 'hilo', ko: 'ko', hiopti: 'hiopt1', hiopt1: 'hiopt1', hioptii: 'hiopt2', hiopt2: 'hiopt2', omegaii: 'omega2', omega2: 'omega2', zen: 'zen', zencount: 'zen', wonghalves: 'halves', halves: 'halves' };
    return map[x] || null;
  }
  // "小牌多:~-2, 正常:-1~1, 大牌多:2~3, 大牌很多:4~"
  function parseSegments(str) {
    const out = [];
    String(str || '').split(/[,，;；\n]+/).forEach(part => {
      const m = part.trim().match(/^(.+?)\s*[:：]\s*(-?\d+)?\s*(?:[~～至]\s*(-?\d+)?)?$/);
      if (!m) return;
      const name = m[1].trim();
      const hasRange = /[~～至]/.test(part);
      const lo = m[2] != null ? +m[2] : -Infinity;
      const hi = hasRange ? (m[3] != null ? +m[3] : Infinity) : (m[2] != null ? +m[2] : Infinity);
      if (name) out.push({ name, lo, hi });
    });
    return out;
  }
  const segText = s => `${s.lo === -Infinity ? '' : s.lo}~${s.hi === Infinity ? '' : s.hi}`;
  function parseSeq(str) { return String(str || '').split(/[,，\s]+/).map(x => parseInt(x, 10)).filter(x => x > 0); }

  function handKey(type, raw) {
    const s = String(raw || '').toUpperCase().replace(/\s/g, '');
    const nums = (s.match(/\d+/g) || []).map(Number);
    if (type === 'pair') {
      if (s.startsWith('A')) return 11;
      return nums.length ? (nums[0] >= 2 && nums[0] <= 10 ? nums[0] : null) : (/^[JQK]/.test(s) ? 10 : null);
    }
    if (type === 'soft') {
      if (s.includes('A')) { const n = nums[0]; return n >= 2 && n <= 10 ? 11 + n : null; }
      return nums[0] >= 13 && nums[0] <= 21 ? nums[0] : null;
    }
    return nums[0] >= 2 && nums[0] <= 21 ? nums[0] : null;
  }
  const TYPE_MAP = { '硬牌': 'hard', '硬': 'hard', '軟牌': 'soft', '軟': 'soft', '對子': 'pair', '加倍後投降': 'da', '保險': 'even', '先收1倍': 'even', '保險(先收1倍)': 'even' };
  const typeKey = t => TYPE_MAP[String(t || '').trim()] || null;

  // 套用一列策略；回傳錯誤訊息陣列
  function applyRow(BJ, strat, r) {
    const errs = [];
    const type = typeKey(r['類型']);
    if (!type) return [`類型「${r['類型']}」無法辨識`];
    const C = BJ.cells;
    const key = type === 'even' ? null : handKey(type, r['玩家牌']);
    if (type !== 'even' && key == null) return [`玩家牌「${r['玩家牌']}」無法辨識`];
    DEALER_COLS.forEach(col => {
      const raw = r[col];
      if (raw == null || String(raw).trim() === '') return;
      const code = C.normCode(type, raw);
      const d = colToDealer(col);
      if (code == null) { errs.push(`${r['類型']} ${r['玩家牌']} vs ${col}：代碼「${raw}」無法辨識`); return; }
      if (type === 'hard') C.setHard(strat, key, d, code);
      else if (type === 'soft') C.setSoft(strat, key, d, code);
      else if (type === 'pair') C.setPair(strat, key, d, code);
      else if (type === 'da') C.setDA(strat, key, d, code);
      else if (type === 'even') C.setEven(strat, d, code);
    });
    return errs;
  }

  /**
   * 由資料庫資料建立某遊戲的策略與設定
   * @returns {{strategy, countSystem, segments, seq, errors, rowCount}|null}
   */
  function buildForGame(BJ, data, myId, game) {
    if (!data) return null;
    const mine = r => String(r.ID).trim() === String(myId).trim();
    const any = r => String(r.ID).trim() === '*';
    const forGame = r => gameKey(r['遊戲']) === game;
    const setRows = (data.settings || []).filter(forGame);
    const setting = setRows.find(mine) || setRows.find(any) || null;
    const res = { strategy: null, countSystem: null, segments: [], seq: [], errors: [], rowCount: 0 };
    if (setting) {
      res.countSystem = systemKey(setting['算牌系統']);
      if (setting['算牌系統'] && !res.countSystem) res.errors.push(`算牌系統「${setting['算牌系統']}」無法辨識，改用 Hi-Lo`);
      res.segments = parseSegments(setting['牌況分段']);
      res.seq = parseSeq(setting['智慧加注序列']);
    }
    if (res.segments.length) res.combo = { kind: 'combo', name: '📄 資料庫牌況分段', method: 'tc', rules: res.segments.map(g => ({ name: g.name, lo: g.lo === -Infinity ? '' : g.lo, hi: g.hi === Infinity ? '' : g.hi })) };
    if (game === 'sangong') return setting ? res : null;
    // 只用本人的列（* 預設列不套用）；依資料庫順序套用，同一格寫兩次以後面的為準（空白格不覆蓋）
    const rows = (data.strategies || []).filter(forGame).filter(mine);
    res.rowCount = rows.length;
    if (!rows.length) return setting ? res : null; // 資料庫沒有這位玩家的策略
    const segOf = r => String(r['牌況'] || '').trim() || '基本';
    const base = BJ.cells.materialize(BJ.blankStrategy('資料庫策略'));
    rows.filter(r => segOf(r) === '基本').forEach(r => { res.errors.push(...applyRow(BJ, base, r)); });
    // 其他牌況的列＝這套策略的「牌況版本」（只改有寫的格子）；牌況分段變成內建的算牌方式
    base.variants = {};
    rows.filter(r => segOf(r) !== '基本').forEach(r => {
      const name = segOf(r);
      const v = base.variants[name] || (base.variants[name] = BJ.blankVariant());
      res.errors.push(...applyRow(BJ, v, r));
    });
    res.strategy = base;
    res.missing = BJ.missingCells(res.strategy);
    return res;
  }

  /* ---------------- 網頁端：登入金鑰（cookie）／資料庫驗證 ----------------
     1. 登入成功 → Google 端產生隨機金鑰，存在 cookie（ks_key）
     2. 每次進入遊戲頁 → 帶金鑰到資料庫核對「登入裝置」工作表；被刪除的裝置會被踢回登入頁
     3. 同一次呼叫取回該遊戲的設定、玩家策略與「我的策略」（只有自己的） */
  const COOKIE = 'ks_key';
  const COOKIE_DAYS = 400; // 瀏覽器允許的最長期限；每次進站都會自動延長，等同永久
  const cfg = () => (root.KS_CONFIG || {});
  const API_VERSION = 5; // 需要的 Google 端程式版本（sheet/Code.gs 的 API_VERSION）
  const PW_PREFIX = 'ks-v1|'; // 與 Code.gs 相同
  const MIN_PW = 6;
  // 密碼在瀏覽器先做 SHA-512，網路上不傳明碼（資料庫端會再加鹽雜湊一次）
  async function hashPw(pw) {
    if (!(root.crypto && root.crypto.subtle)) throw new Error('瀏覽器不支援加密，請用 https 網址開啟網站');
    const buf = await root.crypto.subtle.digest('SHA-512', new TextEncoder().encode(PW_PREFIX + String(pw)));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  const ADMIN_RE = /^(管理者|管理員|admin|administrator|是|y|yes|true|1)$/i;
  const auth = {
    SHEETS, DEALER_COLS, GAME_NAMES, gameKey, systemKey, parseSegments, segText, parseSeq, buildForGame, applyRow,
    MIN_PW, hashPw,
    user: null,   // { id, name }
    data: null,   // 目前遊戲的資料庫資料
    enabled() { return !!cfg().apiUrl; },
    loggedIn() { return !!(this.enabled() && this.user); },
    // 管理者：帳號表「權限」填「管理者」；本機模式（沒有資料庫）視為管理者
    isAdmin() { return !this.enabled() || !!(this.user && ADMIN_RE.test(String(this.user.role || '').trim())); },
    apiVersion: null,
    outdated() { return this.enabled() && this.apiVersion !== null && this.apiVersion < API_VERSION; },
    getKey() {
      try {
        const m = document.cookie.match(new RegExp('(?:^|;\\s*)' + COOKIE + '=([^;]+)'));
        return m ? decodeURIComponent(m[1]) : null;
      } catch (e) { return null; }
    },
    setKey(k) {
      const secure = location.protocol === 'https:' ? '; Secure' : '';
      document.cookie = `${COOKIE}=${encodeURIComponent(k)}; max-age=${COOKIE_DAYS * 86400}; path=/; SameSite=Lax${secure}`;
    },
    clearKey() { document.cookie = `${COOKIE}=; max-age=0; path=/; SameSite=Lax`; },
    device() {
      const ua = navigator.userAgent || '';
      const os = /Windows/.test(ua) ? 'Windows' : /iPhone|iPad/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /Mac OS/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : '其他';
      const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '瀏覽器';
      return `${os} / ${br} / ${screen.width}x${screen.height}`;
    },
    async post(body) {
      let r;
      try { r = await fetch(cfg().apiUrl, { method: 'POST', body: JSON.stringify(body) }); } // text/plain，不觸發 CORS 預檢
      catch (e) { throw new Error('無法連線到資料庫，請檢查網路'); }
      if (!r.ok) throw new Error('連線失敗（HTTP ' + r.status + '）');
      const j = await r.json();
      this.apiVersion = j && j.v != null ? +j.v : 0;
      return j;
    },
    async login(id, pw) {
      const res = await this.post({ action: 'login', id: String(id).trim(), pwh: await hashPw(pw), device: this.device() });
      if (!res.ok) { const e = new Error(res.error || '登入失敗'); e.pending = !!res.pending; throw e; }
      this.setKey(res.key);
      this.user = { id: res.id, name: res.name || res.id, role: res.role || '', mustChange: !!res.mustChange };
      return this.user;
    },
    // 新增帳號：送出後為「待審核」，要等管理員開通
    async register(id, name, pw) {
      const res = await this.post({ action: 'register', id: String(id).trim(), name: String(name || '').trim(), pwh: await hashPw(pw) });
      if (!res.ok) throw new Error(res.error === '未知的動作' ? '資料庫程式不是最新版，請管理者重新部署' : (res.error || '申請失敗'));
      return res.message;
    },
    // 忘記密碼：一般玩家重設成 123456（登入後必須改密碼）
    async forgot(id) {
      const res = await this.post({ action: 'forgot', id: String(id).trim() });
      if (!res.ok) throw new Error(res.error === '未知的動作' ? '資料庫程式不是最新版，請管理者重新部署' : (res.error || '重設失敗'));
      return res.message;
    },
    // 只驗證登入（首頁用）；被踢除時清掉 cookie
    async check() {
      const key = this.getKey();
      if (!key) return null;
      const res = await this.post({ action: 'check', key });
      if (!res.ok) {
        if (res.kicked) this.clearKey();
        const e = new Error(res.error || '驗證失敗');
        e.kicked = !!res.kicked;
        throw e;
      }
      this.setKey(key); // 延長 cookie 期限
      this.user = { id: res.id, name: res.name || res.id, role: res.role || '', mustChange: !!res.mustChange };
      return this.user;
    },
    // 帳號設定：目前密碼必填；newId 改了會連動所有資料
    async updateAccount(pw, changes) {
      const body = { action: 'updateAccount', key: this.getKey(), pwh: await hashPw(pw) };
      if (changes.newName != null) body.newName = changes.newName;
      if (changes.newId != null) body.newId = changes.newId;
      if (changes.newPw) body.newPwh = await hashPw(changes.newPw);
      const res = await this.post(body);
      if (!res.ok) {
        if (res.kicked) { this.clearKey(); this.toLogin(res.error); }
        if (res.error === '未知的動作') throw new Error('資料庫程式不是最新版，請管理者重新部署後再試');
        throw new Error(res.error || '修改失敗');
      }
      this.user = Object.assign({}, this.user, { id: res.id, name: res.name || res.id, mustChange: changes.newPw ? false : this.user.mustChange });
      return res;
    },
    roleText() { return this.isAdmin() && this.enabled() ? '・管理者' : ''; },
    async logout() {
      const key = this.getKey();
      this.clearKey();
      this.user = null;
      if (key && this.enabled()) { try { await this.post({ action: 'logout', key }); } catch (e) { /* 離線也算登出 */ } }
    },
    toLogin(msg) {
      const page = location.pathname.split('/').pop() || '';
      location.replace('index.html?next=' + encodeURIComponent(page) + (msg ? '&msg=' + encodeURIComponent(msg) : ''));
    },
    /**
     * 遊戲頁啟動：驗證登入並取回該遊戲的資料庫資料，成功後呼叫 cb
     * 本機模式（沒有 apiUrl）直接執行 cb
     */
    async start(game, cb) {
      if (!this.enabled()) { cb(); return; }
      const key = this.getKey();
      if (!key) { this.toLogin(); return; }
      const ui = KS.ui;
      const msg = ui.h('div', { text: '正在向資料庫驗證登入…' });
      const box = ui.h('div', { class: 'ks-modal-box', style: { maxWidth: '380px', padding: '22px', textAlign: 'center' } }, msg);
      const overlay = ui.h('div', { class: 'ks-modal' }, box);
      document.body.appendChild(overlay);
      for (;;) {
        try {
          const res = await this.post({ action: 'game', key, game });
          if (!res.ok) {
            if (res.kicked) { this.clearKey(); this.toLogin(res.error || '請重新登入'); return; }
            if (res.mustChange) { this.toLogin(res.error); return; }
            throw new Error(res.error || '驗證失敗');
          }
          this.setKey(key);
          this.game = game;
          this.user = { id: res.id, name: res.name || res.id, role: res.role || '' };
          this.data = res.data || {};
          overlay.remove();
          cb();
          return;
        } catch (e) {
          msg.textContent = e.message;
          await new Promise(resolve => {
            const btn = ui.h('button', { text: '重試', style: { marginTop: '12px' }, onclick: () => { btn.remove(); msg.textContent = '正在向資料庫驗證登入…'; resolve(); } });
            box.appendChild(btn);
          });
        }
      }
    },
    forGame(game) {
      if (!this.loggedIn() || (!KS.BJ && game !== 'sangong')) return null;
      return buildForGame(KS.BJ, this.data, this.user.id, game);
    },
    // 「我的策略」：存在資料庫、跟著登入者（Google 端只回傳自己的）
    savedStrategies() {
      return ((this.data && this.data.saved) || []).map(r => {
        try { return { sid: r.sid, name: r.name, obj: JSON.parse(r.data) }; } catch (e) { return null; }
      }).filter(Boolean);
    },
    async saveStrategy(game, sid, name, obj) {
      const res = await this.post({ action: 'saveStrategy', key: this.getKey(), game, sid, name, data: JSON.stringify(obj) });
      if (!res.ok) { if (res.kicked) { this.clearKey(); this.toLogin(res.error); } throw new Error(res.error || '儲存失敗'); }
      return res.sid;
    },
    async deleteStrategy(game, sid) {
      const res = await this.post({ action: 'deleteStrategy', key: this.getKey(), game, sid });
      if (!res.ok) { if (res.kicked) { this.clearKey(); this.toLogin(res.error); } throw new Error(res.error || '刪除失敗'); }
    },
    // 練習成績：登入時存資料庫，本機模式存這台電腦
    async saveScore(game, kind, rec) {
      if (!this.loggedIn()) {
        const k = 'ks_scores_' + game;
        const list = KS.store.get(k, []);
        list.push(Object.assign({ kind, time: new Date().toLocaleString() }, rec));
        KS.store.set(k, list.slice(-200));
        return;
      }
      const res = await this.post(Object.assign({ action: 'saveScore', key: this.getKey(), game, kind }, rec));
      if (!res.ok) { if (res.kicked) { this.clearKey(); this.toLogin(res.error); } throw new Error(res.error || '儲存失敗'); }
    },
    async listScores(game, kind) {
      if (!this.loggedIn()) return KS.store.get('ks_scores_' + game, []).filter(r => r.kind === kind).reverse();
      const res = await this.post({ action: 'scores', key: this.getKey(), game, kind });
      if (!res.ok) { if (res.kicked) { this.clearKey(); this.toLogin(res.error); } throw new Error(res.error || '讀取失敗'); }
      return res.scores || [];
    },
    // 不重開頁面，重新讀取資料庫（策略、設定、我的策略）
    onBeforeReload: null, // 遊戲頁註冊：先把還沒送出的策略存完
    onReload: null,       // 遊戲頁註冊：套用新資料
    onBeforeLeave: null,  // 遊戲頁註冊：離開前確認（例如策略未儲存）；回傳 false 取消離開
    async reload() {
      if (!this.loggedIn() || !this.game) return;
      if (this.onBeforeReload) await this.onBeforeReload();
      const res = await this.post({ action: 'game', key: this.getKey(), game: this.game });
      if (!res.ok) { if (res.kicked) { this.clearKey(); this.toLogin(res.error); } throw new Error(res.error || '讀取失敗'); }
      this.user = { id: res.id, name: res.name || res.id, role: res.role || '' };
      this.data = res.data || {};
      if (this.onReload) this.onReload();
      if (this._bar) { const old = this._bar; this.topBar(null, this.game, old); }
    },
    // 儲存狀態顯示（上方列）
    status(text, bad) {
      const el = typeof document !== 'undefined' && document.querySelector('.topbar .save-status');
      if (!el) return;
      el.textContent = text;
      el.style.color = bad ? 'var(--bad)' : 'var(--muted)';
    },
    // 遊戲頁上方列：回首頁、玩家、重新載入、登出
    topBar(mount, game, replace) {
      const ui = KS.ui, h = ui.h;
      const info = this.enabled()
        ? (this.user ? `👤 ${ui.esc(this.user.name)}（${ui.esc(this.user.id)}${this.roleText()}）` : '未登入')
        : '本機模式（未設定資料庫，策略只存在這台電腦）';
      const bar = h('div', { class: 'topbar' },
        h('a', { href: 'index.html', text: '← 選擇遊戲', onclick: async ev => {
          if (!this.onBeforeLeave) return;
          ev.preventDefault();
          if (await this.onBeforeLeave()) location.href = 'index.html';
        } }),
        h('span', { html: info }));
      if (this.loggedIn()) {
        const r = this.forGame(game);
        if (game !== 'sangong') {
          const ok = r && r.strategy;
          bar.appendChild(h('span', { class: ok ? 'ok-text' : 'muted', text: ok ? `✔ 載入玩家 ${this.user.id} 策略成功${r.missing ? `（還有 ${r.missing} 格未填）` : ''}` : `資料庫中還沒有玩家 ${this.user.id} 的策略` }));
        }
        if (r && r.errors.length) bar.appendChild(h('button', { class: 'btn-small', text: `⚠️ ${r.errors.length} 個資料庫問題`, onclick: () => ui.modal('資料庫內容問題', '<ul>' + r.errors.map(e => `<li>${ui.esc(e)}</li>`).join('') + '</ul>') }));
        if (this.outdated()) bar.appendChild(h('span', { class: 'alert', style: { margin: 0, padding: '2px 8px' }, text: '⚠️ 資料庫程式不是最新版，請管理者重新部署（管理者權限等功能需要新版）' }));
        bar.appendChild(h('span', { class: 'save-status muted' }));
        bar.appendChild(h('button', { class: 'btn-small', text: '🔄 重新讀取資料庫', title: '不重開頁面，取得資料庫最新的策略與設定（目前牌局與結果會保留）', onclick: async ev => {
          ev.target.disabled = true;
          this.status('重新讀取中…');
          try { await this.reload(); this.status('✔ 已取得資料庫最新內容 ' + new Date().toLocaleTimeString()); }
          catch (e) { this.status('⚠️ ' + e.message, true); ev.target.disabled = false; }
        } }));
        bar.appendChild(h('a', { href: 'index.html#account', text: '⚙️ 帳號設定', onclick: async ev => {
          if (!this.onBeforeLeave) return;
          ev.preventDefault();
          if (await this.onBeforeLeave()) location.href = 'index.html#account';
        } }));
        bar.appendChild(h('button', { class: 'btn-small', text: '登出', onclick: async ev => {
          if (this.onBeforeLeave && !(await this.onBeforeLeave())) return;
          ev.target.disabled = true; await this.logout(); location.href = 'index.html';
        } }));
      }
      if (replace && replace.parentNode) replace.parentNode.replaceChild(bar, replace);
      else mount.appendChild(bar);
      this._bar = bar;
    }
  };

  /* ---------------- 資料庫範本（產生要貼上的內容） ---------------- */
  auth.template = function (BJ) {
    const accounts = [SHEETS.accounts.head, ['admin', '請改密碼', '管理者', '啟用', '管理者', ''], ['player01', '1234', '範例玩家', '啟用', '', ''], ['player02', '5678', '玩家二', '啟用', '', '']];
    const settings = [SHEETS.settings.head,
      ['*', '美式21', 'Hi-Lo', '小牌多:~-2, 正常:-1~1, 大牌多:2~3, 大牌很多:4~', '300,500,800,1200,1800,2700,4000,6000'],
      ['*', '英式21', 'Hi-Lo', '小牌多:~-2, 正常:-1~1, 大牌多:2~3, 大牌很多:4~', '300,500,800,1200,1800,2700,4000,6000'],
      ['*', '22點', 'Hi-Lo', '小牌多:~-2, 正常:-1~1, 大牌多:2~3, 大牌很多:4~', '300,500,800,1200,1800,2700,4000,6000'],
      ['*', '三公', '', '', '500,700,900,1400,2000,2900,5000']];
    const strategies = [SHEETS.strategies.head];
    const C = BJ.cells;
    const dealer = DEALER_COLS.map(colToDealer);
    const table = (id, gameName, seg, s, withDA, withEven) => {
      for (let pv = 11; pv >= 2; pv--) strategies.push([id, gameName, seg, '對子', pv === 11 ? 'A' : String(pv), ...dealer.map(d => C.pairCode(s, pv, d))]);
      for (let t = 21; t >= 4; t--) strategies.push([id, gameName, seg, '硬牌', String(t), ...dealer.map(d => C.hardCode(s, t, d).replace('Dh', 'D').replace('Rh', 'R'))]);
      for (let t = 21; t >= 13; t--) strategies.push([id, gameName, seg, '軟牌', `A${t - 11}`, ...dealer.map(d => C.softCode(s, t, d).replace('Dh', 'D'))]);
      if (withDA) for (let t = 20; t >= 4; t--) strategies.push([id, gameName, seg, '加倍後投降', String(t), ...dealer.map(d => C.daCode(s, t, d))]);
      if (withEven) strategies.push([id, gameName, seg, '保險', 'BJ', '', '', '', '', '', '', '', '', 'N', 'N']);
    };
    // 範例：player01 已填好的策略（player02 沒有列 = 新玩家，登入後是空白策略）
    ['american', 'british', 'star22'].forEach(g => {
      const s = C.materialize(BJ.ksDefaultStrategy(g));
      table('player01', GAME_NAMES[g], '基本', s, g === 'british', BJ.PRESETS[g].evenMoney);
    });
    // 牌況覆蓋範例：只要寫與「基本」不同的格子（牌況名稱要和玩家設定的牌況分段一致）
    strategies.push(['player01', '22點', '大牌多', '硬牌', '16', '', '', '', '', '', '', '', '', 'S', '']);
    strategies.push(['player01', '22點', '大牌很多', '硬牌', '16', '', '', '', '', '', '', '', 'S', 'S', 'S']);
    strategies.push(['player01', '22點', '大牌很多', '硬牌', '12', '', 'S', '', '', '', '', '', '', '', '']);
    strategies.push(['player01', '22點', '大牌很多', '保險', 'BJ', '', '', '', '', '', '', '', '', 'Y', 'Y']);
    strategies.push(['player01', '22點', '小牌多', '硬牌', '15', 'H', 'H', '', '', '', '', '', '', '', '']);
    strategies.push(['player01', '美式21', '大牌多', '保險', 'BJ', '', '', '', '', '', '', '', '', '', 'Y']);
    strategies.push(['player01', '美式21', '大牌很多', '保險', 'BJ', '', '', '', '', '', '', '', '', 'Y', 'Y']);
    strategies.push(['player01', '美式21', '大牌很多', '硬牌', '16', '', '', '', '', '', '', '', 'S', 'S', '']);
    return { accounts, settings, strategies };
  };

  KS.auth = auth;
  if (typeof module !== 'undefined' && module.exports) module.exports = KS;
})(typeof window !== 'undefined' ? window : globalThis);
