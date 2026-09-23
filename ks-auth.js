/* ==========================================================================
   ks-auth.js — Google 試算表登入與玩家策略
   試算表（由 Apps Script 網頁應用程式提供 API，程式碼見 sheet/Code.gs）：
     帳號     ：ID | 密碼 | 名稱
     玩家設定 ：ID | 遊戲 | 算牌系統 | 牌況分段 | 智慧加注序列
     玩家策略 ：ID | 遊戲 | 牌況 | 類型 | 玩家牌 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | A
   ID 填 * 代表「所有玩家的預設」，玩家自己的列會覆蓋預設列。
   ========================================================================== */
(function (root) {
  'use strict';
  const KS = root.KS || (typeof require !== 'undefined' ? require('./ks-core.js') : null);
  const SESSION_KEY = 'ks_session';
  const SESSION_HOURS = 12;

  const SHEETS = {
    accounts: { name: '帳號', head: ['ID', '密碼', '名稱'] },
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
   * 由試算表資料建立某遊戲的策略與設定
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
    if (game === 'sangong') return setting ? res : null;
    // 合併：預設(*)先，玩家自己的列覆蓋同一格
    const merged = new Map();
    (data.strategies || []).filter(forGame).filter(r => any(r) || mine(r)).sort((a, b) => (any(a) ? 0 : 1) - (any(b) ? 0 : 1)).forEach(r => {
      merged.set(`${String(r['牌況'] || '基本').trim() || '基本'}|${r['類型']}|${r['玩家牌']}`, r);
    });
    const rows = Array.from(merged.values());
    res.rowCount = rows.length;
    if (!rows.length && !setting) return null;
    const segOf = r => String(r['牌況'] || '').trim() || '基本';
    const base = BJ.cells.materialize(BJ.ksDefaultStrategy(game));
    base.name = '試算表策略';
    delete base.builtin;
    rows.filter(r => segOf(r) === '基本').forEach(r => { res.errors.push(...applyRow(BJ, base, r)); });
    const known = new Set(['基本', ...res.segments.map(s => s.name)]);
    // 玩家自己的列用到未定義的牌況才警告；預設(*)列若玩家沒有該分段就直接略過
    rows.forEach(r => { if (mine(r) && !known.has(segOf(r))) res.errors.push(`牌況「${segOf(r)}」沒有在玩家設定的牌況分段中定義（該列被忽略）`); });
    if (res.segments.length) {
      res.strategy = {
        segmented: true, name: '試算表策略', base,
        segments: res.segments.map(sg => {
          const st = BJ.cloneStrategy(base);
          st.name = `試算表策略［${sg.name}］`;
          rows.filter(r => segOf(r) === sg.name).forEach(r => { res.errors.push(...applyRow(BJ, st, r)); });
          return Object.assign({}, sg, { strat: st });
        })
      };
    } else res.strategy = base;
    return res;
  }

  /* ---------------- 網頁端：登入 / session ---------------- */
  const cfg = () => (root.KS_CONFIG || {});
  const auth = {
    SHEETS, DEALER_COLS, GAME_NAMES, gameKey, systemKey, parseSegments, segText, parseSeq, buildForGame, applyRow,
    enabled() { return !!cfg().apiUrl; },
    session() {
      try {
        const s = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
        if (!s || Date.now() - s.at > SESSION_HOURS * 3600e3) return null;
        return s;
      } catch (e) { return null; }
    },
    save(s) { try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); } catch (e) { /* 忽略 */ } },
    logout() { try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ } },
    async post(body) {
      const r = await fetch(cfg().apiUrl, { method: 'POST', body: JSON.stringify(body) }); // text/plain，不觸發 CORS 預檢
      if (!r.ok) throw new Error('連線失敗（HTTP ' + r.status + '）');
      return r.json();
    },
    async login(id, pw) {
      const res = await this.post({ action: 'login', id: String(id).trim(), pw: String(pw) });
      if (!res.ok) throw new Error(res.error || '登入失敗');
      const s = { id: res.id, name: res.name || res.id, token: res.token, at: Date.now(), data: res.data };
      this.save(s);
      return s;
    },
    async refresh() {
      const s = this.session();
      if (!s) throw new Error('尚未登入');
      const res = await this.post({ action: 'data', token: s.token });
      if (!res.ok) { if (res.expired) this.logout(); throw new Error(res.error || '讀取失敗'); }
      s.data = res.data; s.loadedAt = Date.now();
      this.save(s);
      return s;
    },
    requireLogin() {
      if (!this.enabled() || this.session()) return true;
      const page = location.pathname.split('/').pop() || '';
      location.replace('index.html?next=' + encodeURIComponent(page));
      return false;
    },
    forGame(game) {
      const s = this.session();
      if (!s || !KS.BJ && game !== 'sangong') return null;
      return buildForGame(KS.BJ, s.data, s.id, game);
    },
    // 遊戲頁上方列：回首頁、玩家、重新載入、登出
    topBar(mount, game) {
      const ui = KS.ui, h = ui.h;
      const s = this.session();
      const info = this.enabled()
        ? (s ? `👤 ${ui.esc(s.name)}（${ui.esc(s.id)}）` : '未登入')
        : '本機模式（未設定試算表）';
      const bar = h('div', { class: 'topbar' },
        h('a', { href: 'index.html', text: '← 選擇遊戲' }),
        h('span', { html: info }));
      if (this.enabled() && s) {
        const r = this.forGame(game);
        if (r) bar.appendChild(h('span', { class: 'muted', text: `試算表：${r.rowCount} 列策略${r.segments.length ? '、' + r.segments.length + ' 段牌況' : ''}` }));
        if (r && r.errors.length) bar.appendChild(h('button', { class: 'btn-small', text: `⚠️ ${r.errors.length} 個試算表問題`, onclick: () => ui.modal('試算表內容問題', '<ul>' + r.errors.map(e => `<li>${ui.esc(e)}</li>`).join('') + '</ul>') }));
        bar.appendChild(h('button', { class: 'btn-small', text: '🔄 重新載入試算表', onclick: async ev => {
          ev.target.disabled = true; ev.target.textContent = '載入中…';
          try { await this.refresh(); location.reload(); } catch (e) { alert(e.message); if (!this.session()) location.href = 'index.html'; ev.target.disabled = false; }
        } }));
        bar.appendChild(h('button', { class: 'btn-small', text: '登出', onclick: () => { this.logout(); location.href = 'index.html'; } }));
      }
      mount.appendChild(bar);
    }
  };

  /* ---------------- 試算表範本（產生要貼上的內容） ---------------- */
  auth.template = function (BJ) {
    const accounts = [SHEETS.accounts.head, ['player01', '1234', '範例玩家'], ['player02', '5678', '玩家二']];
    const settings = [SHEETS.settings.head,
      ['*', '美式21', 'Hi-Lo', '小牌多:~-2, 正常:-1~1, 大牌多:2~3, 大牌很多:4~', '300,500,800,1200,1800,2700,4000,6000'],
      ['*', '英式21', 'Hi-Lo', '小牌多:~-2, 正常:-1~1, 大牌多:2~3, 大牌很多:4~', '300,500,800,1200,1800,2700,4000,6000'],
      ['*', '22點', 'Hi-Lo', '小牌多:~-2, 正常:-1~1, 大牌多:2~3, 大牌很多:4~', '300,500,800,1200,1800,2700,4000,6000'],
      ['*', '三公', '', '', '500,700,900,1400,2000,2900,5000'],
      ['player01', '22點', 'Hi-Lo', '小牌多:~-1, 正常:0~2, 大牌多:3~', '500,1000,1500,2000']];
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
    ['american', 'british', 'star22'].forEach(g => {
      const s = C.materialize(BJ.ksDefaultStrategy(g));
      table('*', GAME_NAMES[g], '基本', s, g === 'british', BJ.PRESETS[g].evenMoney);
    });
    // 分段覆蓋範例：只要寫與「基本」不同的格子
    strategies.push(['*', '22點', '大牌多', '硬牌', '16', '', '', '', '', '', '', '', '', 'S', '']);
    strategies.push(['*', '22點', '大牌很多', '硬牌', '16', '', '', '', '', '', '', '', 'S', 'S', 'S']);
    strategies.push(['*', '22點', '大牌很多', '硬牌', '12', '', 'S', '', '', '', '', '', '', '', '']);
    strategies.push(['*', '22點', '大牌很多', '保險', 'BJ', '', '', '', '', '', '', '', '', 'Y', 'Y']);
    strategies.push(['*', '22點', '小牌多', '硬牌', '15', 'H', 'H', '', '', '', '', '', '', '', '']);
    strategies.push(['*', '美式21', '大牌多', '保險', 'BJ', '', '', '', '', '', '', '', '', '', 'Y']);
    strategies.push(['*', '美式21', '大牌很多', '保險', 'BJ', '', '', '', '', '', '', '', '', 'Y', 'Y']);
    strategies.push(['*', '美式21', '大牌很多', '硬牌', '16', '', '', '', '', '', '', '', 'S', 'S', '']);
    // 個人覆蓋範例
    strategies.push(['player01', '22點', '基本', '硬牌', '12', 'S', 'S', '', '', '', '', '', '', '', '']);
    strategies.push(['player01', '22點', '大牌多', '保險', 'BJ', '', '', '', '', '', '', '', '', 'Y', 'Y']);
    return { accounts, settings, strategies };
  };

  KS.auth = auth;
  if (typeof module !== 'undefined' && module.exports) module.exports = KS;
})(typeof window !== 'undefined' ? window : globalThis);
