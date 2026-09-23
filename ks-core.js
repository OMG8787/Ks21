/* ==========================================================================
   ks-core.js — KS 模擬器共用核心
   - Shoe：可自訂每個點數張數的牌靴（切牌卡 / 每局洗牌）
   - 算牌系統：Hi-Lo、KO、Hi-Opt I/II、Omega II、Zen、Wong Halves、自訂
   - 統計工具：平均、標準差、95% 信賴區間、連勝/連輸追蹤
   - UI 工具：modal、牌組編輯器、分段執行器（不卡畫面、可停止）
   ========================================================================== */
(function (root) {
  'use strict';
  const KS = root.KS || (root.KS = {});

  /* ---------------- 牌與點數 ---------------- */
  const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const SUITS = ['♠', '♥', '♦', '♣'];
  const TEN_RANKS = ['10', 'J', 'Q', 'K'];

  const rankOf = c => (typeof c === 'string' ? c : c.r);
  // 21 點點數（A=11）
  function bjValue(c) {
    const r = rankOf(c);
    if (r === 'A') return 11;
    if (r === '10' || r === 'J' || r === 'Q' || r === 'K') return 10;
    return +r;
  }
  // 10 格索引：A=0, 2..9=1..8, 10/J/Q/K=9（用於機率計算）
  function idx10(c) {
    const v = bjValue(c);
    return v === 11 ? 0 : v === 10 ? 9 : v - 1;
  }
  const IDX10_LABEL = ['A', '2', '3', '4', '5', '6', '7', '8', '9', 'T'];
  const cardText = c => (typeof c === 'string' ? c : c.r + c.s);

  function standardCounts(decks, perRank) {
    const o = {};
    RANKS.forEach(r => { o[r] = (perRank && perRank[r] != null ? perRank[r] : 4) * decks; });
    return o;
  }

  /* ---------------- 亂數（可設種子，方便重播） ---------------- */
  let rand = Math.random;
  KS.setSeed = function (seed) {
    if (seed === null || seed === undefined || seed === '') { rand = Math.random; return; }
    let a = (+seed) >>> 0;
    rand = function () { // mulberry32
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  KS.random = () => rand();

  function shuffleArray(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      const t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* ---------------- Shoe ---------------- */
  class Shoe {
    /**
     * @param {object} o
     *  counts: {A: n, '2': n, ..., K: n} 整個牌靴的張數
     *  penetration: 0~1，發到這個比例後於局間洗牌
     *  withSuits: true 時牌為 {r, s} 物件（三公需要花色）
     */
    constructor(o) {
      this.counts = Object.assign({}, o.counts);
      this.penetration = o.penetration == null ? 0.75 : o.penetration;
      this.withSuits = !!o.withSuits;
      this.onDraw = null;     // 每發一張牌的回呼（算牌用）
      this.onShuffle = null;
      this.total = RANKS.reduce((s, r) => s + (this.counts[r] || 0), 0);
      if (this.total <= 0) throw new Error('牌組是空的，請至少設定一張牌');
      this.shuffle();
    }
    _buildCards(counts) {
      const cards = [];
      RANKS.forEach(r => {
        const n = counts[r] || 0;
        for (let i = 0; i < n; i++) cards.push(this.withSuits ? { r, s: SUITS[i % 4] } : r);
      });
      return cards;
    }
    shuffle() {
      this.cards = shuffleArray(this._buildCards(this.counts));
      this.rem = Object.assign({}, this.counts);
      RANKS.forEach(r => { if (this.rem[r] == null) this.rem[r] = 0; });
      this.dealt = 0;
      this.roundCards = [];
      this.shuffles = (this.shuffles || 0) + 1;
      if (this.onShuffle) this.onShuffle();
    }
    // 牌發完時：用「完整牌組 − 桌上的牌」補一副新的，避免同一張牌重複出現
    _refillMidRound() {
      const c = Object.assign({}, this.counts);
      this.roundCards.forEach(x => { c[rankOf(x)]--; });
      RANKS.forEach(r => { if (c[r] < 0) c[r] = 0; });
      this.cards = shuffleArray(this._buildCards(c));
      this.rem = c;
      this.dealt = this.total - this.cards.length;
      this.shuffles++;
      if (this.onShuffle) this.onShuffle(true);
    }
    draw() {
      if (this.cards.length === 0) this._refillMidRound();
      if (this.cards.length === 0) throw new Error('牌組張數不足');
      const c = this.cards.pop();
      this.rem[rankOf(c)]--;
      this.dealt++;
      this.roundCards.push(c);
      if (this.onDraw) this.onDraw(c);
      return c;
    }
    // 從牌靴中抽出指定點數（固定起手牌用）；牌靴沒有這張牌時回傳 null
    take(rank) {
      for (let i = this.cards.length - 1; i >= 0; i--) {
        if (rankOf(this.cards[i]) === rank) {
          const c = this.cards.splice(i, 1)[0];
          this.rem[rank]--;
          this.dealt++;
          this.roundCards.push(c);
          if (this.onDraw) this.onDraw(c);
          return c;
        }
      }
      return null;
    }
    endRound() { this.roundCards = []; }
    needsShuffle() { return this.dealt >= this.total * this.penetration; }
    size() { return this.cards.length; }
    decksRemaining() { return this.cards.length / 52; }
    remaining() { return Object.assign({}, this.rem); }
    // 10 格剩餘張數陣列（A,2..9,T）
    remaining10() {
      const a = new Array(10).fill(0);
      RANKS.forEach(r => { a[idx10(r)] += this.rem[r] || 0; });
      return a;
    }
    // 大牌(10/J/Q/K/A)、小牌(2-6)、中性(7-9)
    bigSmall() {
      let big = 0, small = 0, mid = 0;
      RANKS.forEach(r => {
        const n = this.rem[r] || 0, v = bjValue(r);
        if (v >= 10) big += n; else if (v <= 6) small += n; else mid += n;
      });
      return { big, small, mid, total: big + small + mid };
    }
  }

  /* ---------------- 算牌系統 ---------------- */
  // tags 依 10 格索引：A,2,3,4,5,6,7,8,9,T
  const COUNT_SYSTEMS = {
    hilo: { name: 'Hi-Lo', tags: [-1, 1, 1, 1, 1, 1, 0, 0, 0, -1], balanced: true },
    ko: { name: 'KO（非平衡）', tags: [-1, 1, 1, 1, 1, 1, 1, 0, 0, -1], balanced: false, irc: d => 4 - 4 * d },
    hiopt1: { name: 'Hi-Opt I', tags: [0, 0, 1, 1, 1, 1, 0, 0, 0, -1], balanced: true },
    hiopt2: { name: 'Hi-Opt II', tags: [0, 1, 1, 2, 2, 1, 1, 0, 0, -2], balanced: true },
    omega2: { name: 'Omega II', tags: [0, 1, 1, 2, 2, 2, 1, 0, -1, -2], balanced: true },
    zen: { name: 'Zen Count', tags: [-1, 1, 1, 2, 2, 2, 1, 0, 0, -2], balanced: true },
    halves: { name: 'Wong Halves', tags: [-1, 0.5, 1, 1, 1.5, 1, 0.5, 0, -0.5, -1], balanced: true },
    custom: { name: '自訂', tags: [-1, 1, 1, 1, 1, 1, 0, 0, 0, -1], balanced: true }
  };

  class Counter {
    constructor(key, totalCards) {
      this.setSystem(key || 'hilo');
      this.reset(totalCards || 52);
    }
    setSystem(key) {
      this.key = COUNT_SYSTEMS[key] ? key : 'hilo';
      this.sys = COUNT_SYSTEMS[this.key];
    }
    reset(totalCards) {
      if (totalCards != null) this.totalCards = totalCards;
      const d = this.totalCards / 52;
      this.rc = this.sys.irc ? this.sys.irc(Math.round(d)) : 0;
      this.seen = 0;
    }
    see(c) { this.rc += this.sys.tags[idx10(c)]; this.seen++; }
    tag(c) { return this.sys.tags[idx10(c)]; }
    // True Count = RC / 剩餘副數（至少 0.25 副避免除以 0）
    trueCount(cardsRemaining) {
      const d = Math.max(cardsRemaining / 52, 0.25);
      return this.rc / d;
    }
    // 牌況值：平衡系統用 True Count，非平衡系統（KO）直接用 Running Count
    index(cardsRemaining) { return this.sys.balanced ? this.trueCount(cardsRemaining) : this.rc; }
  }

  /* ---------------- 統計工具 ---------------- */
  class Acc { // 累計平均/變異數
    constructor() { this.n = 0; this.sum = 0; this.sq = 0; }
    add(x) { this.n++; this.sum += x; this.sq += x * x; }
    mean() { return this.n ? this.sum / this.n : 0; }
    sd() {
      if (this.n < 2) return 0;
      const m = this.mean();
      return Math.sqrt(Math.max(0, (this.sq - this.n * m * m) / (this.n - 1)));
    }
    ci95() { const h = this.n ? 1.96 * this.sd() / Math.sqrt(this.n) : 0; return [this.mean() - h, this.mean() + h]; }
  }

  // 連勝/連輸追蹤：和局不中斷也不累加連續紀錄
  class StreakTracker {
    constructor(maxLen) {
      this.maxLen = maxLen || 10;
      this.cur = 0;          // >0 連勝中，<0 連輸中
      this.maxWin = 0; this.maxLose = 0;
      this.winAtLeast = new Array(this.maxLen + 1).fill(0);  // 連勝 >= k 的次數
      this.loseAtLeast = new Array(this.maxLen + 1).fill(0);
    }
    _close() {
      const c = this.cur;
      const arr = c > 0 ? this.winAtLeast : this.loseAtLeast;
      const n = Math.abs(c);
      for (let k = 2; k <= Math.min(n, this.maxLen); k++) arr[k]++;
    }
    push(result) { // 'W' | 'L' | 'P'
      if (result === 'P') return;
      if (result === 'W') {
        if (this.cur < 0) { this._close(); this.cur = 0; }
        this.cur++;
        if (this.cur > this.maxWin) this.maxWin = this.cur;
      } else {
        if (this.cur > 0) { this._close(); this.cur = 0; }
        this.cur--;
        if (-this.cur > this.maxLose) this.maxLose = -this.cur;
      }
    }
    finish() { if (this.cur !== 0) { this._close(); } this.finished = true; }
  }

  // 資金曲線與最大回撤
  class Bankroll {
    constructor() { this.net = 0; this.peak = 0; this.maxDD = 0; this.low = 0; }
    add(x) {
      this.net += x;
      if (this.net > this.peak) this.peak = this.net;
      if (this.net < this.low) this.low = this.net;
      const dd = this.peak - this.net;
      if (dd > this.maxDD) this.maxDD = dd;
    }
  }

  /* ---------------- 分段執行器（不卡 UI） ---------------- */
  function runChunked(total, step, opt) {
    opt = opt || {};
    const budgetMs = opt.budgetMs || 30;
    let i = 0;
    return new Promise((resolve, reject) => {
      function tick() {
        try {
          const t0 = Date.now();
          while (i < total && Date.now() - t0 < budgetMs) {
            if (opt.shouldStop && opt.shouldStop()) { resolve({ done: i, stopped: true }); return; }
            step(i); i++;
          }
          if (opt.onProgress) opt.onProgress(i, total);
          if (i >= total) resolve({ done: i, stopped: false });
          else setTimeout(tick, 0);
        } catch (e) { reject(e); }
      }
      tick();
    });
  }

  /* ---------------- localStorage（包 try/catch） ---------------- */
  const store = {
    get(k, def) { try { const v = localStorage.getItem(k); return v == null ? def : JSON.parse(v); } catch (e) { return def; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 忽略 */ } }
  };

  /* ---------------- UI 工具 ---------------- */
  const ui = {};
  ui.$ = id => document.getElementById(id);
  ui.esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  ui.h = function (tag, attrs, ...kids) {
    const el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(k => {
      const v = attrs[k];
      if (v == null || v === false) return;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k in el && typeof v !== 'string') el[k] = v;
      else el.setAttribute(k, v === true ? '' : v);
    });
    kids.flat().forEach(c => { if (c != null && c !== false) el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c))); });
    return el;
  };
  ui.num = (id, def) => { const el = ui.$(id); if (!el) return def; const v = parseFloat(el.value); return isNaN(v) ? def : v; };
  ui.int = (id, def) => { const el = ui.$(id); if (!el) return def; const v = parseInt(el.value, 10); return isNaN(v) ? def : v; };
  ui.fmt = (n, d) => (n == null || isNaN(n) ? '-' : Number(n).toLocaleString(undefined, { minimumFractionDigits: d == null ? 0 : d, maximumFractionDigits: d == null ? 0 : d }));
  ui.pct = (a, b, d) => (b ? (a / b * 100).toFixed(d == null ? 2 : d) + '%' : '-');
  ui.signed = (n, d) => (n > 0 ? '+' : '') + ui.fmt(n, d);
  ui.cardHtml = function (c, hidden) {
    if (hidden) return '<span class="card back">?</span>';
    const r = rankOf(c), s = typeof c === 'string' ? '' : c.s;
    const red = s === '♥' || s === '♦';
    return `<span class="card${red ? ' red' : ''}">${ui.esc(r)}${s ? '<small>' + s + '</small>' : ''}</span>`;
  };

  ui.modal = function (title, content) {
    const close = () => overlay.remove();
    const body = ui.h('div', { class: 'ks-modal-body' });
    if (typeof content === 'string') body.innerHTML = content; else if (content) body.appendChild(content);
    const overlay = ui.h('div', { class: 'ks-modal', onclick: e => { if (e.target === overlay) close(); } },
      ui.h('div', { class: 'ks-modal-box' },
        ui.h('div', { class: 'ks-modal-head' }, ui.h('strong', { text: title }), ui.h('button', { class: 'btn-ghost', text: '✕ 關閉', onclick: close })),
        body));
    document.body.appendChild(overlay);
    const onKey = e => { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); } };
    document.addEventListener('keydown', onKey);
    return { body, close };
  };

  // 分頁的長紀錄檢視器：rows 為 HTML 字串陣列
  ui.logViewer = function (title, rows, opt) {
    opt = opt || {};
    const pageSize = opt.pageSize || 50;
    let filter = '', page = 0;
    const list = ui.h('div', { class: 'log-list' });
    const info = ui.h('span', { class: 'muted' });
    const m = ui.modal(title, ui.h('div', null,
      ui.h('div', { class: 'row' },
        ui.h('input', { type: 'text', placeholder: '篩選關鍵字（例如：玩家1、分牌、BJ）', style: { flex: 1 }, oninput: e => { filter = e.target.value.trim(); page = 0; render(); } }),
        ui.h('button', { class: 'btn-ghost', text: '◀', onclick: () => { page = Math.max(0, page - 1); render(); } }),
        info,
        ui.h('button', { class: 'btn-ghost', text: '▶', onclick: () => { page++; render(); } })),
      list));
    function render() {
      const src = filter ? rows.filter(r => r.replace(/<[^>]+>/g, '').includes(filter)) : rows;
      const pages = Math.max(1, Math.ceil(src.length / pageSize));
      if (page >= pages) page = pages - 1;
      list.innerHTML = src.slice(page * pageSize, (page + 1) * pageSize).join('') || '<p class="muted">沒有紀錄</p>';
      info.textContent = ` 第 ${page + 1}/${pages} 頁（共 ${src.length} 筆） `;
    }
    render();
    return m;
  };

  /**
   * 牌組編輯器：每個點數張數可調
   * @param {HTMLElement} container
   * @param {object} opt { counts, decks, onChange(counts), presets: [{label, fn(decks)=>counts}] }
   */
  ui.compositionEditor = function (container, opt) {
    let counts = Object.assign({}, opt.counts);
    const inputs = {};
    const totalEl = ui.h('b');
    const grid = ui.h('div', { class: 'comp-grid' });
    RANKS.forEach(r => {
      const inp = ui.h('input', { type: 'number', min: 0, step: 1, value: counts[r] || 0,
        oninput: () => { counts[r] = Math.max(0, parseInt(inp.value, 10) || 0); emit(); } });
      inputs[r] = inp;
      grid.appendChild(ui.h('label', { class: 'comp-cell' }, ui.h('span', { text: r }), inp));
    });
    function emit() {
      totalEl.textContent = RANKS.reduce((s, r) => s + (counts[r] || 0), 0);
      if (opt.onChange) opt.onChange(Object.assign({}, counts));
    }
    function set(c) {
      counts = Object.assign({}, c);
      RANKS.forEach(r => { inputs[r].value = counts[r] || 0; });
      emit();
    }
    const decksInp = ui.h('input', { type: 'number', min: 1, max: 12, value: opt.decks || 1, style: { width: '70px' } });
    const presetBar = ui.h('div', { class: 'row' }, '副數 ', decksInp,
      (opt.presets || []).map(p => ui.h('button', { class: 'btn-small', text: p.label, onclick: () => set(p.fn(Math.max(1, parseInt(decksInp.value, 10) || 1))) })),
      ui.h('span', null, '　總張數：', totalEl));
    container.appendChild(presetBar);
    container.appendChild(grid);
    container.appendChild(ui.h('small', { class: 'muted', text: '每個欄位是「整個牌靴」中該點數的張數。可以只留下想練習的牌（例如只放 8 和 10 練 16 點），觀察勝率變化。' }));
    totalEl.textContent = RANKS.reduce((s, r) => s + (counts[r] || 0), 0);
    return { get: () => Object.assign({}, counts), set, decksInput: decksInp };
  };

  // 剩餘牌組面板（HTML）
  ui.remainingHtml = function (shoe, big) {
    const rem = shoe.remaining();
    const bs = shoe.bigSmall();
    const cells = RANKS.map(r => `<td class="${rem[r] === 0 ? 'zero' : ''}">${rem[r]}</td>`).join('');
    return `<table class="mini"><tr>${RANKS.map(r => `<th>${r}</th>`).join('')}</tr><tr>${cells}</tr></table>
      <div class="bs-bar">
        <span class="tag big">${big || '大牌(10/J/Q/K/A)'}：${bs.big}（${ui.pct(bs.big, bs.total, 1)}）</span>
        <span class="tag mid">中性(7-9)：${bs.mid}</span>
        <span class="tag small">小牌(2-6)：${bs.small}（${ui.pct(bs.small, bs.total, 1)}）</span>
        <span class="tag">剩 ${shoe.size()} 張 ≈ ${shoe.decksRemaining().toFixed(2)} 副</span>
      </div>`;
  };

  ui.tabs = function (container, tabs, onSwitch) {
    const bar = ui.h('div', { class: 'tabs' });
    const panes = {};
    tabs.forEach((t, i) => {
      const btn = ui.h('button', { class: 'tab' + (i === 0 ? ' active' : ''), text: t.label, onclick: () => show(t.key) });
      btn.dataset.key = t.key;
      bar.appendChild(btn);
      panes[t.key] = ui.h('div', { class: 'tab-pane', style: { display: i === 0 ? '' : 'none' } });
    });
    function show(key) {
      Array.from(bar.children).forEach(b => b.classList.toggle('active', b.dataset.key === key));
      Object.keys(panes).forEach(k => { panes[k].style.display = k === key ? '' : 'none'; });
      store.set('ks_tab_' + location.pathname, key);
      if (onSwitch) onSwitch(key);
    }
    container.appendChild(bar);
    Object.values(panes).forEach(p => container.appendChild(p));
    return { panes, show };
  };

  ui.download = function (filename, text) {
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  ui.readJsonFile = file => new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => { try { res(JSON.parse(fr.result)); } catch (e) { rej(new Error('JSON 格式錯誤：' + e.message)); } };
    fr.onerror = () => rej(fr.error);
    fr.readAsText(file);
  });

  // 路單：結果陣列 ['W','L','P',...]
  ui.roadHtml = function (results, max) {
    const arr = results.slice(0, max || 300);
    return '<div class="road">' + arr.map(r => `<i class="${r}">${r === 'W' ? '勝' : r === 'L' ? '負' : '和'}</i>`).join('') + '</div>';
  };

  ui.streakTableHtml = function (label, st) {
    let h = `<table><tr><th>${label}</th><th>最長連勝</th><th>最長連輸</th>`;
    for (let k = 2; k <= st.maxLen; k++) h += `<th>連${k}${k === st.maxLen ? '+' : ''}</th>`;
    h += '</tr><tr><td>連勝次數</td><td rowspan="2">' + st.maxWin + '</td><td rowspan="2">' + st.maxLose + '</td>';
    for (let k = 2; k <= st.maxLen; k++) h += `<td>${st.winAtLeast[k]}</td>`;
    h += '</tr><tr><td>連輸次數</td>';
    for (let k = 2; k <= st.maxLen; k++) h += `<td>${st.loseAtLeast[k]}</td>`;
    return h + '</tr></table>';
  };

  Object.assign(KS, {
    RANKS, SUITS, TEN_RANKS, IDX10_LABEL, rankOf, bjValue, idx10, cardText, standardCounts,
    shuffleArray, Shoe, COUNT_SYSTEMS, Counter, Acc, StreakTracker, Bankroll, runChunked, store, ui
  });

  if (typeof module !== 'undefined' && module.exports) module.exports = KS;
})(typeof window !== 'undefined' ? window : globalThis);
