/* ==========================================================================
   ks-blackjack-ui.js — 21 點頁面 UI（美式 / 英式 / 麗星郵輪22點 共用）
   分頁：模擬 / 逐牌遊戲 / 算牌練習 / 測驗 / 策略管理 / 規則與牌組
   ========================================================================== */
(function () {
  'use strict';
  const KS = window.KS, BJ = KS.BJ, ui = KS.ui, h = ui.h;
  const RES_LABEL = { W: '勝', L: '負', P: '和' };
  const OUT_LABEL = { '17': '17', '18': '18', '19': '19', '20': '20', '21': '21', BJ: 'BJ', '22': '22(平手)', bust: '爆牌' };
  const DEALER_LABEL = d => (d === 11 ? 'A' : String(d));

  function sel(opts, value, onchange) {
    const s = h('select', { onchange: onchange ? () => onchange(s.value) : null },
      opts.map(o => (Array.isArray(o) ? h('option', { value: o[0], text: o[1] }) : h('option', { value: o, text: o }))));
    s.value = value == null ? s.options[0] && s.options[0].value : value;
    return s;
  }
  const clsNum = n => (n > 1e-9 ? 'pos' : n < -1e-9 ? 'neg' : '');
  const evPct = x => (x * 100).toFixed(2) + '%';

  function init(opt) {
    const preset = opt.preset;
    const P = BJ.PRESETS[preset];
    const mount = typeof opt.mount === 'string' ? ui.$(opt.mount) : (opt.mount || document.body);
    const K = k => `ks_${preset}_${k}`;
    const store = KS.store;

    /* ============ 狀態 ============ */
    const defaultCounts = d => { const c = KS.standardCounts(d); if (P.defaultNo10) c['10'] = 0; return c; };
    const S = {
      rules: Object.assign({}, P, store.get(K('rules'), {})),
      decks: store.get(K('decks'), 5),
      counts: store.get(K('counts'), null),
      pen: store.get(K('pen'), 75),
      shuffleMode: store.get(K('shuffle_v2'), 'round'), // 預設：每局洗牌
      countSystem: store.get('ks_count_system', 'hilo'),
      boostSeq: store.get('ks_boost_sequence_v1', [300, 500, 800, 1200, 1800, 2700, 4000, 6000]),
      ramp: store.get(K('ramp'), '0:1,1:1,2:2,3:4,4:8,5:12'),
      user: []
    };
    if (!S.counts) S.counts = defaultCounts(S.decks);
    const customTags = store.get('ks_custom_tags', null);
    if (Array.isArray(customTags) && customTags.length === 10) KS.COUNT_SYSTEMS.custom.tags = customTags.map(Number);
    const ONLINE = !!(KS.auth && KS.auth.loggedIn());
    function loadSavedFromSheet() {
      const list = [];
      KS.auth.savedStrategies().forEach(x => {
        try { const st = BJ.normalizeStrategy(x.obj); st.name = x.name || st.name; list.push({ id: x.sid, s: st }); } catch (e) { /* 略過壞資料 */ }
      });
      return list;
    }
    if (ONLINE) {
      S.user = loadSavedFromSheet();
    } else {
      store.get(K('strats'), []).forEach(x => {
        try { S.user.push({ id: x.id || ('u' + Math.random().toString(36).slice(2)), s: BJ.normalizeStrategy(x) }); } catch (e) { /* 略過壞資料 */ }
      });
    }

    // 資料庫：玩家策略、算牌系統、牌況分段、智慧加注序列
    let sheetRes = null;
    function applySheet() {
      sheetRes = KS.auth ? KS.auth.forGame(preset) : null;
      S.sheet = sheetRes && sheetRes.strategy ? sheetRes : null;
      if (sheetRes) {
        if (sheetRes.countSystem) S.countSystem = sheetRes.countSystem;
        if (sheetRes.seq.length) S.boostSeq = sheetRes.seq.slice();
      }
    }
    applySheet();
    let penInput = null; // 切牌卡輸入框（勾選每局洗牌時停用）

    const saveRules = () => { const r = Object.assign({}, S.rules); delete r.name; store.set(K('rules'), r); updateHeader(); };
    /* ============ 我的策略：手動儲存 ============
       u = { id, s: 目前編輯中的策略, base: 上次儲存的內容（新策略為 null）, dirty: 是否有未儲存修改, from: 複製來源 } */
    const snap = st => JSON.parse(JSON.stringify(BJ.exportStrategy(st)));
    S.user.forEach(u => { u.base = snap(u.s); u.dirty = false; });
    let stratPane = null;
    const saveLocal = () => store.set(K('strats'), S.user.filter(u => u.base).map(u => Object.assign({}, u.base, { id: u.id })));
    const dirtyList = () => S.user.filter(u => u.dirty);
    function markDirty(id) {
      const u = S.user.find(x => x.id === id);
      if (!u) return;
      u.dirty = true;
      refreshStratSelects();
      if (stratPane) stratPane.updateDirty();
    }
    async function commit(u) {
      const obj = snap(u.s);
      if (ONLINE) {
        KS.auth.status('儲存中…');
        await KS.auth.saveStrategy(preset, u.id, u.s.name, obj);
        KS.auth.status('✔ 已儲存到資料庫 ' + new Date().toLocaleTimeString());
      }
      u.base = obj; u.dirty = false; u.from = null;
      if (!ONLINE) saveLocal();
      refreshStratSelects();
      if (stratPane) stratPane.updateDirty();
    }
    function discard(u) {
      if (!u.base) S.user = S.user.filter(x => x !== u);
      else { u.s = BJ.cells.materialize(BJ.normalizeStrategy(JSON.parse(JSON.stringify(u.base)))); u.dirty = false; }
      refreshStratSelects();
      if (stratPane) { stratPane.updateDirty(); stratPane.refresh(); }
    }
    async function removeUser(id) {
      const u = S.user.find(x => x.id === id);
      S.user = S.user.filter(x => x.id !== id);
      refreshStratSelects();
      if (!u || !u.base) return; // 從未儲存過的新策略，只要從畫面移除
      if (!ONLINE) { saveLocal(); return; }
      KS.auth.status('刪除中…');
      try { await KS.auth.deleteStrategy(preset, id); KS.auth.status('✔ 已從資料庫刪除'); }
      catch (e) { KS.auth.status('⚠️ ' + e.message, true); }
    }

    // 列出這次修改了哪些格子：「硬 16 對莊家 10：要牌（H）→ 停牌（S）」
    const CODE_TEXT = { H: '要牌', S: '停牌', Dh: '加倍，不能加倍就要牌', Ds: '加倍，不能加倍就停牌', Rh: '投降，不能投降就要牌', Rs: '投降，不能投降就停牌', P: '分牌', D: '加倍', R: '投降', '-': '不分牌（看點數表）', Y: '先收 1 倍', N: '等莊家', '?': '未填' };
    const SHORT = { Dh: 'D', Rh: 'R', '-': '·' };
    function codeText(kind, key, code) {
      if (code === '?') return '未填';
      let t = CODE_TEXT[code] || code;
      if (S.rules.freeDouble && code[0] === 'D') {
        const total = kind === 'pair' ? key * 2 : key;
        const free = (kind === 'hard' || (kind === 'pair' && key !== 11)) && total >= 9 && total <= 11;
        t = (free ? '免費' : '自費') + t;
      }
      return kind === 'even' ? t : `${t}（${SHORT[code] || code}）`;
    }
    function diffStrategy(u) {
      if (!u.base) return [`新策略「${u.s.name}」${u.from ? '（從「' + u.from + '」複製）' : ''}，還沒有儲存過`];
      const C = BJ.cells, old = BJ.normalizeStrategy(JSON.parse(JSON.stringify(u.base))), cur = u.s, out = [];
      if ((u.base.name || '') !== cur.name) out.push(`名稱：「${u.base.name}」→「${cur.name}」`);
      const cmp = (kind, key, label, get, cols) => (cols || BJ.DEALER_VALS).forEach(d => {
        const x = C.isFilled(old, kind, key, d) ? get(old, key, d) : '?', y = C.isFilled(cur, kind, key, d) ? get(cur, key, d) : '?';
        if (x !== y) out.push(`${label} 對莊家 ${DEALER_LABEL(d)}：${codeText(kind, key, x)} → ${codeText(kind, key, y)}`);
      });
      for (let pv = 11; pv >= 2; pv--) cmp('pair', pv, '對子 ' + (pv === 11 ? 'A,A' : pv + ',' + pv), C.pairCode);
      for (let t = 21; t >= 4; t--) cmp('hard', t, '硬 ' + t, C.hardCode);
      for (let t = 21; t >= 13; t--) cmp('soft', t, `軟 ${t}（A,${t - 11}）`, C.softCode);
      if (S.rules.surrenderAfterDouble) for (let t = 20; t >= 4; t--) cmp('da', t, '加倍後 ' + t, C.daCode);
      if (S.rules.evenMoney) cmp('even', 0, '玩家 BJ（保險）', (st, k, d) => C.evenCode(st, d), [10, 11]);
      return out;
    }
    // 提醒視窗：列出修改內容；回傳 'save' | 'discard' | 'cancel'
    function askChanges(u, opt) {
      return new Promise(resolve => {
        const list = diffStrategy(u);
        const shown = list.slice(0, 40);
        const done = v => { overlay.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
        const onKey = e => { if (e.key === 'Escape') done('cancel'); };
        const btns = h('div', { class: 'row', style: { justifyContent: 'flex-end', marginTop: '12px' } },
          h('button', { class: 'btn-good', text: opt.saveText || '💾 儲存', onclick: () => done('save') }),
          opt.allowDiscard ? h('button', { class: 'btn-danger', text: opt.discardText || '不儲存（放棄修改）', onclick: () => done('discard') }) : null,
          h('button', { class: 'btn-ghost', text: opt.cancelText || '取消', onclick: () => done('cancel') }));
        const overlay = h('div', { class: 'ks-modal', onclick: e => { if (e.target === overlay) done('cancel'); } },
          h('div', { class: 'ks-modal-box', style: { maxWidth: '640px' } },
            h('div', { class: 'ks-modal-head' }, h('strong', { text: opt.title })),
            h('div', { class: 'ks-modal-body' },
              opt.message ? h('p', { text: opt.message, style: { marginTop: 0 } }) : null,
              h('p', { html: `策略「<b>${ui.esc(u.s.name)}</b>」${u.base ? `共有 <b>${list.length}</b> 處修改：` : ''}` }),
              h('ul', { class: 'change-list' }, shown.map(t => h('li', { text: t }))),
              list.length > shown.length ? h('p', { class: 'muted', text: `…還有 ${list.length - shown.length} 處` }) : null,
              h('p', { class: 'muted', text: ONLINE ? '儲存後會寫入 資料庫的「我的策略」。' : '儲存後會存在這台電腦（本機模式）。' }),
              btns)));
        document.body.appendChild(overlay);
        document.addEventListener('keydown', onKey);
      });
    }
    // 有未儲存的修改時詢問；回傳 true 表示可以繼續
    async function resolveDirty(reason) {
      for (const u of dirtyList()) {
        const c = await askChanges(u, { title: '策略還沒有儲存', message: `你要${reason}，但以下修改還沒有儲存。要儲存嗎？`, allowDiscard: true, cancelText: '取消（留在這裡）' });
        if (c === 'cancel') return false;
        if (c === 'discard') { discard(u); continue; }
        try { await commit(u); }
        catch (e) { alert('儲存失敗：' + e.message); return false; }
      }
      return true;
    }
    window.addEventListener('beforeunload', e => { if (dirtyList().length) { e.preventDefault(); e.returnValue = ''; } });

    /* ============ 策略庫 ============ */
    let optCache = null, optKey = '';
    function optimal() {
      const key = JSON.stringify([S.rules, S.counts]);
      if (optKey !== key) { optCache = BJ.generateOptimalStrategy(S.rules, S.counts, '最佳基本策略（自動計算）'); optKey = key; }
      return optCache;
    }
    // 最佳基本策略只有管理者看得到（帳號表權限＝管理者；本機模式視為管理者）
    const canSeeOptimal = () => !KS.auth || KS.auth.isAdmin();
    const missText = n => (n ? `（還有 ${n} 格未填）` : '');
    function library() {
      const list = [];
      if (S.sheet) list.push({ id: 'sheet', name: `📄 資料庫策略（${KS.auth.user.name}${S.sheet.segments.length ? '，' + S.sheet.segments.length + ' 段牌況' : ''}）${missText(BJ.missingCells(S.sheet.strategy))}`, builtin: true, get: () => S.sheet.strategy });
      if (canSeeOptimal()) list.push({ id: 'opt', name: '最佳基本策略（管理者專用・依目前規則自動計算）', builtin: true, get: optimal });
      S.user.forEach(u => list.push({ id: u.id, name: u.s.name + missText(BJ.missingCells(u.s)) + (u.dirty ? '（● 未儲存）' : ''), builtin: false, get: () => u.s }));
      return list;
    }
    const libEntry = id => library().find(x => x.id === id) || library()[0] || null;
    const getStrat = id => { const e = libEntry(id); return e ? e.get() : null; };
    const defStrat = () => { const l = library(); return l.length ? l[0].id : ''; };
    // 策略能不能拿來模擬／建議／當標準答案：要存在且全部填完
    function unusable(id) {
      const e = libEntry(id);
      if (!e) return '還沒有策略，請先到「📋 策略管理」按「＋ 新增空白策略」並填完';
      const m = BJ.missingCells(e.get());
      return m ? `策略「${e.get().name}」還有 ${m} 格沒填，填完才能使用` : null;
    }
    const stratSelects = new Set();
    function stratSelect(value, onchange) {
      const s = h('select', { class: 'strat-select', onchange: () => onchange && onchange(s.value) });
      fillStrat(s, value);
      stratSelects.add(s);
      return s;
    }
    function fillStrat(s, value) {
      const v = value || s.value || defStrat();
      const lib = library();
      s.innerHTML = '';
      if (!lib.length) { s.appendChild(h('option', { value: '', text: '（尚無策略，請到「策略管理」新增）' })); s.value = ''; return; }
      lib.forEach(e => s.appendChild(h('option', { value: e.id, text: e.name })));
      s.value = lib.some(e => e.id === v) ? v : lib[0].id;
    }
    function refreshStratSelects() { stratSelects.forEach(s => fillStrat(s)); }

    /* ============ 版面 ============ */
    mount.innerHTML = '';
    if (KS.auth) KS.auth.topBar(mount, preset);
    const title = h('h1', { text: `🃏 ${P.name} 模擬器` });
    const header = h('div', { class: 'muted' });
    mount.appendChild(title);
    mount.appendChild(h('div', { class: 'panel' }, header));
    function updateHeader() {
      const R = S.rules;
      const tot = KS.RANKS.reduce((a, r) => a + (S.counts[r] || 0), 0);
      header.innerHTML = [
        `牌靴 ${tot} 張`, S.shuffleMode === 'round' ? '每局洗牌' : `發到 ${S.pen}% 洗牌`, R.dealerHitSoft17 ? '莊家軟17補牌' : '莊家軟17停牌',
        `BJ 賠 ${R.bjPayout}`, R.dealer22Push ? '莊22平手' : '', R.dealerBJOriginalOnly ? '莊BJ只輸原注' : '',
        R.freeDouble ? '9/10/11免費加倍' : '', R.freeSplit ? '分牌免費' : '', R.evenMoney ? '可先收1倍' : '', R.any21Wins ? '21點必勝' : '',
        R.bonus777 ? '777/678獎金' : '', `分牌最多 ${R.maxHands} 手`,
        { any2: '兩張可投降', first: '僅第一動作可投降', none: '不可投降' }[R.surrender],
        R.surrenderAfterDouble ? '加倍後可投降' : ''
      ].filter(Boolean).map(t => `<span class="tag">${t}</span>`).join('') +
        ' <small>（在「規則與牌組」分頁修改）</small>';
    }
    updateHeader();

    const tabs = ui.tabs(mount, [
      { key: 'sim', label: '📊 模擬' },
      { key: 'play', label: '🎮 逐牌遊戲' },
      { key: 'drill', label: '🧮 算牌練習' },
      { key: 'quiz', label: '❓ 測驗' },
      { key: 'strat', label: '📋 策略管理' },
      { key: 'rules', label: '⚙️ 規則與牌組' }
    ], key => { if (key === 'play') play.render(); },
    async from => (from === 'strat' && dirtyList().length ? resolveDirty('離開「策略管理」') : true));

    buildRulesPane(tabs.panes.rules);
    const simPane = buildSimPane(tabs.panes.sim);
    const play = buildPlayPane(tabs.panes.play);
    buildDrillPane(tabs.panes.drill);
    const quizPane = buildQuizPane(tabs.panes.quiz);
    stratPane = buildStratPane(tabs.panes.strat);
    if (KS.auth) KS.auth.onBeforeLeave = () => (dirtyList().length ? resolveDirty('離開這個頁面') : true);
    if (ONLINE) {
      KS.auth.onBeforeReload = async () => { if (!(await resolveDirty('重新讀取資料庫'))) throw new Error('已取消重新讀取'); };
      KS.auth.onReload = () => {
        applySheet();
        S.user = loadSavedFromSheet();
        S.user.forEach(u => { u.base = snap(u.s); u.dirty = false; });
        updateHeader();
        refreshStratSelects();
        simPane.setBoost(S.boostSeq);
        quizPane.renderQuizSeg();
        stratPane.refresh();
        play.render();
      };
    }
    const lastTab = store.get('ks_tab_' + location.pathname, null);
    if (lastTab && tabs.panes[lastTab]) tabs.show(lastTab);

    /* ================================================================ */
    /* ⚙️ 規則與牌組                                                     */
    /* ================================================================ */
    function buildRulesPane(pane) {
      const rulesBox = h('div', { class: 'panel' });
      function renderRules() {
        rulesBox.innerHTML = '';
        rulesBox.appendChild(h('h3', { text: '遊戲規則' }));
        const shufChk = h('input', { type: 'checkbox', checked: S.shuffleMode === 'round', onchange: () => {
          S.shuffleMode = shufChk.checked ? 'round' : 'shoe';
          store.set(K('shuffle_v2'), S.shuffleMode);
          if (penInput) penInput.disabled = shufChk.checked;
          updateHeader();
        } });
        rulesBox.appendChild(h('div', { class: 'row' }, h('label', null, shufChk, ' 每局結束後，將桌上的牌放回牌池重新洗牌（取消勾選 = 牌不放回，發到切牌卡才洗；要練算牌請取消勾選）')));
        BJ.RULE_FIELDS.forEach(([key, type, label]) => {
          let input;
          if (type === 'bool') input = h('input', { type: 'checkbox', checked: !!S.rules[key], onchange: () => { S.rules[key] = input.checked; saveRules(); } });
          else if (type === 'num') input = h('input', { type: 'number', step: key === 'maxHands' ? 1 : 0.1, value: S.rules[key], onchange: () => { S.rules[key] = parseFloat(input.value) || 0; saveRules(); } });
          else input = sel(type, S.rules[key], v => { S.rules[key] = v; saveRules(); });
          rulesBox.appendChild(h('div', { class: 'row' }, h('label', null, input, ' ' + label)));
        });
        rulesBox.appendChild(h('div', { class: 'row' },
          h('button', { class: 'btn-ghost', text: `還原「${P.name}」預設規則`, onclick: () => { S.rules = Object.assign({}, P); S.shuffleMode = 'round'; store.set(K('shuffle_v2'), 'round'); if (penInput) penInput.disabled = true; saveRules(); renderRules(); } })));
      }
      renderRules();
      pane.appendChild(rulesBox);

      const deckBox = h('div', { class: 'panel' }, h('h3', { text: '牌組（每個點數張數可自訂）' }));
      const zero = () => { const c = {}; KS.RANKS.forEach(r => { c[r] = 0; }); return c; };
      const ed = ui.compositionEditor(deckBox, {
        counts: S.counts, decks: S.decks,
        presets: [
          { label: '標準 52 張', fn: d => KS.standardCounts(d) },
          { label: '無 10（48 張）', fn: d => { const c = KS.standardCounts(d); c['10'] = 0; return c; } },
          { label: '只留大牌', fn: d => { const c = zero(); ['10', 'J', 'Q', 'K', 'A'].forEach(r => { c[r] = 4 * d; }); return c; } },
          { label: '只留小牌(2-6)', fn: d => { const c = zero(); ['2', '3', '4', '5', '6'].forEach(r => { c[r] = 4 * d; }); return c; } },
          { label: '清空', fn: () => zero() }
        ],
        onChange: c => { S.counts = c; store.set(K('counts'), c); updateHeader(); }
      });
      ed.decksInput.addEventListener('change', () => { S.decks = parseInt(ed.decksInput.value, 10) || 1; store.set(K('decks'), S.decks); });

      const pen = h('input', { type: 'number', min: 10, max: 100, value: S.pen, onchange: () => { S.pen = Math.min(100, Math.max(10, +pen.value || 75)); store.set(K('pen'), S.pen); } });
      pen.disabled = S.shuffleMode === 'round';
      penInput = pen;
      deckBox.appendChild(h('div', { class: 'row' }, '切牌卡位置（沒有勾選「每局洗牌」時，發到幾 % 洗牌）', pen, '%'));

      const sysSel = sel(Object.keys(KS.COUNT_SYSTEMS).map(k => [k, KS.COUNT_SYSTEMS[k].name]), S.countSystem, v => { S.countSystem = v; store.set('ks_count_system', v); renderTags(); });
      const tagBox = h('div', { class: 'row' });
      function renderTags() {
        tagBox.innerHTML = '';
        const sys = KS.COUNT_SYSTEMS[S.countSystem];
        KS.IDX10_LABEL.forEach((lab, i) => {
          const inp = h('input', { type: 'number', step: 0.5, value: sys.tags[i], style: { width: '64px' }, disabled: S.countSystem !== 'custom',
            onchange: () => { KS.COUNT_SYSTEMS.custom.tags[i] = parseFloat(inp.value) || 0; store.set('ks_custom_tags', KS.COUNT_SYSTEMS.custom.tags); } });
          tagBox.appendChild(h('label', null, lab === 'T' ? '10/J/Q/K' : lab, inp));
        });
      }
      renderTags();
      const seed = h('input', { type: 'text', placeholder: '空白 = 隨機', style: { width: '120px' }, onchange: () => KS.setSeed(seed.value.trim()) });
      pane.appendChild(deckBox);
      pane.appendChild(h('div', { class: 'panel' }, h('h3', { text: '算牌系統' }),
        h('div', { class: 'row' }, '系統', sysSel, S.sheet && sheetRes.countSystem ? h('b', { text: '（目前由資料庫指定）' }) : null, h('small', { class: 'muted', text: '選「自訂」即可編輯每張牌的權重。KO 為非平衡系統（直接看 RC）。' })),
        tagBox,
        h('div', { class: 'row' }, '亂數種子（填數字可重現同樣的牌序）', seed)));
    }

    /* ================================================================ */
    /* 📊 模擬                                                          */
    /* ================================================================ */
    function buildSimPane(pane) {
      const seatBox = h('div');
      const seats = [];
      const SEAT_KEY = K('seats') + (ONLINE ? '_' + KS.auth.user.id : '');
      const saved = store.get(SEAT_KEY, [{ bet: 500, mode: 'fixed', strat: defStrat() }]);
      const saveSeats = () => store.set(SEAT_KEY, seats.map(r => ({ bet: +r.bet.value, mode: r.mode.value, strat: r.strat.value })));
      function addSeat(pre) {
        if (seats.length >= 7) { alert('最多 7 位玩家'); return; }
        pre = pre || {};
        const r = {};
        r.bet = h('input', { type: 'number', min: 1, value: pre.bet || 500, onchange: saveSeats });
        r.mode = sel([['fixed', '固定下注'], ['boost', '智慧加注序列'], ['ramp', '依 True Count 加注']], pre.mode || 'fixed', saveSeats);
        r.strat = stratSelect(pre.strat || defStrat(), saveSeats);
        const ro = [['', '隨機']].concat(KS.RANKS.map(x => [x, x]));
        r.c1 = sel(ro, ''); r.c2 = sel(ro, '');
        r.label = h('b');
        r.row = h('div', { class: 'row' }, r.label, '下注', r.bet, r.mode, '策略', r.strat, '固定起手牌', r.c1, r.c2);
        seats.push(r);
        seatBox.appendChild(r.row);
        relabel(); saveSeats();
      }
      function relabel() { seats.forEach((r, i) => { r.label.textContent = `玩家${i + 1}`; }); }
      saved.forEach(addSeat);
      const dealerUp = sel([['', '隨機']].concat(KS.RANKS.map(x => [x, x])), '');

      const boostInp = h('input', { type: 'text', value: S.boostSeq.join(','), style: { width: '320px' } });
      const boostApply = () => {
        const arr = boostInp.value.split(/[,，\s]+/).map(x => parseInt(x, 10)).filter(x => x > 0);
        if (!arr.length) { alert('請輸入至少一個正整數，例如 300,500,800'); return; }
        S.boostSeq = arr; store.set('ks_boost_sequence_v1', arr); boostInp.value = arr.join(',');
      };
      boostInp.addEventListener('change', boostApply);
      const rampInp = h('input', { type: 'text', value: S.ramp, style: { width: '260px' }, onchange: () => { S.ramp = rampInp.value; store.set(K('ramp'), S.ramp); } });
      const rounds = h('input', { type: 'number', min: 1, value: store.get(K('rounds'), 100000), onchange: () => store.set(K('rounds'), +rounds.value) });
      const logLimit = h('input', { type: 'number', min: 0, max: 20000, value: 500 });
      const bar = h('div'); const prog = h('div', { class: 'progress' }, bar); const progText = h('span', { class: 'muted' });
      const runBtn = h('button', { text: '▶ 開始模擬', onclick: run });
      const stopBtn = h('button', { class: 'btn-danger', text: '■ 停止', disabled: true });
      let stop = false;
      stopBtn.onclick = () => { stop = true; };
      const out = h('div');

      pane.appendChild(h('div', { class: 'panel' },
        h('h3', { text: '玩家設定' }), seatBox,
        h('div', { class: 'row' },
          h('button', { class: 'btn-small', text: '＋ 新增玩家', onclick: () => addSeat() }),
          h('button', { class: 'btn-small', text: '－ 刪除最後一位', onclick: () => { if (seats.length <= 1) { alert('至少需要 1 位玩家'); return; } seats.pop().row.remove(); saveSeats(); } })),
        h('div', { class: 'row' }, '莊家明牌', dealerUp),
        h('div', { class: 'row' }, '智慧加注序列（贏往下一階、輸回第一階、和局不變）', boostInp,
          h('button', { class: 'btn-small', text: '還原預設', onclick: () => { boostInp.value = '300,500,800,1200,1800,2700,4000,6000'; boostApply(); } })),
        h('div', { class: 'row' }, 'True Count 加注表（TC:倍數）', rampInp, h('small', { class: 'muted', text: '例：2:2 表示 TC≥2 下 2 倍基本注' })),
        h('div', { class: 'row' }, '模擬局數', rounds, '　記錄前', logLimit, '局的過程'),
        h('div', { class: 'row' }, runBtn, stopBtn, prog, progText)));
      pane.appendChild(out);

      const api = { setBoost: seq => { boostInp.value = seq.join(','); } };
      async function run() {
        const n = Math.max(1, parseInt(rounds.value, 10) || 1);
        let cfg, sim;
        try {
          seats.forEach((r, i) => { const bad = unusable(r.strat.value); if (bad) throw new Error(`玩家${i + 1}：${bad}`); });
          runBtn.disabled = true; progText.textContent = '準備中（計算策略）…';
          await new Promise(r => setTimeout(r, 20));
          cfg = {
            rules: Object.assign({}, S.rules), counts: S.counts, penetration: S.pen / 100,
            shuffleEveryRound: S.shuffleMode === 'round', countSystem: S.countSystem,
            seats: seats.map(r => ({ bet: Math.max(1, +r.bet.value || 1), betMode: r.mode.value, strategy: getStrat(r.strat.value), stratName: libEntry(r.strat.value).name, fixed: [r.c1.value || null, r.c2.value || null] })),
            boostSeq: S.boostSeq.slice(), ramp: BJ.parseRamp(S.ramp), dealerUp: dealerUp.value || null,
            logLimit: Math.max(0, parseInt(logLimit.value, 10) || 0)
          };
          sim = new BJ.Simulator(cfg);
        } catch (e) { alert(e.message); runBtn.disabled = false; progText.textContent = ''; return; }
        stop = false; stopBtn.disabled = false;
        const t0 = Date.now();
        try {
          const res = await KS.runChunked(n, () => sim.step(), {
            shouldStop: () => stop,
            onProgress: (i, t) => { bar.style.width = (i / t * 100).toFixed(1) + '%'; progText.textContent = `${i.toLocaleString()} / ${t.toLocaleString()} 局`; }
          });
          sim.finish();
          progText.textContent = `${res.stopped ? '已停止，' : '完成，'}共 ${sim.round.toLocaleString()} 局，耗時 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`;
          renderSim(out, sim, cfg);
        } catch (e) {
          console.error(e);
          alert('模擬錯誤：' + e.message);
        } finally { runBtn.disabled = false; stopBtn.disabled = true; }
      }
      return api;
    }

    function renderSim(out, sim, cfg) {
      out.innerHTML = '';
      const warn = sim.warnings.size ? `<div class="alert">${Array.from(sim.warnings).map(ui.esc).join('<br>')}</div>` : '';
      let t = `<div class="panel">${warn}<h3>玩家統計（${sim.round.toLocaleString()} 局）</h3><div class="table-wrap"><table><tr>
        <th>玩家</th><th>策略</th><th>勝/和/負(局)</th><th>勝率(不含和)</th><th>手數</th><th>手 勝/和/負</th><th>BJ</th><th>爆牌</th><th>投降</th>
        <th>自費加倍(勝率)</th><th>免費加倍(勝率)</th><th>分牌手(勝率)</th><th>先收1倍</th><th>總下注</th><th>淨盈虧</th>
        <th>每局EV(原注)</th><th>95%信賴區間</th><th>標準差</th><th>淨/總下注</th><th>最大回撤</th></tr>`;
      sim.stats.forEach((s, i) => {
        const ci = s.acc.ci95();
        t += `<tr><td>玩家${i + 1}</td><td>${ui.esc(cfg.seats[i].stratName)}</td>
          <td>${s.rW}/${s.rP}/${s.rL}</td><td>${ui.pct(s.rW, s.rW + s.rL)}</td><td>${s.hands}</td><td>${s.hW}/${s.hP}/${s.hL}</td>
          <td>${ui.pct(s.bj, s.rounds)}</td><td>${ui.pct(s.bust, s.hands)}</td><td>${s.surrender}</td>
          <td>${s.dbl} (${ui.pct(s.dblW, s.dbl, 1)})</td><td>${s.dblFree} (${ui.pct(s.dblFreeW, s.dblFree, 1)})</td>
          <td>${s.splitHands} (${ui.pct(s.splitW, s.splitHands, 1)})</td><td>${s.even}</td>
          <td>${ui.fmt(s.wagered)}</td><td class="${clsNum(s.net)}">${ui.signed(s.net, 0)}</td>
          <td class="${clsNum(s.acc.mean())}">${evPct(s.acc.mean())}</td><td>${evPct(ci[0])} ~ ${evPct(ci[1])}</td>
          <td>${s.acc.sd().toFixed(3)}</td><td>${ui.pct(s.net, s.wagered, 3)}</td><td>${ui.fmt(s.bank.maxDD)}</td></tr>`;
      });
      t += '</table></div><small class="muted">每局EV = 每局淨盈虧 ÷ 基本注。信賴區間跨過 0 表示局數還不足以判斷正負。</small></div>';
      out.insertAdjacentHTML('beforeend', t);

      sim.stats.forEach((s, i) => {
        const tcRows = Object.keys(s.tc).map(Number).sort((a, b) => a - b).map(k => {
          const b = s.tc[k];
          return `<tr><td>${k <= -5 ? '≤-5' : k >= 6 ? '≥6' : (k > 0 ? '+' : '') + k}</td><td>${b.n}</td><td>${ui.pct(b.n, s.rounds, 1)}</td><td>${ui.pct(b.w, b.w + b.l)}</td><td class="${clsNum(b.units)}">${evPct(b.units / b.n)}</td></tr>`;
        }).join('');
        out.insertAdjacentHTML('beforeend', `<div class="panel"><details ${i === 0 ? 'open' : ''}><summary><b>玩家${i + 1} 詳細：連勝連輸、路單、True Count 分析</b></summary>
          <h4>連勝 / 連輸（和局不中斷）</h4><div class="table-wrap">${ui.streakTableHtml('玩家' + (i + 1), s.streak)}</div>
          <h4>路單（前 ${s.road.length} 局）</h4>${ui.roadHtml(s.road, 600)}
          <h4>依下注前牌況值（平衡系統為 True Count、KO 為 RC）（${KS.COUNT_SYSTEMS[cfg.countSystem].name}）</h4>
          <div class="table-wrap"><table><tr><th>牌況值</th><th>局數</th><th>比例</th><th>勝率(不含和)</th><th>平均每局EV</th></tr>${tcRows}</table></div>
          ${Object.keys(s.seg).length ? `<h4>依資料庫牌況分段</h4><div class="table-wrap"><table><tr><th>牌況</th><th>局數</th><th>比例</th><th>勝率(不含和)</th><th>平均每局EV</th></tr>${Object.keys(s.seg).map(k => { const b = s.seg[k]; return `<tr><td>${ui.esc(k)}</td><td>${b.n}</td><td>${ui.pct(b.n, s.rounds, 1)}</td><td>${ui.pct(b.w, b.w + b.l)}</td><td class="${clsNum(b.units)}">${evPct(b.units / b.n)}</td></tr>`; }).join('')}</table></div>` : ''}
          <small class="muted">資金最高 ${ui.fmt(s.bank.peak)}、最低 ${ui.fmt(s.bank.low)}、最大單注 ${ui.fmt(s.maxBet)}</small></details></div>`);
      });

      const D = sim.dealerStats;
      const dRow = BJ.OUTCOMES.filter(k => k !== '22' || cfg.rules.dealer22Push).map(k => `<td>${D[k] || 0}<br><small>${ui.pct(D[k] || 0, D.played)}</small></td>`).join('');
      out.insertAdjacentHTML('beforeend', `<div class="panel"><h3>莊家最終點數分佈（每局只打一手莊家牌）</h3>
        <div class="table-wrap"><table><tr>${BJ.OUTCOMES.filter(k => k !== '22' || cfg.rules.dealer22Push).map(k => `<th>${OUT_LABEL[k]}</th>`).join('')}<th>未補完（玩家已全部結束）</th></tr>
        <tr>${dRow}<td>${D.total - D.played}</td></tr></table></div></div>`);

      const btn = h('button', { class: 'btn-ghost', text: `🔍 查看模擬過程（前 ${sim.logs.length} 局）`, onclick: () => ui.logViewer('模擬過程', sim.logs.map(fmtLog)) });
      out.appendChild(h('div', { class: 'panel' }, btn));
    }

    function fmtLog(e) {
      const hands = e.seats.map((s, i) => `玩家${i + 1} 注${s.bet}：` + s.hands.map(x =>
        `[${x.cards.join(' ')}]=${x.total}${x.actions.length ? ' ' + x.actions.map(a => BJ.ACTION_LABEL[a] || a).join('→') : ''}${x.free ? '(免費)' : ''}${x.freeSplit ? '[免費手]' : ''} ` +
        `<span class="res-${x.result}" style="color:${x.result === 'W' ? '#1a8f4c' : x.result === 'L' ? '#c43c3c' : '#8a6d00'}">${RES_LABEL[x.result] || ''}${x.note ? '(' + ui.esc(x.note) + ')' : ''} ${ui.signed(x.profit, 0)}</span>`
      ).join('；') + `　<b>合計 ${ui.signed(s.net, 0)}</b>`).join('<br>');
      const dOut = e.dealerOutcome ? OUT_LABEL[e.dealerOutcome] || e.dealerOutcome : '未補完';
      return `<div class="log-row"><b>第${e.round}局</b>　下注時 TC ${e.tc.toFixed(1)}　局後 RC ${e.rc}　莊家 [${e.dealer.join(' ')}] ${dOut}<br>${hands}</div>`;
    }

    /* ================================================================ */
    /* 🎮 逐牌遊戲                                                       */
    /* ================================================================ */
    function buildPlayPane(pane) {
      let shoe, counter, rd = null, roundNo = 0, lastMsg = '';
      const hist = [];
      const sess = { rounds: 0, W: 0, L: 0, P: 0, net: 0, streak: new KS.StreakTracker(10), road: [], dev: 0, decisions: 0, act: {} };
      function newShoe(msg) {
        try { shoe = new KS.Shoe({ counts: S.counts, penetration: S.pen / 100 }); }
        catch (e) { alert(e.message); return false; }
        counter = new KS.Counter(S.countSystem, shoe.total);
        shoe.onDraw = c => counter.see(c);
        shoe.onShuffle = () => counter.reset(shoe.total);
        lastMsg = msg || '已建立新牌靴並洗牌';
        return true;
      }

      const seatsN = sel([1, 2, 3, 4, 5, 6, 7, 8].map(n => [String(n), n + ' 位']), '1'); // 最多 8 位
      const bet = h('input', { type: 'number', min: 1, value: 500 });
      const advStrat = stratSelect(defStrat(), () => render());
      const chk = (label, on) => { const c = h('input', { type: 'checkbox', checked: on, onchange: () => render() }); return [c, h('label', null, c, label)]; };
      const [cCount, lCount] = chk('顯示 RC/TC', true);
      const [cEV, lEV] = chk('顯示各動作 EV 與勝率', true);
      const [cAdv, lAdv] = chk('顯示策略建議', false);
      const [cWarn, lWarn] = chk('偏離策略時提醒', true);
      const dealBtn = h('button', { class: 'btn-good', text: '🂠 發牌 (Enter)', onclick: deal });
      const table = h('div', { class: 'felt' });
      const actions = h('div', { class: 'actions' });
      const msg = h('div');
      const info = h('div');
      const statsBox = h('div');

      pane.appendChild(h('div', { class: 'panel' },
        h('div', { class: 'row' }, '座位數', seatsN, '每手下注', bet, '策略建議依據', advStrat),
        h('div', { class: 'row' }, lCount, lEV, lAdv, lWarn,
          h('button', { class: 'btn-small', text: '重新洗牌', onclick: () => { if (rd && rd.phase === 'player') return; newShoe(); render(); } }),
          h('button', { class: 'btn-small', text: '重設統計', onclick: resetSess }),
          h('button', { class: 'btn-small', text: '🔍 查看遊戲過程', onclick: () => ui.logViewer('遊戲過程', hist.slice().reverse().map(fmtLog)) })),
        h('small', { class: 'muted', html: '快捷鍵：<span class="kbd">H</span>要牌 <span class="kbd">S</span>停牌 <span class="kbd">D</span>加倍 <span class="kbd">P</span>分牌 <span class="kbd">R</span>投降 <span class="kbd">E</span>先收1倍 <span class="kbd">W</span>等莊家 <span class="kbd">Enter</span>發牌' })));
      pane.appendChild(h('div', { class: 'grid2' },
        h('div', null, h('div', { class: 'panel' }, table, actions, msg), statsBox),
        h('div', null, info)));

      function resetSess() {
        Object.assign(sess, { rounds: 0, W: 0, L: 0, P: 0, net: 0, streak: new KS.StreakTracker(10), road: [], dev: 0, decisions: 0, act: {} });
        hist.length = 0; render();
      }

      function deal() {
        if (rd && rd.phase === 'player') return;
        if (!shoe && !newShoe()) return;
        if (S.shuffleMode === 'round') { shoe.shuffle(); lastMsg = '每局洗牌'; }
        else if (shoe.needsShuffle()) { shoe.shuffle(); lastMsg = '已到切牌卡，重新洗牌（計數歸零）'; }
        else lastMsg = '';
        const n = +seatsN.value, b = Math.max(1, +bet.value || 1);
        try {
          roundNo++;
          rd = new BJ.Round({ rules: S.rules, shoe }, Array.from({ length: n }, () => ({ bet: b })), {}).start();
          rd.tcAtBet = counter.index(shoe.size());
        } catch (e) { alert(e.message); return; }
        if (rd.phase === 'dealer') finish();
        render();
      }

      function doAct(a) {
        if (!rd || rd.phase !== 'player') return;
        const c = rd.current();
        const L = rd.legal(c.hand, c.seat);
        if (!L[a]) return;
        const noAdv = unusable(advStrat.value);
        const adv = noAdv ? a : BJ.decide(getStrat(advStrat.value), c.hand, rd.dealer[0], L, { tc: counter.index(shoe.size()) });
        sess.decisions++;
        if (noAdv) lastMsg = '';
        else if (adv !== a) {
          sess.dev++;
          c.hand.deviations = (c.hand.deviations || 0) + 1;
          lastMsg = cWarn.checked ? `<div class="alert">⚠️ 你選「${BJ.ACTION_LABEL[a]}」，策略建議「${BJ.ACTION_LABEL[adv]}」</div>` : '';
        } else lastMsg = cWarn.checked ? `<div class="okbox">✔ 與策略一致（${BJ.ACTION_LABEL[a]}）</div>` : '';
        try { rd.act(a); } catch (e) { alert(e.message); return; }
        if (rd.phase === 'dealer') finish();
        render();
      }

      function finish() {
        rd.playDealer();
        shoe.endRound();
        sess.rounds++;
        rd.seats.forEach(s => {
          sess.net += s.net;
          sess[s.result]++;
          sess.streak.push(s.result);
          sess.road.push(s.result);
          s.hands.forEach(x => {
            const a = x.actions[0] || (x.isBJ ? 'BJ' : 'stand');
            const st = sess.act[a] || (sess.act[a] = { n: 0, W: 0, L: 0, P: 0, net: 0 });
            st.n++; st[x.result]++; st.net += x.profit;
          });
        });
        hist.push({
          round: roundNo, tc: rd.tcAtBet || 0, rc: counter.rc, dealer: rd.dealer.map(KS.cardText), dealerTotal: BJ.handTotal(rd.dealer), dealerBJ: rd.dealerBJ, dealerOutcome: rd.dealerOutcome(),
          seats: rd.seats.map(s => ({ bet: s.bet, net: s.net, result: s.result, hands: s.hands.map(x => ({ cards: x.cards.map(KS.cardText), total: BJ.handTotal(x.cards), actions: x.actions.slice(), result: x.result, profit: x.profit, note: x.note || '', free: x.freeDouble, freeSplit: x.freeSplit })) }))
        });
        if (hist.length > 2000) hist.shift();
      }

      document.addEventListener('keydown', e => {
        if (tabs.panes.play.style.display === 'none') return;
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        const map = { h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender', e: 'even', w: 'wait' };
        const k = e.key.toLowerCase();
        if (k === 'enter') { e.preventDefault(); deal(); }
        else if (map[k]) { e.preventDefault(); doAct(map[k]); }
      });

      function handHtml(x, active) {
        const t = BJ.handInfo(x.cards);
        const res = x.result ? ` <span class="res-${x.result}">${RES_LABEL[x.result]} ${ui.signed(x.profit, 0)}${x.note ? '（' + ui.esc(x.note) + '）' : ''}</span>` : '';
        const tags = [x.isBJ ? 'BJ' : '', x.doubled ? (x.freeDouble ? '免費加倍' : '加倍') : '', x.surrendered ? '投降' : '', x.bust ? '爆牌' : '', x.fromSplit ? '分牌' : ''].filter(Boolean).join('・');
        return `<div class="hand${active ? ' active' : ''}">${x.cards.map(c => ui.cardHtml(c)).join('')}
          <div class="sum">${t.soft && t.total < 21 ? '軟' : ''}${t.total}${tags ? '・' + tags : ''}　${x.freeSplit ? `免費手（輸不扣、贏 ${x.win}）` : `注 ${x.stake}${x.win !== x.stake ? '，贏 ' + x.win : ''}`}${res}</div></div>`;
      }

      function render() {
        if (!shoe) newShoe();
        if (!shoe) return;
        // 桌面
        const cur = rd && rd.phase === 'player' ? rd.current() : null;
        let html = '<h4>莊家</h4><div>';
        if (rd) {
          html += rd.dealer.map(c => ui.cardHtml(c)).join('');
          if (rd.phase === 'player') html += ui.cardHtml(null, true);
          else {
            const dt = BJ.handTotal(rd.dealer);
            html += ` <span class="sum">${rd.dealerBJ ? 'BJ' : dt}${rd.dealerOutcome() === '22' ? '（22點平手）' : dt > 21 ? '（爆牌）' : ''}</span>`;
          }
        } else html += '<span class="muted">按「發牌」開始</span>';
        html += '</div>';
        if (rd) rd.seats.forEach((s, si) => {
          html += `<div class="seat"><h4>玩家${si + 1}${rd.phase === 'done' ? `　<span class="res-${s.result}">${RES_LABEL[s.result]} ${ui.signed(s.net, 0)}</span>` : ''}</h4>` +
            s.hands.map((x, hi) => handHtml(x, cur && cur.seatIdx === si && cur.handIdx === hi)).join('') + '</div>';
        });
        table.innerHTML = html;

        // 動作按鈕
        actions.innerHTML = '';
        const L = cur ? rd.legal(cur.hand, cur.seat) : {};
        const btns = [['hit', '要牌 H'], ['stand', '停牌 S'], ['double', L.doubleFree ? '免費加倍 D' : S.rules.freeDouble ? '自費加倍 D' : '加倍 D'], ['split', '分牌 P'], ['surrender', '投降 R'], ['even', '先收1倍 E'], ['wait', '等莊家 W']];
        btns.forEach(([a, lab]) => {
          if ((a === 'even' || a === 'wait') && !L.even) return;
          if (L.even && a !== 'even' && a !== 'wait') return;
          actions.appendChild(h('button', { text: lab, disabled: !L[a], onclick: () => doAct(a) }));
        });
        actions.appendChild(dealBtn);
        dealBtn.disabled = !!cur;
        msg.innerHTML = (lastMsg && !lastMsg.startsWith('<') ? `<div class="hint">${lastMsg}</div>` : lastMsg || '') +
          (rd && rd.warnings.length ? `<div class="alert">${rd.warnings.join('<br>')}</div>` : '');

        // 資訊面板
        let inf = `<div class="panel"><h3>牌靴剩餘</h3>${ui.remainingHtml(shoe)}`;
        if (cCount.checked) {
          const tc = counter.trueCount(shoe.size());
          inf += `<div class="stat-grid" style="margin-top:8px">
            <div class="stat"><b>${counter.rc}</b><span>Running Count（${KS.COUNT_SYSTEMS[counter.key].name}）</span></div>
            <div class="stat"><b>${tc.toFixed(2)}</b><span>True Count</span></div>
            <div class="stat"><b>${ui.pct(shoe.bigSmall().big, shoe.size(), 1)}</b><span>下一張是大牌的機率</span></div>
            <div class="stat"><b>${(shoe.dealt / shoe.total * 100).toFixed(0)}%</b><span>${S.shuffleMode === 'round' ? '本局已發出（每局洗牌）' : '已發出（切牌卡 ' + S.pen + '%）'}</span></div></div>` +
            (S.shuffleMode === 'round' ? '<small class="muted">每局洗牌：每局開始時牌全部放回，RC/TC 歸零，只反映本局發出的牌。</small>' : '');
          const as = getStrat(advStrat.value);
          if (as && as.segmented) {
            const idx = counter.index(shoe.size());
            const seg = BJ.pickSegment(as, { tc: idx }).seg;
            inf += `<div class="hint">🎯 目前牌況：<b>${seg ? ui.esc(seg.name) : '基本'}</b>（牌況值 ${Math.floor(idx + 1e-9)}）— 策略建議與「偏離提醒」依此段策略</div>`;
          }
        }
        inf += '</div>';
        if (cur && (cEV.checked || cAdv.checked)) {
          const strat = getStrat(advStrat.value);
          const noAdv = unusable(advStrat.value);
          const adv = noAdv ? null : BJ.decide(strat, cur.hand, rd.dealer[0], L, { tc: counter.index(shoe.size()) });
          inf += '<div class="panel"><h3>目前手牌分析</h3>';
          if (cAdv.checked && noAdv) inf += `<div class="hint">📋 ${ui.esc(noAdv)}</div>`;
          else if (cAdv.checked) {
            const sg = BJ.pickSegment(strat, { tc: counter.index(shoe.size()) }).seg;
            inf += `<div class="hint">📋 ${ui.esc(libEntry(advStrat.value).name)}${sg ? '［' + ui.esc(sg.name) + '］' : ''} 建議：<b>${BJ.ACTION_LABEL[adv]}</b></div>`;
          }
          if (cEV.checked) {
            const ev = BJ.evaluate(cur.hand.cards, rd.dealer[0], shoe.remaining10(), S.rules, L, { fromAA: cur.hand.fromAA, freeSplitHand: cur.hand.freeSplit });
            inf += `<div class="table-wrap"><table><tr><th>動作</th><th>EV(每原注)</th><th>勝</th><th>和</th><th>輸</th></tr>` +
              ['stand', 'hit', 'double', 'split', 'surrender', 'even', 'wait'].filter(k => ev[k] && L[k]).map(k => {
                const v = ev[k];
                return `<tr><td class="${k === ev.best ? 'best' : ''}">${BJ.ACTION_LABEL[k]}${k === 'double' && L.doubleFree ? '(免費)' : ''}</td><td class="${clsNum(v.ev)} ${k === ev.best ? 'best' : ''}">${v.ev >= 0 ? '+' : ''}${v.ev.toFixed(4)}</td><td>${ui.pct(v.w, 1, 1)}</td><td>${ui.pct(v.p, 1, 1)}</td><td>${ui.pct(v.l, 1, 1)}</td></tr>`;
              }).join('') + '</table></div>';
            inf += `<h4>莊家明牌 ${KS.cardText(rd.dealer[0])} 的最終結果機率（依剩餘牌）</h4><div class="table-wrap"><table><tr>${BJ.OUTCOMES.filter(k => k !== '22' || S.rules.dealer22Push).map(k => `<th>${OUT_LABEL[k]}</th>`).join('')}</tr><tr>${BJ.OUTCOMES.filter(k => k !== '22' || S.rules.dealer22Push).map(k => `<td>${ui.pct(ev.D[k], 1, 1)}</td>`).join('')}</tr></table></div>
              <small class="muted">EV 依目前剩餘牌組計算：要牌後依最佳要/停；分牌為近似值（不再分牌）。</small>`;
          }
          inf += '</div>';
        }
        info.innerHTML = inf;

        // 本場統計
        const st = sess.streak;
        const curStreak = st.cur > 0 ? `連勝 ${st.cur}` : st.cur < 0 ? `連輸 ${-st.cur}` : '-';
        let sh = `<div class="panel"><h3>本場統計</h3><div class="stat-grid">
          <div class="stat"><b>${sess.rounds}</b><span>局數（座位局）</span></div>
          <div class="stat"><b>${sess.W}/${sess.P}/${sess.L}</b><span>勝/和/負</span></div>
          <div class="stat"><b>${ui.pct(sess.W, sess.W + sess.L)}</b><span>勝率（不含和）</span></div>
          <div class="stat"><b class="${clsNum(sess.net)}">${ui.signed(sess.net, 0)}</b><span>淨盈虧</span></div>
          <div class="stat"><b>${curStreak}</b><span>目前連續</span></div>
          <div class="stat"><b>${st.maxWin} / ${st.maxLose}</b><span>最長連勝 / 連輸</span></div>
          <div class="stat"><b>${sess.dev} / ${sess.decisions}</b><span>偏離策略 / 決策數</span></div></div>`;
        const acts = Object.keys(sess.act);
        if (acts.length) {
          sh += '<h4>各動作勝率（依每手第一個動作）</h4><div class="table-wrap"><table><tr><th>動作</th><th>次數</th><th>勝</th><th>和</th><th>負</th><th>勝率(不含和)</th><th>淨盈虧</th></tr>' +
            acts.map(a => { const x = sess.act[a]; return `<tr><td>${BJ.ACTION_LABEL[a] || a}</td><td>${x.n}</td><td>${x.W}</td><td>${x.P}</td><td>${x.L}</td><td>${ui.pct(x.W, x.W + x.L)}</td><td class="${clsNum(x.net)}">${ui.signed(x.net, 0)}</td></tr>`; }).join('') + '</table></div>';
        }
        sh += `<h4>路單</h4>${ui.roadHtml(sess.road.slice(-300))}</div>`;
        statsBox.innerHTML = sh;
      }
      return { render };
    }

    // 成績按鈕：💾 儲存成績（存完開始新的一輪）、📜 歷史成績
    function scoreButtons(kind, getRecord, reset) {
      const msg = h('span', { class: 'muted' });
      const save = h('button', { class: 'btn-small', text: '💾 儲存成績', onclick: async () => {
        const rec = getRecord();
        if (!rec || !rec.total) { msg.textContent = '還沒有作答紀錄'; return; }
        save.disabled = true; msg.textContent = '儲存中…';
        try {
          await KS.auth.saveScore(preset, kind, rec);
          msg.textContent = `✔ 已儲存（${rec.correct}/${rec.total}，${rec.rate}）${ONLINE ? '到資料庫' : '到這台電腦'}，開始新的一輪`;
          reset();
        } catch (e) { msg.textContent = '⚠️ ' + e.message; }
        save.disabled = false;
      } });
      const hist = h('button', { class: 'btn-small', text: '📜 歷史成績', onclick: async () => {
        hist.disabled = true;
        try {
          const list = await KS.auth.listScores(preset, kind);
          const rows = list.map(r => `<tr><td>${ui.esc(r.time)}</td><td>${r.total}</td><td>${r.correct}</td><td><b>${ui.esc(r.rate)}</b></td><td style="text-align:left;white-space:normal">${ui.esc(r.detail || '')}</td></tr>`).join('');
          ui.modal(`${kind}歷史成績（${P.name}）`, list.length
            ? `<div class="table-wrap"><table><tr><th>時間</th><th>題數</th><th>答對</th><th>正確率</th><th>明細</th></tr>${rows}</table></div><p class="muted">最新的在最上面${ONLINE ? '，資料存在資料庫「練習成績」' : '，資料只存在這台電腦'}。</p>`
            : '<p class="muted">還沒有儲存過成績。</p>');
        } catch (e) { msg.textContent = '⚠️ ' + e.message; }
        hist.disabled = false;
      } });
      return [save, hist, msg];
    }

    /* ================================================================ */
    /* 🧮 算牌練習                                                       */
    /* ================================================================ */
    function buildDrillPane(pane) {
      const sys = sel(Object.keys(KS.COUNT_SYSTEMS).map(k => [k, KS.COUNT_SYSTEMS[k].name]), S.countSystem);
      const decks = h('input', { type: 'number', min: 1, max: 8, value: 1 });
      const per = sel([['1', '每次 1 張'], ['2', '每次 2 張'], ['3', '每次 3 張'], ['4', '每次 4 張']], '1');
      const speed = h('input', { type: 'number', min: 150, step: 50, value: 900 });
      const every = h('input', { type: 'number', min: 0, value: 15 });
      const qRC = h('input', { type: 'checkbox', checked: true });
      const qTC = h('input', { type: 'checkbox', checked: false });
      const qBig = h('input', { type: 'checkbox', checked: false });
      const manual = h('input', { type: 'checkbox', checked: false });
      const startBtn = h('button', { class: 'btn-good', text: '▶ 開始', onclick: start });
      const pauseBtn = h('button', { class: 'btn-ghost', text: '⏸ 暫停/繼續', onclick: () => { if (!shoe) return; paused = !paused; if (!paused) schedule(); } });
      const stage = h('div', { class: 'felt', style: { minHeight: '220px', textAlign: 'center' } });
      const quiz = h('div');
      const scoreBox = h('div');
      let shoe, counter, timer, paused = false, seen = 0, nextAsk = 0, asking = false;
      const score = { RC: { n: 0, ok: 0, err: 0 }, TC: { n: 0, ok: 0, err: 0 }, BIG: { n: 0, ok: 0, err: 0 } };

      pane.appendChild(h('div', { class: 'panel' },
        h('div', { class: 'row' }, '系統', sys, '副數', decks, per, '間隔(毫秒)', speed, '每翻', every, '張問一次（0=發完才問）'),
        h('div', { class: 'row' }, '要回答：', h('label', null, qRC, 'Running Count'), h('label', null, qTC, 'True Count（±0.5 內算對）'), h('label', null, qBig, '剩餘大牌張數（10/J/Q/K/A，±2 內算對）'),
          h('label', null, manual, '手動翻牌（按空白鍵翻下一張）')),
        h('div', { class: 'row' }, startBtn, pauseBtn,
          h('button', { class: 'btn-small', text: '重設成績', onclick: resetScore }),
          ...scoreButtons('算牌練習', drillRecord, resetScore))));
      pane.appendChild(h('div', { class: 'grid2' }, h('div', null, h('div', { class: 'panel' }, stage, quiz)), scoreBox));
      function resetScore() { Object.keys(score).forEach(k => { score[k] = { n: 0, ok: 0, err: 0 }; }); renderScore(); }
      function drillRecord() {
        const lab = { RC: 'RC', TC: 'TC', BIG: '剩餘大牌' };
        const ks = Object.keys(score).filter(k => score[k].n);
        const total = ks.reduce((a, k) => a + score[k].n, 0), correct = ks.reduce((a, k) => a + score[k].ok, 0);
        const parts = ks.map(k => `${lab[k]} ${score[k].ok}/${score[k].n}（平均誤差 ${(score[k].err / score[k].n).toFixed(2)}）`);
        return {
          total, correct, rate: total ? (correct / total * 100).toFixed(1) + '%' : '-',
          detail: [KS.COUNT_SYSTEMS[sys.value].name, `${decks.value} 副`, `每次 ${per.value} 張`, manual.checked ? '手動翻牌' : `間隔 ${speed.value} 毫秒`, parts.join('、')].join('｜')
        };
      }
      stage.innerHTML = '<p>按「開始」後會一張張翻牌，請在心中計算。</p>';
      renderScore();

      function start() {
        clearTimeout(timer);
        const d = Math.max(1, +decks.value || 1);
        shoe = new KS.Shoe({ counts: KS.standardCounts(d), penetration: 1 });
        counter = new KS.Counter(sys.value, shoe.total);
        shoe.onDraw = c => counter.see(c);
        seen = 0; nextAsk = +every.value || 0; paused = false; asking = false;
        quiz.innerHTML = '';
        stage.innerHTML = `<p>開始！共 ${shoe.total} 張（${KS.COUNT_SYSTEMS[counter.key].name}${counter.rc ? '，起始 RC ' + counter.rc : ''}）</p>`;
        schedule();
      }
      function schedule() {
        clearTimeout(timer);
        if (manual.checked || paused || asking) return;
        timer = setTimeout(flip, Math.max(150, +speed.value || 900));
      }
      function flip() {
        if (!shoe || asking) return;
        const k = Math.min(+per.value, shoe.size());
        if (k <= 0) { ask(true); return; }
        const cards = [];
        for (let i = 0; i < k; i++) cards.push(shoe.draw());
        seen += k;
        stage.innerHTML = `<div>${cards.map(c => ui.cardHtml(c).replace('class="card', 'class="card big-flash')).join('')}</div><p class="muted">已翻 ${seen} / ${shoe.total}</p>`;
        if (shoe.size() === 0) { setTimeout(() => ask(true), 600); return; }
        if (nextAsk > 0 && seen >= nextAsk) { nextAsk += +every.value; setTimeout(() => ask(false), 400); return; }
        schedule();
      }
      document.addEventListener('keydown', e => {
        if (tabs.panes.drill.style.display === 'none' || !manual.checked || asking || !shoe) return;
        if (e.target && e.target.tagName === 'INPUT') return;
        if (e.code === 'Space') { e.preventDefault(); flip(); }
      });
      function ask(final) {
        asking = true;
        const fields = [];
        if (qRC.checked) fields.push(['RC', 'Running Count', counter.rc]);
        if (qTC.checked) fields.push(['TC', 'True Count', +counter.trueCount(shoe.size()).toFixed(2)]);
        if (qBig.checked) fields.push(['BIG', '剩餘大牌張數', shoe.bigSmall().big]);
        if (!fields.length) fields.push(['RC', 'Running Count', counter.rc]);
        const inputs = fields.map(f => [f, h('input', { type: 'number', step: 0.5, style: { width: '100px' } })]);
        const submit = () => {
          let fb = '';
          inputs.forEach(([f, inp]) => {
            const v = parseFloat(inp.value), ans = f[2];
            const tol = f[0] === 'TC' ? 0.5 : f[0] === 'BIG' ? 2 : 0;
            const ok = !isNaN(v) && Math.abs(v - ans) <= tol + 1e-9;
            const s = score[f[0]]; s.n++; if (ok) s.ok++; if (!isNaN(v)) s.err += Math.abs(v - ans);
            fb += `<div class="${ok ? 'okbox' : 'alert'}">${f[1]}：你答 ${isNaN(v) ? '(空白)' : v}，正確 ${ans} ${ok ? '✔' : '✘'}</div>`;
          });
          quiz.innerHTML = fb;
          quiz.appendChild(h('button', { text: final ? '再來一輪' : '繼續 (Enter)', onclick: cont }));
          renderScore();
          quiz.onkeydown = null;
        };
        const cont = () => {
          document.removeEventListener('keydown', onEnterCont);
          asking = false; quiz.innerHTML = '';
          if (final) start(); else schedule();
        };
        quiz.innerHTML = '';
        quiz.appendChild(h('div', { class: 'hint', text: final ? '牌發完了！請回答：' : '請回答目前的數值：' }));
        inputs.forEach(([f, inp]) => quiz.appendChild(h('div', { class: 'row' }, f[1], inp)));
        quiz.appendChild(h('button', { text: '送出 (Enter)', onclick: submit }));
        quiz.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); if (quiz.querySelector('input')) submit(); } };
        setTimeout(() => { const f = quiz.querySelector('input'); if (f) f.focus(); }, 0);
        const onEnterCont = e => {
          if (e.key !== 'Enter' || !asking || quiz.querySelector('input')) return;
          if (e.target && e.target.tagName === 'INPUT') return; // 同一個 Enter 剛送出答案
          document.removeEventListener('keydown', onEnterCont);
          e.preventDefault();
          cont();
        };
        document.addEventListener('keydown', onEnterCont);
      }
      function renderScore() {
        const row = (k, lab) => { const s = score[k]; return `<tr><td>${lab}</td><td>${s.n}</td><td>${s.ok}</td><td>${ui.pct(s.ok, s.n, 1)}</td><td>${s.n ? (s.err / s.n).toFixed(2) : '-'}</td></tr>`; };
        scoreBox.innerHTML = `<div class="panel"><h3>成績</h3><table><tr><th>題型</th><th>題數</th><th>答對</th><th>正確率</th><th>平均誤差</th></tr>
          ${row('RC', 'Running Count')}${row('TC', 'True Count')}${row('BIG', '剩餘大牌')}</table>
          <h4>${ui.esc(KS.COUNT_SYSTEMS[sys.value].name)} 權重</h4><table class="mini"><tr>${KS.IDX10_LABEL.map(l => `<th>${l === 'T' ? '10-K' : l}</th>`).join('')}</tr>
          <tr>${KS.COUNT_SYSTEMS[sys.value].tags.map(t => `<td>${t > 0 ? '+' : ''}${t}</td>`).join('')}</tr></table></div>`;
      }
      sys.addEventListener('change', renderScore);
    }

    /* ================================================================ */
    /* ❓ 測驗                                                          */
    /* ================================================================ */
    function buildQuizPane(pane) {
      const strat = stratSelect(defStrat(), () => renderQuizSeg());
      const tHard = h('input', { type: 'checkbox', checked: true });
      const tSoft = h('input', { type: 'checkbox', checked: true });
      const tPair = h('input', { type: 'checkbox', checked: true });
      const total = h('input', { type: 'number', min: 4, max: 21, placeholder: '任意', style: { width: '80px' } });
      const upSel = sel([['', '任意']].concat(BJ.DEALER_VALS.map(d => [String(d), DEALER_LABEL(d)])), '');
      const judge = sel([['strat', '以選定策略為標準答案'], ['ev', '以 EV 最高為標準答案']], 'strat');
      const quizSeg = h('select');
      const quizSegWrap = h('span', null, '牌況', quizSeg);
      function renderQuizSeg() {
        const s = getStrat(strat.value);
        quizSeg.innerHTML = '';
        quizSegWrap.style.display = s && s.segmented ? '' : 'none';
        if (!s || !s.segmented) return;
        quizSeg.appendChild(h('option', { value: '', text: '基本' }));
        s.segments.forEach(x => quizSeg.appendChild(h('option', { value: x.name, text: `${x.name}（${KS.auth.segText(x)}）` })));
      }
      renderQuizSeg();
      const stage = h('div', { class: 'felt', style: { minHeight: '180px' } });
      const btns = h('div', { class: 'actions' });
      const fb = h('div');
      const scoreBox = h('div');
      const sc = { n: 0, ok: 0, byType: {}, wrong: [] };
      let q = null;

      pane.appendChild(h('div', { class: 'panel' },
        h('div', { class: 'row' }, '題型', h('label', null, tHard, '硬牌'), h('label', null, tSoft, '軟牌'), h('label', null, tPair, '對子'),
          '指定點數', total, '指定莊家明牌', upSel),
        h('div', { class: 'row' }, '策略', strat, quizSegWrap, judge,
          h('button', { class: 'btn-good', text: '下一題 (N)', onclick: next }),
          h('button', { class: 'btn-small', text: '重設成績', onclick: resetQuiz }),
          ...scoreButtons('測驗', quizRecord, resetQuiz))));
      function resetQuiz() { Object.assign(sc, { n: 0, ok: 0, byType: {}, wrong: [] }); renderScore(); }
      function quizRecord() {
        const tl = { hard: '硬牌', soft: '軟牌', pair: '對子' };
        const parts = Object.keys(sc.byType).map(k => `${tl[k]} ${sc.byType[k].ok}/${sc.byType[k].n}`);
        const seg = quizSeg.value ? `牌況 ${quizSeg.value}` : '';
        return {
          total: sc.n, correct: sc.ok, rate: sc.n ? (sc.ok / sc.n * 100).toFixed(1) + '%' : '-',
          detail: [parts.join('、'), '策略：' + (libEntry(strat.value) || { name: '—' }).name, seg, '標準：' + (judge.value === 'ev' ? 'EV 最高' : '選定策略')].filter(Boolean).join('｜')
        };
      }
      pane.appendChild(h('div', { class: 'grid2' }, h('div', { class: 'panel' }, stage, btns, fb), scoreBox));
      renderScore();

      const tenR = () => ['10', 'J', 'Q', 'K'][Math.floor(KS.random() * 4)];
      const r2 = v => (v === 11 ? 'A' : v === 10 ? tenR() : String(v));
      const rint = (a, b) => a + Math.floor(KS.random() * (b - a + 1));
      function gen() {
        const types = [tHard.checked && 'hard', tSoft.checked && 'soft', tPair.checked && 'pair'].filter(Boolean);
        if (!types.length) { alert('請至少選一種題型'); return null; }
        const want = parseInt(total.value, 10);
        for (let tries = 0; tries < 500; tries++) {
          const type = types[rint(0, types.length - 1)];
          let cards;
          if (type === 'hard') {
            const t = !isNaN(want) ? want : rint(5, 20);
            const a = rint(2, 10), b = t - a;
            if (b < 2 || b > 10 || a === b) continue;
            cards = [r2(a), r2(b)];
          } else if (type === 'soft') {
            const x = !isNaN(want) ? want - 11 : rint(2, 9);
            if (x < 2 || x > 9) continue;
            cards = ['A', r2(x)];
          } else {
            const pv = rint(2, 11);
            if (!isNaN(want) && pv * 2 !== want && !(pv === 11 && want === 12)) continue;
            const r = r2(pv); cards = [r, r];
          }
          const d = upSel.value ? +upSel.value : BJ.DEALER_VALS[rint(0, 9)];
          return { type, cards, up: r2(d) };
        }
        alert('找不到符合條件的題目，請放寬條件');
        return null;
      }
      function legalFor(cards) {
        const R = S.rules, info = BJ.handInfo(cards);
        const pair = BJ.handInfo([cards[0]]).total === BJ.handInfo([cards[1]]).total && KS.rankOf(cards[0]) === KS.rankOf(cards[1]);
        return {
          hit: true, stand: true, double: true, split: pair && R.maxHands > 1,
          surrender: R.surrender !== 'none',
          doubleFree: R.freeDouble && !info.soft && info.total >= 9 && info.total <= 11
        };
      }
      function next() {
        q = gen();
        if (!q) return;
        q.L = legalFor(q.cards);
        const info = BJ.handInfo(q.cards);
        stage.innerHTML = `<h4>莊家明牌</h4>${ui.cardHtml(q.up)}<h4>你的牌（${info.soft ? '軟' : q.type === 'pair' ? '對子 ' : '硬'}${info.total}）</h4>${q.cards.map(c => ui.cardHtml(c)).join('')}`;
        btns.innerHTML = '';
        fb.innerHTML = '';
        [['hit', '要牌 H'], ['stand', '停牌 S'], ['double', q.L.doubleFree ? '免費加倍 D' : S.rules.freeDouble ? '自費加倍 D' : '加倍 D'], ['split', '分牌 P'], ['surrender', '投降 R']].forEach(([a, lab]) => {
          if (q.L[a]) btns.appendChild(h('button', { text: lab, onclick: () => answer(a) }));
        });
      }
      function answer(a) {
        if (!q || q.answered) return;
        const bad = unusable(strat.value);
        if (bad && judge.value === 'strat') { fb.innerHTML = `<div class="alert">${ui.esc(bad)}。也可以把標準改成「以 EV 最高為標準答案」。</div>`; return; }
        q.answered = true;
        const st = getStrat(strat.value);
        const sAns = bad ? null : BJ.decide(st, { cards: q.cards }, q.up, q.L, { segment: quizSeg.value || '__base__' });
        const c10 = BJ.toCounts10(S.counts);
        [q.up, ...q.cards].forEach(c => { const i = KS.idx10(c); if (c10[i] > 0) c10[i]--; });
        const ev = BJ.evaluate(q.cards, q.up, c10, S.rules, q.L, { fromAA: KS.rankOf(q.cards[0]) === 'A' && KS.rankOf(q.cards[1]) === 'A' });
        const correct = judge.value === 'ev' ? ev.best : sAns;
        const ok = a === correct;
        sc.n++; if (ok) sc.ok++;
        const key = q.type;
        const bt = sc.byType[key] || (sc.byType[key] = { n: 0, ok: 0 });
        bt.n++; if (ok) bt.ok++;
        if (!ok) sc.wrong.unshift({ cards: q.cards.slice(), up: q.up, you: a, correct, sAns, evBest: ev.best });
        if (sc.wrong.length > 50) sc.wrong.pop();
        const loss = ev[a] && ev[correct] ? ev[correct].ev - ev[a].ev : 0;
        fb.innerHTML = `<div class="${ok ? 'okbox' : 'alert'}">${ok ? '✔ 正確' : '✘ 錯誤'}：你選「${BJ.ACTION_LABEL[a]}」；
          策略答案「${(BJ.ACTION_LABEL[sAns] || '—')}」；EV 最高「${BJ.ACTION_LABEL[ev.best]}」${!ok && loss > 0 ? `，少了 ${(loss * 100).toFixed(2)}% 原注` : ''}</div>
          <div class="table-wrap"><table><tr><th>動作</th><th>EV</th><th>勝</th><th>和</th><th>輸</th></tr>${['stand', 'hit', 'double', 'split', 'surrender'].filter(k => ev[k]).map(k =>
            `<tr><td class="${k === ev.best ? 'best' : ''}">${BJ.ACTION_LABEL[k]}</td><td class="${clsNum(ev[k].ev)}">${ev[k].ev.toFixed(4)}</td><td>${ui.pct(ev[k].w, 1, 1)}</td><td>${ui.pct(ev[k].p, 1, 1)}</td><td>${ui.pct(ev[k].l, 1, 1)}</td></tr>`).join('')}</table></div>
          <small class="muted">EV 以「規則與牌組」中的完整牌組計算（扣除這三張牌）。按 N 下一題。</small>`;
        renderScore();
      }
      document.addEventListener('keydown', e => {
        if (tabs.panes.quiz.style.display === 'none') return;
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        const map = { h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender' };
        const k = e.key.toLowerCase();
        if (k === 'n' || (k === 'enter' && (!q || q.answered))) { e.preventDefault(); next(); }
        else if (map[k] && q && q.L[map[k]]) { e.preventDefault(); answer(map[k]); }
      });
      function renderScore() {
        const tl = { hard: '硬牌', soft: '軟牌', pair: '對子' };
        scoreBox.innerHTML = `<div class="panel"><h3>成績</h3><div class="stat-grid">
          <div class="stat"><b>${sc.ok} / ${sc.n}</b><span>答對 / 題數</span></div>
          <div class="stat"><b>${ui.pct(sc.ok, sc.n, 1)}</b><span>正確率</span></div>
          ${Object.keys(sc.byType).map(k => `<div class="stat"><b>${ui.pct(sc.byType[k].ok, sc.byType[k].n, 1)}</b><span>${tl[k]}（${sc.byType[k].n} 題）</span></div>`).join('')}</div>
          <h4>錯題回顧（最近 50 題）</h4>${sc.wrong.length ? `<table><tr><th>你的牌</th><th>莊</th><th>你選</th><th>策略</th><th>EV最高</th></tr>${sc.wrong.map(w =>
            `<tr><td>${w.cards.join(' ')}</td><td>${w.up}</td><td>${BJ.ACTION_LABEL[w.you]}</td><td>${(BJ.ACTION_LABEL[w.sAns] || '—')}</td><td>${BJ.ACTION_LABEL[w.evBest]}</td></tr>`).join('')}</table>` : '<p class="muted">目前沒有錯題</p>'}</div>`;
      }
      return { renderQuizSeg: () => { fillStrat(strat); renderQuizSeg(); } };
    }

    /* ================================================================ */
    /* 📋 策略管理                                                       */
    /* ================================================================ */
    function buildStratPane(pane) {
      const C = BJ.cells;
      // 切換策略前：目前策略有未儲存的修改就先詢問
      let lastPick = null;
      const pick = stratSelect(defStrat(), async v => {
        const was = S.user.find(u => u.id === lastPick);
        if (was && was.dirty) {
          pick.value = lastPick;
          if (!(await resolveDirty('切換到其他策略'))) return;
          fillStrat(pick, v);
        }
        lastPick = pick.value;
        segSel.value = ''; renderSegSel(); renderGrid(); updateDirty();
      });
      lastPick = pick.value;
      const dirtyBar = h('div', { class: 'row' });
      const segSel = h('select', { onchange: () => renderGrid() });
      const segWrap = h('span', null, '牌況', segSel);
      const gridBox = h('div');
      const msg = h('div');
      const flash = (t, bad) => { msg.innerHTML = `<div class="${bad ? 'alert' : 'okbox'}">${ui.esc(t)}</div>`; setTimeout(() => { msg.innerHTML = ''; }, 3500); };
      const fileInp = h('input', { type: 'file', accept: '.json,application/json', style: { display: 'none' }, onchange: () => { if (fileInp.files[0]) importFile(fileInp.files[0]); fileInp.value = ''; } });
      const drop = h('div', { class: 'drop-zone', text: '📂 把策略 JSON 檔拖曳到這裡，或點此選擇檔案（相容舊版 ks_rules.json）' });
      drop.addEventListener('click', () => fileInp.click());
      drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('over'); });
      drop.addEventListener('dragleave', () => drop.classList.remove('over'));
      drop.addEventListener('drop', e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) importFile(f); });

      const cur = () => libEntry(pick.value);
      // 目前檢視的單一策略表（分段策略則為所選牌況）
      function viewed() {
        const e = cur();
        if (!e) return null;
        const s = e.get();
        if (!s.segmented) return s;
        const seg = s.segments.find(x => x.name === segSel.value);
        return seg ? seg.strat : s.base;
      }
      function renderSegSel() {
        const s = cur() && cur().get();
        segSel.innerHTML = '';
        if (!s || !s.segmented) { segWrap.style.display = 'none'; return; }
        segWrap.style.display = '';
        segSel.appendChild(h('option', { value: '', text: '基本（不在任何分段時）' }));
        s.segments.forEach(x => segSel.appendChild(h('option', { value: x.name, text: `${x.name}（牌況值 ${KS.auth.segText(x)}）` })));
      }
      // 新策略：先放在畫面上，按「儲存」才寫入
      async function addUser(s, name, from) {
        if (!(await resolveDirty('建立新策略'))) return null;
        const copy = C.materialize(BJ.cloneStrategy(s));
        copy.name = name || copy.name;
        delete copy.builtin;
        const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        S.user.push({ id, s: copy, base: null, dirty: true, from: from || null });
        refreshStratSelects();
        pick.value = id; lastPick = id;
        renderSegSel(); renderGrid(); updateDirty();
        return id;
      }
      // 策略管理頁的儲存列
      function updateDirty() {
        const u = S.user.find(x => x.id === pick.value);
        dirtyBar.innerHTML = '';
        if (!u) return;
        if (!u.dirty) { dirtyBar.appendChild(h('span', { class: 'muted', text: ONLINE ? '✔ 已儲存到資料庫' : '✔ 已儲存在這台電腦' })); return; }
        const n = u.base ? diffStrategy(u).length : 0;
        dirtyBar.appendChild(h('span', { class: 'unsaved', text: u.base ? `● 有 ${n} 處未儲存的修改` : '● 新策略，還沒有儲存' }));
        dirtyBar.appendChild(h('button', { class: 'btn-good', text: '💾 儲存', onclick: async () => {
          const c = await askChanges(u, { title: '確認儲存', saveText: '💾 確認儲存', cancelText: '取消' });
          if (c !== 'save') return;
          try { await commit(u); flash('已儲存：' + u.s.name); } catch (e) { flash('儲存失敗：' + e.message, true); }
        } }));
        dirtyBar.appendChild(h('button', { class: 'btn-small', text: '↩ 放棄修改', onclick: async () => {
          const c = await askChanges(u, { title: '放棄修改？', message: '以下修改會被丟掉，回到上次儲存的內容' + (u.base ? '' : '（這個新策略會被移除）') + '。', saveText: '💾 改成儲存', allowDiscard: true, discardText: '確定放棄', cancelText: '取消' });
          if (c === 'save') { try { await commit(u); flash('已儲存：' + u.s.name); } catch (e) { flash('儲存失敗：' + e.message, true); } }
          else if (c === 'discard') { discard(u); lastPick = pick.value; renderSegSel(); renderGrid(); flash('已放棄修改'); }
        } }));
        dirtyBar.appendChild(h('button', { class: 'btn-small', text: '查看修改', onclick: () => askChanges(u, { title: '這次的修改', saveText: '💾 儲存', cancelText: '關閉' }).then(async c => { if (c === 'save') { try { await commit(u); flash('已儲存：' + u.s.name); } catch (e) { flash('儲存失敗：' + e.message, true); } } }) }));
      }
      async function importFile(f) {
        try {
          const obj = await ui.readJsonFile(f);
          const s = BJ.normalizeStrategy(obj);
          if (!(await addUser(s, obj.name || f.name.replace(/\.json$/i, ''), '匯入檔案 ' + f.name))) return;
          if (Array.isArray(obj.boostSequence) && obj.boostSequence.length) {
            S.boostSeq = obj.boostSequence.map(Number).filter(x => x > 0);
            store.set('ks_boost_sequence_v1', S.boostSeq);
            flash(`已匯入策略「${f.name}」（尚未儲存），並套用檔案中的智慧加注序列`);
          } else flash(`已匯入策略「${f.name}」，確認內容後請按「💾 儲存」`);
        } catch (e) { flash('匯入失敗：' + e.message, true); }
      }
      pane.appendChild(h('div', { class: 'panel' },
        h('div', { class: 'row' }, '策略', pick, segWrap,
          h('button', { class: 'btn-good', text: '＋ 新增空白策略', onclick: () => { const n = prompt('新策略名稱', '我的策略'); if (n) addUser(BJ.blankStrategy(n), n, '空白').then(id => { if (id) flash('已建立「' + n + '」：點格子（或點左邊的列名稱一次設定整列）填完後按「💾 儲存」'); }); } }),
          h('button', { class: 'btn-small', text: '複製成新策略（可編輯）', onclick: () => { if (!viewed()) return flash('目前沒有可以複製的策略', true); const n = prompt('新策略名稱', viewed().name.replace(/（.*）/, '') + ' 副本'); if (n) { const from = viewed().name; addUser(viewed(), n, from).then(id => { if (id) flash('已建立「' + n + '」，編輯後請按「💾 儲存」'); }); } } }),
          h('button', { class: 'btn-small', text: '重新命名', onclick: () => { const e = cur(); if (!e || e.builtin) return flash('內建策略不能改名，請先複製', true); const n = prompt('新名稱', e.name); if (n) { e.get().name = n; markDirty(e.id); renderGrid(); } } }),
          h('button', { class: 'btn-small', text: '刪除', onclick: () => { const e = cur(); if (!e || e.builtin) return flash('內建策略不能刪除', true); if (!confirm(`刪除「${e.get().name}」？${ONLINE ? '（會從資料庫刪除）' : ''}`)) return; removeUser(e.id); fillStrat(pick, defStrat()); lastPick = pick.value; renderSegSel(); renderGrid(); updateDirty(); } }),
          h('button', { class: 'btn-small', text: '⬇ 匯出 JSON', onclick: () => { const v = viewed(); if (!v) return; ui.download(`ks_rules_${v.name.replace(/[\\/:*?"<>|（）()［］ ]+/g, '_')}.json`, JSON.stringify(BJ.exportStrategy(v, { boostSequence: S.boostSeq }), null, 2)); } })),
        dirtyBar, drop, fileInp, msg,
        h('small', { class: 'muted', text: '修改策略後要按「💾 儲存」才會寫入' + (ONLINE ? '資料庫' : '這台電腦') + '；還沒儲存就離開時會提醒你。「資料庫策略」是唯讀的，請直接改資料庫後按上方「重新讀取資料庫」。' })));
      pane.appendChild(gridBox);

      const LABEL = { H: 'H', S: 'S', Dh: 'D', Ds: 'Ds', Rh: 'R', Rs: 'Rs', P: 'P', D: 'D', R: 'R', '-': '·', Y: '收', N: '不收' };
      // 22點：加倍格子標示免費（硬 9/10/11 兩張）或自費
      function cellLabel(kind, key, code) {
        const lab = LABEL[code] || code;
        if (!S.rules.freeDouble || code[0] !== 'D') return lab;
        const total = kind === 'pair' ? key * 2 : key;
        const free = (kind === 'hard' || (kind === 'pair' && key !== 11)) && total >= 9 && total <= 11;
        return (free ? '免' : '自') + lab;
      }
      function renderGrid() {
        const e = cur();
        gridBox.innerHTML = '';
        if (!e) {
          gridBox.appendChild(h('div', { class: 'panel' }, h('h3', { text: '還沒有策略' }),
            h('p', { text: '按上方「＋ 新增空白策略」建立自己的策略，每一格都填完後按「💾 儲存」。' })));
          return;
        }
        const s = viewed();
        const editable = !e.builtin;
        const legend = '<small class="muted">H=要牌　S=停牌　D=可加倍就加倍否則要牌　Ds=可加倍就加倍否則停牌　R=可投降就投降否則要牌　Rs=投降否則停牌　P=分牌　·=對子不特別處理（依點數表）</small>' +
          (S.rules.freeDouble ? '<div class="hint">💰 加倍分兩種，由點數自動決定：<b>免D</b> = 兩張硬 9/10/11 <b>免費加倍</b>（贏賠 2 倍注、輸只輸原注）；<b>自D</b> = 其他點數（硬 12 以上、軟牌 A+x、對子）<b>自費加倍</b>（放同額籌碼）。兩種都只補一張。<br>在格子填 D 就是「這手要加倍」；想要「只在免費時加倍、需要自費就不加」，在自費的格子改填 H 或 S 即可。</div>' : '');
        const miss = BJ.missingCells(s), need = BJ.requiredTotal();
        gridBox.appendChild(h('div', { class: 'panel' },
          h('h3', { text: `${s.name}${editable ? '（點格子切換動作，點左邊的列名稱一次設定整列）' : '（唯讀 — 請先「複製成新策略」再編輯）'}` }),
          s.partial ? h('div', { class: miss ? 'hint' : 'okbox', text: miss ? `已填 ${need - miss} / ${need} 格，還有 ${miss} 格（顯示「？」）要填，填完才能模擬、當建議或測驗標準` : `✔ ${need} 格都填完了` }) : null,
          h('div', { html: legend })));
        const section = (title, kind, rows, getCode, setCode, cols) => {
          cols = cols || BJ.DEALER_VALS;
          const tbl = h('table', { class: 'strat' });
          tbl.appendChild(h('tr', null, h('th', { text: '玩家 \\ 莊家' }), cols.map(d => h('th', { text: DEALER_LABEL(d) }))));
          const codeAt = (key, d) => (C.isFilled(s, kind, key, d) ? getCode(s, key, d) : '?');
          const cls = c => `cell c-${c === 'Y' ? 'P' : c === 'N' ? '-' : c === '?' ? 'Q' : c}`;
          const nextCode = c => { const cyc = C.CYCLE[kind]; return c === '?' ? cyc[0] : cyc[(cyc.indexOf(c) + 1) % cyc.length]; };
          rows.forEach(([key, label]) => {
            const th = h('th', { text: label, class: editable ? 'row-head' : '', title: editable ? '點一下：整列一起切換' : '' });
            const tr = h('tr', null, th);
            const tds = [];
            cols.forEach(d => {
              const code = codeAt(key, d);
              const td = h('td', { class: cls(code), text: code === '?' ? '？' : cellLabel(kind, key, code) });
              const paint = () => { const c2 = codeAt(key, d); td.className = cls(c2); td.textContent = c2 === '?' ? '？' : cellLabel(kind, key, c2); };
              td.addEventListener('click', () => {
                if (!editable) { flash('唯讀策略不能修改，請先「複製成新策略」', true); return; }
                setCode(s, key, d, nextCode(codeAt(key, d)));
                markDirty(e.id);
                paint();
                if (s.partial) renderProgress();
              });
              tds.push(paint);
              tr.appendChild(td);
            });
            th.addEventListener('click', () => {
              if (!editable) return;
              const nx = nextCode(codeAt(key, cols[0]));
              cols.forEach(d => setCode(s, key, d, nx));
              markDirty(e.id);
              tds.forEach(p => p());
              if (s.partial) renderProgress();
            });
            tbl.appendChild(tr);
          });
          gridBox.appendChild(h('div', { class: 'panel' }, h('h4', { text: title }), h('div', { class: 'table-wrap' }, tbl)));
        };
        // 填格子時即時更新進度（不重畫整張表）
        function renderProgress() {
          const box = gridBox.querySelector('.hint, .okbox');
          if (!box) return;
          const m = BJ.missingCells(s);
          box.className = m ? 'hint' : 'okbox';
          box.textContent = m ? `已填 ${need - m} / ${need} 格，還有 ${m} 格（顯示「？」）要填，填完才能模擬、當建議或測驗標準` : `✔ ${need} 格都填完了`;
        }
        const hardRows = []; for (let t = 21; t >= 4; t--) hardRows.push([t, '硬 ' + t]);
        const softRows = []; for (let t = 21; t >= 13; t--) softRows.push([t, `A,${t - 11}（軟${t}）`]);
        const pairRows = []; for (let pv = 11; pv >= 2; pv--) pairRows.push([pv, pv === 11 ? 'A,A' : `${pv},${pv}`]);
        section('對子（優先判斷）', 'pair', pairRows, C.pairCode, C.setPair);
        section('硬牌', 'hard', hardRows, C.hardCode, C.setHard);
        section('軟牌', 'soft', softRows, C.softCode, C.setSoft);
        if (S.rules.surrenderAfterDouble) {
          const daRows = []; for (let t = 20; t >= 4; t--) daRows.push([t, '加倍後 ' + t]);
          section('加倍後投降（加倍拿牌後的總點數）', 'da', daRows, C.daCode, C.setDA);
        }
        if (S.rules.evenMoney) {
          section('保險：玩家 BJ 時是否先收 1 倍', 'even', [['BJ', '玩家 BJ']], (st, k, d) => C.evenCode(st, d), (st, k, d, code) => C.setEven(st, d, code), [10, 11]);
        }
      }
      renderSegSel();
      renderGrid();
      updateDirty();
      return { refresh: () => { fillStrat(pick); lastPick = pick.value; renderSegSel(); renderGrid(); updateDirty(); }, updateDirty };
    }
  }

  KS.BJUI = { init };
})();
