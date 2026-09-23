/* ==========================================================================
   ks-sangong.js — 三公（三張牌）引擎 + UI
   - 順子依 A-2-…-K 順序判斷，J-Q-K、Q-K-A 都算順
   - 老虎 / 大老虎 / 小老虎 只看自己是否 6 點，不需贏莊家
   - 所有投注統一「先扣注，中獎加回 注×(賠率+1)」
   - 精確機率：以剩餘牌組枚舉所有三張組合
   ========================================================================== */
(function (root) {
  'use strict';
  const KS = root.KS || (typeof require !== 'undefined' ? require('./ks-core.js') : null);
  const { RANKS, rankOf } = KS;

  /* ---------------- 牌型 ---------------- */
  const ORDER = {}; RANKS.forEach((r, i) => { ORDER[r] = i + 1; }); // A=1 … K=13
  const isFaceR = r => r === 'J' || r === 'Q' || r === 'K';
  const valR = r => (r === 'A' ? 1 : isFaceR(r) || r === '10' ? 10 : +r);

  function evaluate(hand) {
    let sum = 0, face = 0;
    for (const c of hand) { const r = rankOf(c); sum += valR(r); if (isFaceR(r)) face++; }
    return { tail: sum % 10, face };
  }
  const isFlush = hand => hand[0].s === hand[1].s && hand[1].s === hand[2].s;
  function isStraightRanks(rs) {
    const o = rs.map(r => ORDER[r]).sort((a, b) => a - b);
    if (o[0] === o[1] || o[1] === o[2]) return false;
    if (o[0] + 1 === o[1] && o[1] + 1 === o[2]) return true;
    return o[0] === 1 && o[1] === 12 && o[2] === 13; // Q-K-A
  }
  const isStraight = hand => isStraightRanks(hand.map(rankOf));
  function typeName(e) {
    if (e.face === 3) return '公+公+公';
    if (e.face === 2) return e.tail + '+公+公';
    if (e.face === 1) return e.tail + '+公';
    return '' + e.tail;
  }
  // 三公 > 點數大 > 公牌多
  function compare(a, b) {
    if (a.face === 3 && b.face !== 3) return 1;
    if (b.face === 3 && a.face !== 3) return -1;
    if (a.tail !== b.tail) return a.tail > b.tail ? 1 : -1;
    if (a.face !== b.face) return a.face > b.face ? 1 : -1;
    return 0;
  }
  const HAND_TYPES = ['公+公+公'];
  for (let t = 9; t >= 0; t--) HAND_TYPES.push(t + '+公+公', t + '+公', '' + t);

  const DEFAULT_ODDS = {
    mainSix: 0.5, bigTiger: 90, smallTiger: 50, sixWin0: 6, sixWin1: 12, sixWin2: 50,
    flush: 3, straight: 6, straightFlush: 40, face4: 10, face5: 100, face6: 1000
  };
  const BET_KEYS = ['main', 'special', 'bigTiger', 'smallTiger', 'tiger', 'face'];
  const BET_LABEL = { main: '主注', special: '特殊牌組', bigTiger: '大老虎', smallTiger: '小老虎', tiger: '老虎', face: '公牌' };

  /**
   * 結算單一玩家
   * @returns {{main, side:{key:profit}, hits:{key:bool}, cmp, e}}
   */
  function settle(hand, dealerEval, bets, odds) {
    const e = evaluate(hand);
    const cmp = compare(e, dealerEval);
    const out = { e, cmp, main: 0, side: {}, hits: {}, sf: false, fl: false, st: false };
    const b = k => bets[k] || 0;
    // 主注：贏 1 倍，6 點贏只賠 mainSix 倍
    if (cmp > 0) out.main = b('main') * (e.tail === 6 && e.face < 3 ? odds.mainSix : 1);
    else if (cmp < 0) out.main = -b('main');
    const side = (k, hit, o) => { out.hits[k] = hit; out.side[k] = hit ? b(k) * o : -b(k); };
    const six = e.tail === 6 && e.face < 3;
    side('bigTiger', six && e.face === 2, odds.bigTiger);
    side('smallTiger', six && e.face === 1, odds.smallTiger);
    side('tiger', six, e.face === 0 ? odds.sixWin0 : e.face === 1 ? odds.sixWin1 : odds.sixWin2);
    const fl = isFlush(hand), st = isStraight(hand);
    out.fl = fl; out.st = st; out.sf = fl && st;
    side('special', fl || st, fl && st ? odds.straightFlush : st ? odds.straight : odds.flush);
    const tf = e.face + dealerEval.face;
    side('face', tf >= 4, tf === 4 ? odds.face4 : tf === 5 ? odds.face5 : odds.face6);
    out.totalFace = tf;
    return out;
  }

  /* ---------------- 精確機率 ---------------- */
  const C2 = n => (n * (n - 1)) / 2, C3 = n => (n * (n - 1) * (n - 2)) / 6;
  // 以點數層級枚舉三張組合：cb(evalObj, ways)
  function forEachRankTriple(cnt, cb) {
    for (let i = 0; i < 13; i++) {
      const a = cnt[i]; if (!a) continue;
      for (let j = i; j < 13; j++) {
        const b = j === i ? a - 1 : cnt[j]; if (b <= 0) continue;
        for (let k = j; k < 13; k++) {
          let ways;
          if (i === j && j === k) ways = C3(a);
          else if (i === j) ways = C2(a) * cnt[k];
          else if (j === k) ways = a * C2(cnt[j]);
          else ways = a * cnt[j] * cnt[k];
          if (ways <= 0) continue;
          cb(i, j, k, ways);
        }
      }
    }
  }
  const evalIdx = (i, j, k) => {
    const rs = [RANKS[i], RANKS[j], RANKS[k]];
    let sum = 0, face = 0;
    rs.forEach(r => { sum += valR(r); if (isFaceR(r)) face++; });
    return { tail: sum % 10, face };
  };

  // 已知玩家手牌，莊家從剩餘牌抽三張：主注勝/和/負、莊家公牌數分佈
  function vsDealer(playerHand, rem13) {
    const cnt = RANKS.map(r => rem13[r] || 0);
    const pe = evaluate(playerHand);
    let W = 0, P = 0, L = 0, tot = 0;
    const dFace = [0, 0, 0, 0];
    forEachRankTriple(cnt, (i, j, k, w) => {
      const de = evalIdx(i, j, k);
      const c = compare(pe, de);
      if (c > 0) W += w; else if (c < 0) L += w; else P += w;
      dFace[de.face] += w;
      tot += w;
    });
    return { W: W / tot, P: P / tot, L: L / tot, dFace: dFace.map(x => x / tot), pe };
  }

  // 下一手（玩家 3 張 + 莊家 3 張）的精確機率：主注與各投注中獎率（花色枚舉只用於同花/順子）
  function nextHandProbs(shoeCards) {
    // 1) 花色層級：同花、順子、同花順、6點(0/1/2公)
    const groups = new Map();
    shoeCards.forEach(c => { const k = c.r + c.s; groups.set(k, (groups.get(k) || { r: c.r, s: c.s, n: 0 })); groups.get(k).n++; });
    const g = Array.from(groups.values());
    let tot = 0, fl = 0, st = 0, sf = 0;
    const six = [0, 0, 0];
    for (let i = 0; i < g.length; i++) for (let j = i; j < g.length; j++) for (let k = j; k < g.length; k++) {
      const a = g[i].n, b = g[j].n, c = g[k].n;
      let w;
      if (i === j && j === k) w = C3(a);
      else if (i === j) w = C2(a) * c;
      else if (j === k) w = a * C2(b);
      else w = a * b * c;
      if (w <= 0) continue;
      tot += w;
      const rs = [g[i].r, g[j].r, g[k].r];
      const f = g[i].s === g[j].s && g[j].s === g[k].s;
      const s = isStraightRanks(rs);
      if (f && s) sf += w; else if (s) st += w; else if (f) fl += w;
      let sum = 0, face = 0; rs.forEach(r => { sum += valR(r); if (isFaceR(r)) face++; });
      if (sum % 10 === 6 && face < 3) six[face] += w;
    }
    // 2) 點數層級：玩家 vs 莊家、公牌合計
    const cnt = RANKS.map(() => 0);
    shoeCards.forEach(c => { cnt[ORDER[c.r] - 1]++; });
    let W = 0, P = 0, L = 0, T = 0, W6 = 0;
    const tf = [0, 0, 0, 0, 0, 0, 0];
    forEachRankTriple(cnt, (i, j, k, w) => {
      const pe = evalIdx(i, j, k);
      const c2 = cnt.slice(); c2[i]--; c2[j]--; c2[k]--;
      forEachRankTriple(c2, (a, b, c, w2) => {
        const de = evalIdx(a, b, c);
        const ww = w * w2;
        const r = compare(pe, de);
        if (r > 0) { W += ww; if (pe.tail === 6 && pe.face < 3) W6 += ww; } else if (r < 0) L += ww; else P += ww;
        tf[pe.face + de.face] += ww;
        T += ww;
      });
    });
    return {
      flush: fl / tot, straight: st / tot, straightFlush: sf / tot, six: six.map(x => x / tot),
      W: W / T, P: P / T, L: L / T, W6: W6 / T, face: tf.map(x => x / T)
    };
  }
  // 由機率計算各投注每單位 EV
  function betEV(pr, odds) {
    const ev = {};
    ev.main = (pr.W - pr.W6) + pr.W6 * odds.mainSix - pr.L;
    const six = pr.six[0] + pr.six[1] + pr.six[2];
    ev.bigTiger = pr.six[2] * odds.bigTiger - (1 - pr.six[2]);
    ev.smallTiger = pr.six[1] * odds.smallTiger - (1 - pr.six[1]);
    ev.tiger = pr.six[0] * odds.sixWin0 + pr.six[1] * odds.sixWin1 + pr.six[2] * odds.sixWin2 - (1 - six);
    const sp = pr.flush + pr.straight + pr.straightFlush;
    ev.special = pr.flush * odds.flush + pr.straight * odds.straight + pr.straightFlush * odds.straightFlush - (1 - sp);
    const f = pr.face[4] + pr.face[5] + pr.face[6];
    ev.face = pr.face[4] * odds.face4 + pr.face[5] * odds.face5 + pr.face[6] * odds.face6 - (1 - f);
    ev.hit = { main: pr.W, bigTiger: pr.six[2], smallTiger: pr.six[1], tiger: six, special: sp, face: f };
    return ev;
  }

  /* ---------------- 模擬器 ---------------- */
  class Simulator {
    /** cfg: { counts, penetration, shuffleEveryRound, odds, players:[{bets}], smartBet:{on, seq}, logLimit } */
    constructor(cfg) {
      this.cfg = cfg;
      this.shoe = new KS.Shoe({ counts: cfg.counts, penetration: cfg.penetration, withSuits: true });
      this.round = 0;
      this.logs = [];
      this.types = { banker: {} };
      this.winByType = { player: {}, banker: {} };
      this.players = cfg.players.map((p, i) => {
        this.types['p' + i] = {};
        return {
          idx: 0, W: 0, L: 0, P: 0, main: 0, acc: new KS.Acc(), bank: new KS.Bankroll(), streak: new KS.StreakTracker(10), road: [],
          side: Object.fromEntries(BET_KEYS.filter(k => k !== 'main').map(k => [k, { wager: 0, hits: 0, net: 0 }])),
          ev: { six0: 0, six1: 0, six2: 0, flush: 0, straight: 0, sf: 0, f4: 0, f5: 0, f6: 0 }, sideNet: 0
        };
      });
    }
    step() {
      const cfg = this.cfg, shoe = this.shoe;
      this.round++;
      if (cfg.shuffleEveryRound || shoe.needsShuffle()) shoe.shuffle();
      const dealer = [shoe.draw(), shoe.draw(), shoe.draw()];
      const de = evaluate(dealer);
      const dt = typeName(de);
      this.types.banker[dt] = (this.types.banker[dt] || 0) + 1;
      const log = this.logs.length < (cfg.logLimit || 0) ? { round: this.round, dealer: dealer.map(KS.cardText), dType: dt, players: [] } : null;
      cfg.players.forEach((pc, i) => {
        const S = this.players[i];
        const hand = [shoe.draw(), shoe.draw(), shoe.draw()];
        const bets = Object.assign({}, pc.bets);
        if (cfg.smartBet && cfg.smartBet.on && cfg.smartBet.seq.length) bets.main = cfg.smartBet.seq[Math.min(S.idx, cfg.smartBet.seq.length - 1)];
        const r = settle(hand, de, bets, cfg.odds);
        const pt = typeName(r.e);
        this.types['p' + i][pt] = (this.types['p' + i][pt] || 0) + 1;
        S.main += r.main;
        S.acc.add(bets.main ? r.main / bets.main : 0);
        let sideNet = 0;
        Object.keys(r.side).forEach(k => { const x = S.side[k]; x.wager += bets[k] || 0; if (r.hits[k]) x.hits++; x.net += r.side[k]; sideNet += r.side[k]; });
        S.sideNet += sideNet;
        S.bank.add(r.main + sideNet);
        const res = r.cmp > 0 ? 'W' : r.cmp < 0 ? 'L' : 'P';
        S[res]++;
        S.streak.push(res);
        if (S.road.length < 600) S.road.push(res);
        // 智慧下注：贏往下一階、輸回第一階、和局不變
        if (res === 'W') S.idx = Math.min(S.idx + 1, Math.max(0, (cfg.smartBet && cfg.smartBet.seq.length || 1) - 1));
        else if (res === 'L') S.idx = 0;
        // 事件
        const e = r.e;
        if (e.tail === 6 && e.face < 3) S.ev['six' + e.face]++;
        if (r.sf) S.ev.sf++; else if (r.st) S.ev.straight++; else if (r.fl) S.ev.flush++;
        if (r.totalFace >= 4) S.ev['f' + r.totalFace]++;
        // 牌型勝率（和局不列入）
        if (res !== 'P') {
          const pw = this.winByType.player[pt] || (this.winByType.player[pt] = { win: 0, total: 0 });
          pw.total++; if (res === 'W') pw.win++;
          const bw = this.winByType.banker[dt] || (this.winByType.banker[dt] = { win: 0, total: 0 });
          bw.total++; if (res === 'L') bw.win++;
        }
        if (log) log.players.push({ hand: hand.map(KS.cardText), type: pt, res, main: r.main, side: sideNet, bet: bets.main });
      });
      if (log) this.logs.push(log);
      shoe.endRound();
    }
    finish() { this.players.forEach(p => p.streak.finish()); }
  }

  KS.SG = { ORDER, evaluate, isFlush, isStraight, isStraightRanks, typeName, compare, HAND_TYPES, DEFAULT_ODDS, BET_KEYS, BET_LABEL, settle, vsDealer, nextHandProbs, betEV, Simulator };

  /* ================================================================ */
  /* UI                                                               */
  /* ================================================================ */
  KS.SG.init = function (opt) {
    const ui = KS.ui, h = ui.h, store = KS.store;
    const mount = typeof opt.mount === 'string' ? ui.$(opt.mount) : opt.mount;
    const S = {
      odds: Object.assign({}, DEFAULT_ODDS, store.get('ks_sg_odds', {})),
      counts: store.get('ks_sg_counts', KS.standardCounts(1)),
      decks: store.get('ks_sg_decks', 1),
      pen: store.get('ks_sg_pen', 75),
      shuffleMode: store.get('ks_sg_shuffle_v2', 'round'), // 預設：每局洗牌
      seq: store.get('ks_sg_seq', [500, 700, 900, 1400, 2000, 2900, 5000])
    };
    const clsNum = n => (n > 1e-9 ? 'pos' : n < -1e-9 ? 'neg' : '');
    const pct = (x, d) => (x * 100).toFixed(d == null ? 2 : d) + '%';
    const sel = (opts, v, on) => { const s = h('select', { onchange: () => on && on(s.value) }, opts.map(o => h('option', { value: o[0], text: o[1] }))); s.value = v; return s; };

    // Google 試算表：三公只讀取個人的智慧下注序列
    const sheet = KS.auth ? KS.auth.forGame('sangong') : null;
    if (sheet && sheet.seq.length) S.seq = sheet.seq.slice();
    mount.innerHTML = '';
    if (KS.auth) KS.auth.topBar(mount, 'sangong');
    mount.appendChild(h('h1', { text: '🃏 三公機率模擬器' }));
    const tabs = ui.tabs(mount, [{ key: 'sim', label: '📊 模擬' }, { key: 'play', label: '🎮 逐局遊戲' }, { key: 'rules', label: '⚙️ 賠率與牌組' }],
      k => { if (k === 'play') game.render(); });

    /* ---------- 賠率與牌組 ---------- */
    (function (pane) {
      const oddsBox = h('div', { class: 'panel' }, h('h3', { text: '賠率（淨賠率，例如 90 表示中獎拿回 注×91）' }));
      const L = {
        mainSix: '主注 6 點贏只賠（倍）', bigTiger: '大老虎（6點+2公）', smallTiger: '小老虎（6點+1公）', sixWin0: '老虎：6點+0公', sixWin1: '老虎：6點+1公', sixWin2: '老虎：6點+2公',
        flush: '特殊牌組：同花', straight: '特殊牌組：順子', straightFlush: '特殊牌組：同花順', face4: '公牌：合計 4 公', face5: '公牌：合計 5 公', face6: '公牌：合計 6 公'
      };
      Object.keys(L).forEach(k => {
        const inp = h('input', { type: 'number', step: 0.1, value: S.odds[k], onchange: () => { S.odds[k] = parseFloat(inp.value) || 0; store.set('ks_sg_odds', S.odds); } });
        oddsBox.appendChild(h('div', { class: 'row' }, h('label', null, inp, ' ' + L[k])));
      });
      oddsBox.appendChild(h('small', { class: 'muted', text: '老虎系列只看自己是否 6 點，不需要贏莊家。公牌投注以「玩家 + 莊家」的公牌總數計算。順子：A-2-3 … J-Q-K、Q-K-A 都算。' }));
      oddsBox.appendChild(h('div', { class: 'row' }, h('button', { class: 'btn-ghost', text: '還原預設賠率', onclick: () => { S.odds = Object.assign({}, DEFAULT_ODDS); store.set('ks_sg_odds', S.odds); location.reload(); } })));
      pane.appendChild(oddsBox);
      const deckBox = h('div', { class: 'panel' }, h('h3', { text: '牌組（每個點數張數可自訂，花色平均分配）' }));
      const zero = () => Object.fromEntries(RANKS.map(r => [r, 0]));
      const ed = ui.compositionEditor(deckBox, {
        counts: S.counts, decks: S.decks,
        presets: [
          { label: '標準 52 張', fn: d => KS.standardCounts(d) },
          { label: '只留公牌與 10', fn: d => { const c = zero(); ['10', 'J', 'Q', 'K'].forEach(r => { c[r] = 4 * d; }); return c; } },
          { label: '拿掉公牌', fn: d => { const c = KS.standardCounts(d); ['J', 'Q', 'K'].forEach(r => { c[r] = 0; }); return c; } },
          { label: '清空', fn: () => zero() }
        ],
        onChange: c => { S.counts = c; store.set('ks_sg_counts', c); }
      });
      ed.decksInput.addEventListener('change', () => { S.decks = +ed.decksInput.value || 1; store.set('ks_sg_decks', S.decks); });
      const pen = h('input', { type: 'number', min: 10, max: 100, value: S.pen, onchange: () => { S.pen = Math.min(100, Math.max(10, +pen.value || 75)); store.set('ks_sg_pen', S.pen); } });
      pen.disabled = S.shuffleMode === 'round';
      const shufChk = h('input', { type: 'checkbox', checked: S.shuffleMode === 'round', onchange: () => {
        S.shuffleMode = shufChk.checked ? 'round' : 'shoe';
        store.set('ks_sg_shuffle_v2', S.shuffleMode);
        pen.disabled = shufChk.checked;
      } });
      deckBox.appendChild(h('div', { class: 'row' }, h('label', null, shufChk, ' 每局結束後，將桌上的牌放回牌池重新洗牌（取消勾選 = 牌不放回，發到切牌卡才洗；要練算牌請取消勾選）')));
      deckBox.appendChild(h('div', { class: 'row' }, '切牌卡位置（沒有勾選「每局洗牌」時，發到幾 % 洗牌）', pen, '%'));
      pane.appendChild(deckBox);
    })(tabs.panes.rules);

    /* ---------- 模擬 ---------- */
    (function (pane) {
      const box = h('div');
      const players = [];
      const saved = store.get('ks_sg_players', [{ main: 500, special: 25, bigTiger: 25, smallTiger: 25, tiger: 25, face: 25 }]);
      const save = () => store.set('ks_sg_players', players.map(p => Object.fromEntries(BET_KEYS.map(k => [k, +p.inp[k].value || 0]))));
      function addPlayer(pre) {
        if (players.length >= 6) { alert('最多 6 人'); return; }
        pre = pre || { main: 500, special: 25, bigTiger: 25, smallTiger: 25, tiger: 25, face: 25 };
        const p = { inp: {} };
        const row = h('div', { class: 'row' }, h('b', { text: `玩家${players.length + 1}` }));
        BET_KEYS.forEach(k => { p.inp[k] = h('input', { type: 'number', min: 0, value: pre[k] || 0, onchange: save }); row.appendChild(h('label', null, BET_LABEL[k], p.inp[k])); });
        p.row = row; players.push(p); box.appendChild(row); save();
      }
      saved.forEach(addPlayer);
      const smart = h('input', { type: 'checkbox', checked: store.get('ks_sg_smart', false), onchange: () => store.set('ks_sg_smart', smart.checked) });
      const seq = h('input', { type: 'text', value: S.seq.join(','), style: { width: '320px' }, onchange: () => { S.seq = seq.value.split(/[,，\s]+/).map(x => parseInt(x, 10)).filter(x => x > 0); store.set('ks_sg_seq', S.seq); seq.value = S.seq.join(','); } });
      const rounds = h('input', { type: 'number', min: 1, value: store.get('ks_sg_rounds', 100000), onchange: () => store.set('ks_sg_rounds', +rounds.value) });
      const logLimit = h('input', { type: 'number', min: 0, value: 200 });
      const bar = h('div'); const prog = h('div', { class: 'progress' }, bar); const progText = h('span', { class: 'muted' });
      const runBtn = h('button', { text: '▶ 開始模擬', onclick: run });
      let stop = false;
      const stopBtn = h('button', { class: 'btn-danger', text: '■ 停止', disabled: true, onclick: () => { stop = true; } });
      const out = h('div');
      pane.appendChild(h('div', { class: 'panel' }, h('h3', { text: '玩家投注' }), box,
        h('div', { class: 'row' },
          h('button', { class: 'btn-small', text: '＋ 新增玩家', onclick: () => addPlayer() }),
          h('button', { class: 'btn-small', text: '－ 刪除最後一位', onclick: () => { if (players.length <= 1) { alert('至少需要 1 位玩家'); return; } players.pop().row.remove(); save(); } })),
        h('div', { class: 'row' }, h('label', null, smart, '啟用智慧下注（主注：贏往下一階、輸回第一階、和局不變）'), seq, sheet && sheet.seq.length ? h('b', { text: '（由試算表指定）' }) : null),
        h('div', { class: 'row' }, '模擬局數', rounds, '　記錄前', logLimit, '局過程'),
        h('div', { class: 'row' }, runBtn, stopBtn, prog, progText)));
      pane.appendChild(out);

      async function run() {
        let sim;
        try {
          sim = new Simulator({
            counts: S.counts, penetration: S.pen / 100, shuffleEveryRound: S.shuffleMode === 'round', odds: Object.assign({}, S.odds),
            players: players.map(p => ({ bets: Object.fromEntries(BET_KEYS.map(k => [k, Math.max(0, +p.inp[k].value || 0)])) })),
            smartBet: { on: smart.checked, seq: S.seq.slice() }, logLimit: Math.max(0, +logLimit.value || 0)
          });
          if (sim.shoe.total < (players.length + 1) * 3) throw new Error(`牌組至少需要 ${(players.length + 1) * 3} 張`);
        } catch (e) { alert(e.message); return; }
        const n = Math.max(1, +rounds.value || 1);
        stop = false; runBtn.disabled = true; stopBtn.disabled = false;
        const t0 = Date.now();
        try {
          const r = await KS.runChunked(n, () => sim.step(), { shouldStop: () => stop, onProgress: (i, t) => { bar.style.width = (i / t * 100) + '%'; progText.textContent = `${i.toLocaleString()} / ${t.toLocaleString()} 局`; } });
          sim.finish();
          progText.textContent = `${r.stopped ? '已停止，' : '完成，'}共 ${sim.round.toLocaleString()} 局，${((Date.now() - t0) / 1000).toFixed(1)} 秒`;
          render(sim);
        } catch (e) { console.error(e); alert('模擬錯誤：' + e.message); }
        finally { runBtn.disabled = false; stopBtn.disabled = true; }
      }

      function render(sim) {
        const R = sim.round;
        let t = `<div class="panel"><h3>主注統計（${R.toLocaleString()} 局）</h3><div class="table-wrap"><table><tr><th>玩家</th><th>勝/和/負</th><th>勝率(不含和)</th><th>和局率</th>
          <th>主注盈虧</th><th>每局EV(主注)</th><th>95%信賴區間</th><th>特殊投注盈虧</th><th>合計盈虧</th><th>最大回撤</th><th>最長連勝</th><th>最長連輸</th></tr>`;
        sim.players.forEach((s, i) => {
          const ci = s.acc.ci95();
          t += `<tr><td>玩家${i + 1}</td><td>${s.W}/${s.P}/${s.L}</td><td>${ui.pct(s.W, s.W + s.L)}</td><td>${ui.pct(s.P, R, 3)}</td>
            <td class="${clsNum(s.main)}">${ui.signed(s.main)}</td><td class="${clsNum(s.acc.mean())}">${pct(s.acc.mean())}</td><td>${pct(ci[0])} ~ ${pct(ci[1])}</td>
            <td class="${clsNum(s.sideNet)}">${ui.signed(s.sideNet)}</td><td class="${clsNum(s.main + s.sideNet)}">${ui.signed(s.main + s.sideNet)}</td>
            <td>${ui.fmt(s.bank.maxDD)}</td><td>${s.streak.maxWin}</td><td>${s.streak.maxLose}</td></tr>`;
        });
        t += '</table></div></div>';
        t += `<div class="panel"><h3>特殊投注統計</h3><div class="table-wrap"><table><tr><th>玩家</th>${BET_KEYS.filter(k => k !== 'main').map(k => `<th>${BET_LABEL[k]}<br><small>中獎率 / 盈虧 / 回報率</small></th>`).join('')}</tr>`;
        sim.players.forEach((s, i) => {
          t += `<tr><td>玩家${i + 1}</td>` + BET_KEYS.filter(k => k !== 'main').map(k => {
            const x = s.side[k];
            return `<td>${ui.pct(x.hits, R, 3)}<br><span class="${clsNum(x.net)}">${ui.signed(x.net)}</span><br><small>${x.wager ? pct(x.net / x.wager) : '-'}</small></td>`;
          }).join('') + '</tr>';
        });
        t += '</table></div><h4>特殊事件次數</h4><div class="table-wrap"><table><tr><th>玩家</th><th>6點+0公</th><th>6點+1公</th><th>6點+2公</th><th>同花</th><th>順子</th><th>同花順</th><th>合計4公</th><th>合計5公</th><th>合計6公</th></tr>';
        sim.players.forEach((s, i) => {
          const e = s.ev;
          t += `<tr><td>玩家${i + 1}</td>${[e.six0, e.six1, e.six2, e.flush, e.straight, e.sf, e.f4, e.f5, e.f6].map(v => `<td>${v}<br><small>${ui.pct(v, R, 3)}</small></td>`).join('')}</tr>`;
        });
        t += '</table></div></div>';
        sim.players.forEach((s, i) => {
          t += `<div class="panel"><details ${i === 0 ? 'open' : ''}><summary><b>玩家${i + 1}：連勝連輸與路單</b></summary>
            <div class="table-wrap">${ui.streakTableHtml('玩家' + (i + 1), s.streak)}</div><h4>路單（前 ${s.road.length} 局）</h4>${ui.roadHtml(s.road, 600)}</details></div>`;
        });
        t += `<div class="panel"><h3>牌型機率</h3><div class="table-wrap"><table><tr><th>牌型</th><th>莊家</th>${sim.players.map((_, i) => `<th>玩家${i + 1}</th>`).join('')}<th>玩家牌型勝率</th><th>莊家牌型勝率</th></tr>`;
        HAND_TYPES.forEach(ty => {
          const pw = sim.winByType.player[ty], bw = sim.winByType.banker[ty];
          t += `<tr><td>${ty}</td><td>${ui.pct(sim.types.banker[ty] || 0, R, 3)}</td>${sim.players.map((_, i) => `<td>${ui.pct(sim.types['p' + i][ty] || 0, R, 3)}</td>`).join('')}
            <td>${pw ? ui.pct(pw.win, pw.total) : '-'}</td><td>${bw ? ui.pct(bw.win, bw.total) : '-'}</td></tr>`;
        });
        t += '</table></div><small class="muted">牌型勝率不含和局。</small></div>';
        out.innerHTML = t;
        out.appendChild(h('div', { class: 'panel' }, h('button', { class: 'btn-ghost', text: `🔍 查看模擬過程（前 ${sim.logs.length} 局）`, onclick: () => ui.logViewer('模擬過程', sim.logs.map(fmtLog)) })));
      }
    })(tabs.panes.sim);

    function fmtLog(l) {
      return `<div class="log-row"><b>第${l.round}局</b>　莊家 ${l.dealer.join(' ')}（${l.dType}）<br>` +
        l.players.map((p, i) => `玩家${i + 1} ${p.hand.join(' ')}（${p.type}）<span style="color:${p.res === 'W' ? '#1a8f4c' : p.res === 'L' ? '#c43c3c' : '#8a6d00'}">${{ W: '勝', L: '負', P: '和' }[p.res]}</span> 主注 ${ui.signed(p.main)}　特殊 ${ui.signed(p.side)}`).join('<br>') + '</div>';
    }

    /* ---------- 逐局遊戲 ---------- */
    const game = (function (pane) {
      let shoe = null, round = null, no = 0;
      const hist = [];
      const sess = { n: 0, W: 0, L: 0, P: 0, main: 0, side: 0, streak: new KS.StreakTracker(10), road: [], sideHits: {} };
      const nP = sel([['1', '1 位'], ['2', '2 位'], ['3', '3 位'], ['4', '4 位'], ['5', '5 位'], ['6', '6 位']], '1');
      const betInp = {};
      const betRow = h('div', { class: 'row' }, '每位下注：');
      BET_KEYS.forEach(k => { betInp[k] = h('input', { type: 'number', min: 0, value: k === 'main' ? 500 : 25 }); betRow.appendChild(h('label', null, BET_LABEL[k], betInp[k])); });
      const dealBtn = h('button', { class: 'btn-good', text: '🂠 發牌 (Enter)', onclick: deal });
      const openBtn = h('button', { text: '👀 開莊家牌 (Space)', disabled: true, onclick: reveal });
      const table = h('div', { class: 'felt' });
      const info = h('div'); const stats = h('div');
      pane.appendChild(h('div', { class: 'panel' }, h('div', { class: 'row' }, '座位數', nP,
        h('button', { class: 'btn-small', text: '重新洗牌', onclick: () => { if (round && !round.done) return; newShoe(); render(); } }),
        h('button', { class: 'btn-small', text: '🔍 查看遊戲過程', onclick: () => ui.logViewer('遊戲過程', hist.slice().reverse().map(fmtLog)) })), betRow));
      pane.appendChild(h('div', { class: 'grid2' }, h('div', null, h('div', { class: 'panel' }, table, h('div', { class: 'actions' }, dealBtn, openBtn)), stats), info));

      function newShoe() {
        try { shoe = new KS.Shoe({ counts: S.counts, penetration: S.pen / 100, withSuits: true }); } catch (e) { alert(e.message); shoe = null; }
      }
      const bets = () => Object.fromEntries(BET_KEYS.map(k => [k, Math.max(0, +betInp[k].value || 0)]));
      function deal() {
        if (round && !round.done) return;
        if (!shoe) newShoe(); if (!shoe) return;
        if (S.shuffleMode === 'round' || shoe.needsShuffle()) shoe.shuffle();
        const n = +nP.value;
        if (shoe.total < (n + 1) * 3) { alert('牌組張數不足'); return; }
        no++;
        round = { no, hands: [], done: false, bets: bets() };
        for (let i = 0; i < n; i++) round.hands.push([shoe.draw(), shoe.draw(), shoe.draw()]);
        round.rem = shoe.remaining();
        render();
      }
      function reveal() {
        if (!round || round.done) return;
        round.dealer = [shoe.draw(), shoe.draw(), shoe.draw()];
        const de = evaluate(round.dealer);
        round.res = round.hands.map(hd => settle(hd, de, round.bets, S.odds));
        round.done = true;
        shoe.endRound();
        const log = { round: round.no, dealer: round.dealer.map(KS.cardText), dType: typeName(de), players: [] };
        round.res.forEach((r, i) => {
          const res = r.cmp > 0 ? 'W' : r.cmp < 0 ? 'L' : 'P';
          const sideNet = Object.values(r.side).reduce((a, b) => a + b, 0);
          sess.n++; sess[res]++; sess.main += r.main; sess.side += sideNet; sess.streak.push(res); sess.road.push(res);
          Object.keys(r.hits).forEach(k => { const x = sess.sideHits[k] || (sess.sideHits[k] = { n: 0, hit: 0, net: 0 }); x.n++; if (r.hits[k]) x.hit++; x.net += r.side[k]; });
          log.players.push({ hand: round.hands[i].map(KS.cardText), type: typeName(r.e), res, main: r.main, side: sideNet });
        });
        hist.push(log);
        render();
      }
      document.addEventListener('keydown', e => {
        if (tabs.panes.play.style.display === 'none') return;
        if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
        if (e.key === 'Enter') { e.preventDefault(); if (round && !round.done) reveal(); else deal(); }
        else if (e.code === 'Space') { e.preventDefault(); reveal(); }
      });

      function remainingPanel() {
        const rem = shoe.remaining();
        const fc = rem.J + rem.Q + rem.K, ten = rem['10'], small = RANKS.filter(r => !isFaceR(r) && r !== '10').reduce((a, r) => a + rem[r], 0);
        const tot = shoe.size();
        return `<table class="mini"><tr>${RANKS.map(r => `<th>${r}</th>`).join('')}</tr><tr>${RANKS.map(r => `<td class="${rem[r] ? '' : 'zero'}">${rem[r]}</td>`).join('')}</tr></table>
          <div class="bs-bar"><span class="tag big">公牌(J/Q/K)：${fc}（${ui.pct(fc, tot, 1)}）</span><span class="tag mid">10：${ten}</span>
          <span class="tag small">A-9：${small}（${ui.pct(small, tot, 1)}）</span><span class="tag">剩 ${tot} 張</span></div>`;
      }
      function render() {
        if (!shoe) newShoe(); if (!shoe) return;
        let t = '<h4>莊家</h4>';
        if (!round) t += '<span class="muted">按「發牌」開始</span>';
        else if (!round.done) t += ui.cardHtml(null, true).repeat(3);
        else { const de = evaluate(round.dealer); t += round.dealer.map(c => ui.cardHtml(c)).join('') + ` <span class="sum">${typeName(de)}</span>`; }
        if (round) round.hands.forEach((hd, i) => {
          const e = evaluate(hd);
          let res = '';
          if (round.done) {
            const r = round.res[i];
            const k = r.cmp > 0 ? 'W' : r.cmp < 0 ? 'L' : 'P';
            const sideNet = Object.values(r.side).reduce((a, b) => a + b, 0);
            const hits = Object.keys(r.hits).filter(x => r.hits[x]).map(x => BET_LABEL[x]).join('、');
            res = ` <span class="res-${k}">${{ W: '勝', L: '負', P: '和' }[k]} 主注 ${ui.signed(r.main)}、特殊 ${ui.signed(sideNet)}${hits ? '（中：' + hits + '）' : ''}</span>`;
          }
          t += `<div class="seat"><h4>玩家${i + 1}　${typeName(e)}${isFlush(hd) ? '・同花' : ''}${isStraight(hd) ? '・順子' : ''}${res}</h4>${hd.map(c => ui.cardHtml(c)).join('')}</div>`;
        });
        table.innerHTML = t;
        dealBtn.disabled = !!(round && !round.done);
        openBtn.disabled = !(round && !round.done);

        let inf = `<div class="panel"><h3>牌組剩餘</h3>${remainingPanel()}</div>`;
        if (round && !round.done) {
          inf += '<div class="panel"><h3>目前手牌 vs 莊家（依剩餘牌精確計算）</h3><div class="table-wrap"><table><tr><th>玩家</th><th>主注 勝</th><th>和</th><th>負</th><th>公牌投注中獎率</th></tr>';
          round.hands.forEach((hd, i) => {
            const v = vsDealer(hd, shoe.remaining());
            const pf = v.pe.face;
            const faceHit = [0, 1, 2, 3].reduce((a, df) => a + (pf + df >= 4 ? v.dFace[df] : 0), 0);
            inf += `<tr><td>玩家${i + 1}</td><td class="best">${pct(v.W, 1)}</td><td>${pct(v.P, 1)}</td><td>${pct(v.L, 1)}</td><td>${pct(faceHit, 2)}</td></tr>`;
          });
          inf += '</table></div></div>';
        } else if (shoe.size() >= 6) {
          const t0 = Date.now();
          const pr = nextHandProbs(shoe.cards);
          const ev = betEV(pr, S.odds);
          inf += `<div class="panel"><h3>下一手的機率與 EV（依剩餘牌精確計算）</h3><div class="table-wrap"><table><tr><th>投注</th><th>中獎/贏率</th><th>每注 EV</th></tr>
            ${BET_KEYS.map(k => `<tr><td>${BET_LABEL[k]}</td><td>${pct(ev.hit[k], 3)}</td><td class="${clsNum(ev[k])}">${pct(ev[k])}</td></tr>`).join('')}</table></div>
            <small class="muted">主注：勝 ${pct(pr.W)}／和 ${pct(pr.P)}／負 ${pct(pr.L)}。同花 ${pct(pr.flush, 3)}、順子 ${pct(pr.straight, 3)}、同花順 ${pct(pr.straightFlush, 3)}。（${Date.now() - t0} ms）</small></div>`;
        }
        info.innerHTML = inf;

        const st = sess.streak;
        stats.innerHTML = `<div class="panel"><h3>本場統計</h3><div class="stat-grid">
          <div class="stat"><b>${sess.n}</b><span>手數</span></div><div class="stat"><b>${sess.W}/${sess.P}/${sess.L}</b><span>勝/和/負</span></div>
          <div class="stat"><b>${ui.pct(sess.W, sess.W + sess.L)}</b><span>勝率（不含和）</span></div>
          <div class="stat"><b class="${clsNum(sess.main)}">${ui.signed(sess.main)}</b><span>主注盈虧</span></div>
          <div class="stat"><b class="${clsNum(sess.side)}">${ui.signed(sess.side)}</b><span>特殊投注盈虧</span></div>
          <div class="stat"><b>${st.cur > 0 ? '連勝 ' + st.cur : st.cur < 0 ? '連輸 ' + (-st.cur) : '-'}</b><span>目前連續</span></div>
          <div class="stat"><b>${st.maxWin} / ${st.maxLose}</b><span>最長連勝 / 連輸</span></div></div>
          ${Object.keys(sess.sideHits).length ? `<h4>特殊投注</h4><table><tr><th>投注</th><th>次數</th><th>中獎</th><th>盈虧</th></tr>${Object.keys(sess.sideHits).map(k => { const x = sess.sideHits[k]; return `<tr><td>${BET_LABEL[k]}</td><td>${x.n}</td><td>${x.hit}</td><td class="${clsNum(x.net)}">${ui.signed(x.net)}</td></tr>`; }).join('')}</table>` : ''}
          <h4>路單</h4>${ui.roadHtml(sess.road.slice(-300))}</div>`;
      }
      return { render };
    })(tabs.panes.play);

    const last = store.get('ks_tab_' + location.pathname, null);
    if (last && tabs.panes[last]) tabs.show(last);
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = KS;
})(typeof window !== 'undefined' ? window : globalThis);
