/* ==========================================================================
   ks-blackjack.js — 21 點引擎（美式 / 英式 / 麗星郵輪22點 共用，規則物件驅動）
   - Round：一局的狀態機（發牌 → 玩家逐手行動 → 莊家補牌一次 → 統一結算）
   - decide：依策略表（相容舊版 ks_rules.json）決定動作
   - EV：依剩餘牌組組成計算各動作 EV 與勝/和/輸機率
   - Simulator：大量模擬與統計（不碰 DOM，可在 Node 測試）
   ========================================================================== */
(function (root) {
  'use strict';
  const KS = root.KS || (typeof require !== 'undefined' ? require('./ks-core.js') : null);
  if (!KS) throw new Error('需要先載入 ks-core.js');
  const { bjValue, rankOf, idx10, RANKS } = KS;

  /* ---------------- 規則預設 ---------------- */
  const BASE_RULES = {
    dealerHitSoft17: false,     // 莊家軟 17 是否要補
    bjPayout: 1.5,              // BJ 淨賠率（3:2）
    winPayout: 1,               // 一般贏淨賠率
    surrenderLoss: 0.5,         // 投降輸掉注碼比例
    evenMoney: false,           // 玩家 BJ 且莊明牌 A/10 時可先收 1 倍
    bjPaidImmediately: false,   // 玩家 BJ 立即賠（不看莊家是否 BJ）
    bjVsDealerBJ: 'push',       // 'push' 和局 | 'pay' 照賠
    any21Wins: false,           // 非 BJ 的 21 點必勝（含對莊 BJ）
    bonus777: false,            // 三張 777 / 678 的 21 點加賠
    bonus777Pay: 1.5,
    aaSplitVsBJHalf: false,     // 莊明牌 A 且 BJ 時，AA 分牌未爆的手只輸半注
    dealerBJOriginalOnly: false,// 莊 BJ 時只輸原注（加倍/分牌追加退回）
    dealer22Push: false,        // 莊家最終 22 點整桌平手（>22 才算爆）
    maxHands: 4,                // 一位玩家最多幾手（分牌上限）
    resplitAces: true,
    splitAcesOneCard: true,     // AA 分牌後各一張，不能再要牌/加倍
    splitByValue: false,        // true：10/J/Q/K 同值即可分
    das: true,                  // 分牌後可加倍
    freeDouble: false,          // 兩張硬 9/10/11 免費加倍（22點）
    surrender: 'any2',          // 'any2' 任何未要牌的兩張 | 'first' 只限第一個動作 | 'none'
    surrenderAfterDouble: false // 加倍後投降
  };

  const PRESETS = {
    american: Object.assign({}, BASE_RULES, {
      name: '美式21點', dealerHitSoft17: false, evenMoney: true, bjVsDealerBJ: 'push',
      bonus777: true, maxHands: 7, surrender: 'any2'
    }),
    british: Object.assign({}, BASE_RULES, {
      name: '英式21點', dealerHitSoft17: true, bjPaidImmediately: true, bjVsDealerBJ: 'pay',
      any21Wins: true, bonus777: true, aaSplitVsBJHalf: true, maxHands: 3,
      surrender: 'any2', surrenderAfterDouble: true, defaultNo10: true
    }),
    star22: Object.assign({}, BASE_RULES, {
      name: '麗星郵輪22點', dealerHitSoft17: true, evenMoney: true, bjVsDealerBJ: 'push',
      dealerBJOriginalOnly: true, dealer22Push: true, maxHands: 4, resplitAces: false,
      splitAcesOneCard: false, das: true, freeDouble: true, surrender: 'first'
    })
  };

  // 規則說明（UI 用）
  const RULE_FIELDS = [
    ['dealerHitSoft17', 'bool', '莊家軟 17 要補牌（補到硬 17 / 軟 18 才停）'],
    ['bjPayout', 'num', 'BJ 淨賠率（1.5 = 3:2）'],
    ['winPayout', 'num', '一般贏淨賠率'],
    ['surrenderLoss', 'num', '投降輸掉的比例（0.5 = 退半注）'],
    ['evenMoney', 'bool', '玩家 BJ 且莊明牌 A/10/J/Q/K 時，可選擇先收 1 倍結束'],
    ['bjPaidImmediately', 'bool', '玩家 BJ 立即賠付（不等莊家）'],
    ['bjVsDealerBJ', ['push', 'pay'], '玩家 BJ 對莊家 BJ：push=和局，pay=照賠'],
    ['any21Wins', 'bool', '非 BJ 的 21 點必勝（含對莊家 BJ）'],
    ['bonus777', 'bool', '三張 777 / 678 組成 21 點加賠'],
    ['bonus777Pay', 'num', '777 / 678 淨賠率'],
    ['aaSplitVsBJHalf', 'bool', '莊明牌 A 拿到 BJ 時，AA 分牌後未爆的手只輸半注'],
    ['dealerBJOriginalOnly', 'bool', '莊家 BJ 時只輸原注（加倍、分牌追加的注退回）'],
    ['dealer22Push', 'bool', '莊家 22 點整桌平手（超過 22 才算爆牌）'],
    ['maxHands', 'num', '分牌上限：一位玩家最多幾手'],
    ['resplitAces', 'bool', 'AA 可再分牌'],
    ['splitAcesOneCard', 'bool', 'AA 分牌後各補一張就停（不能再要牌/加倍）'],
    ['splitByValue', 'bool', '10/J/Q/K 同值即可分牌（關閉 = 必須同點數）'],
    ['das', 'bool', '分牌後可加倍'],
    ['freeDouble', 'bool', '兩張硬 9/10/11 免費加倍（贏賠 2 倍注、輸只輸原注，其他加倍自費）'],
    ['surrender', ['any2', 'first', 'none'], '投降：any2=任何未要牌兩張（含分牌後）；first=只限第一個動作；none=不可'],
    ['surrenderAfterDouble', 'bool', '加倍後可投降（退回原注）']
  ];

  /* ---------------- 手牌計算 ---------------- */
  function handInfo(cards) {
    let sum = 0, aces = 0;
    for (let i = 0; i < cards.length; i++) {
      const v = bjValue(cards[i]);
      if (v === 11) { aces++; sum += 1; } else sum += v;
    }
    const soft = aces > 0 && sum + 10 <= 21;
    return { total: soft ? sum + 10 : sum, soft, hard: sum };
  }
  const handTotal = cards => handInfo(cards).total;
  const isTwoCard21 = cards => cards.length === 2 && handTotal(cards) === 21;
  const isTen = c => bjValue(c) === 10;
  function is777or678(cards) {
    if (cards.length !== 3) return false;
    const r = cards.map(rankOf).sort().join(',');
    return r === '7,7,7' || r === '6,7,8';
  }
  const dealerUpValue = c => bjValue(c); // 2..11

  /* ---------------- 一局（狀態機） ---------------- */
  class Round {
    /**
     * @param {object} game { rules, shoe }
     * @param {Array} seats [{ bet, fixed: [r1|null, r2|null] }]
     * @param {object} opt { dealerUp: rank|null }
     */
    constructor(game, seats, opt) {
      this.rules = game.rules;
      this.shoe = game.shoe;
      this.opt = opt || {};
      this.seats = seats.map((s, i) => ({ idx: i, bet: s.bet, fixed: s.fixed || [], hands: [], net: 0, evenMoney: false }));
      this.dealer = [];
      this.phase = 'deal';
      this.warnings = [];
      this.cur = null; // {s, h}
    }
    _take(rank) {
      if (!rank) return this.shoe.draw();
      const c = this.shoe.take(rank);
      if (!c) { this.warnings.push(`牌靴已沒有 ${rank}，改發隨機牌`); return this.shoe.draw(); }
      return c;
    }
    _newHand(seat, cards, extra) {
      return Object.assign({
        cards, base: seat.bet, stake: seat.bet, winMult: 1, doubled: false, freeDouble: false,
        fromSplit: false, splitAces: false, fromAA: false, surrendered: false, bust: false,
        done: false, hitOnce: false, pendingEven: false, pendingDA: false, isBJ: false,
        actions: [], profit: 0, result: null
      }, extra || {});
    }
    // 發牌順序：每位玩家一張 → 莊家明牌 → 每位玩家第二張（莊家第二張等玩家都結束才發）
    start() {
      const first = this.seats.map(s => this._take(s.fixed[0]));
      this.dealer.push(this._take(this.opt.dealerUp));
      this.seats.forEach((s, i) => {
        const h = this._newHand(s, [first[i], this._take(s.fixed[1])]);
        h.fromAA = rankOf(h.cards[0]) === 'A' && rankOf(h.cards[1]) === 'A';
        if (isTwoCard21(h.cards)) {
          h.isBJ = true;
          const up = dealerUpValue(this.dealer[0]);
          if (this.rules.evenMoney && (up === 11 || up === 10)) h.pendingEven = true;
          else h.done = true;
        }
        s.hands.push(h);
      });
      this.phase = 'player';
      this._advance();
      return this;
    }
    current() {
      if (!this.cur) return null;
      const seat = this.seats[this.cur.s];
      return { seat, hand: seat.hands[this.cur.h], seatIdx: this.cur.s, handIdx: this.cur.h };
    }
    _advance() {
      for (let s = 0; s < this.seats.length; s++) {
        const hs = this.seats[s].hands;
        for (let h = 0; h < hs.length; h++) if (!hs[h].done) { this.cur = { s, h }; return; }
      }
      this.cur = null;
      this.phase = 'dealer';
    }
    canPair(hand) {
      if (hand.cards.length !== 2) return false;
      const [a, b] = hand.cards;
      if (rankOf(a) === rankOf(b)) return true;
      return this.rules.splitByValue && isTen(a) && isTen(b);
    }
    legal(hand, seat) {
      const R = this.rules;
      if (!hand || hand.done) return {};
      if (hand.pendingEven) return { even: true, wait: true };
      if (hand.pendingDA) return { stand: true, surrender: true };
      const info = handInfo(hand.cards);
      const two = hand.cards.length === 2;
      const acesLocked = hand.splitAces && R.splitAcesOneCard;
      const L = { stand: true };
      L.hit = !acesLocked && info.total < 21;
      L.double = two && !hand.doubled && !acesLocked && (!hand.fromSplit || R.das) && info.total < 21;
      L.doubleFree = L.double && R.freeDouble && !info.soft && info.total >= 9 && info.total <= 11;
      L.split = two && this.canPair(hand) && seat.hands.length < R.maxHands &&
        !(rankOf(hand.cards[0]) === 'A' && hand.splitAces && !R.resplitAces);
      if (R.surrender === 'any2') L.surrender = two && !hand.hitOnce && !hand.doubled;
      else if (R.surrender === 'first') L.surrender = two && !hand.fromSplit && hand.actions.length === 0;
      else L.surrender = false;
      return L;
    }
    act(action) {
      const c = this.current();
      if (!c) throw new Error('目前沒有需要行動的手牌');
      const { seat, hand } = c;
      const L = this.legal(hand, seat);
      if (!L[action]) throw new Error('不合法的動作：' + action);
      const shoe = this.shoe;
      hand.actions.push(action);
      const after = () => {
        const t = handTotal(hand.cards);
        if (t > 21) { hand.bust = true; hand.done = true; }
        else if (t === 21) hand.done = true;
      };
      switch (action) {
        case 'even': hand.evenMoney = true; seat.evenMoney = true; hand.pendingEven = false; hand.done = true; break;
        case 'wait': hand.pendingEven = false; hand.done = true; break;
        case 'stand': hand.pendingDA = false; hand.done = true; break;
        case 'hit': hand.hitOnce = true; hand.cards.push(shoe.draw()); after(); break;
        case 'double': {
          if (L.doubleFree) { hand.freeDouble = true; hand.winMult = 2; }
          else hand.stake = hand.base * 2;
          hand.doubled = true;
          hand.cards.push(shoe.draw());
          after();
          if (!hand.done && this.rules.surrenderAfterDouble && !hand.freeDouble) hand.pendingDA = true;
          else hand.done = true;
          break;
        }
        case 'split': {
          const isA = rankOf(hand.cards[0]) === 'A';
          const c2 = hand.cards.pop();
          const nh = this._newHand(seat, [c2], { fromSplit: true, splitAces: isA, fromAA: hand.fromAA || isA });
          hand.fromSplit = true; hand.splitAces = isA; hand.fromAA = hand.fromAA || isA;
          hand.cards.push(shoe.draw());
          nh.cards.push(shoe.draw());
          seat.hands.splice(this.cur.h + 1, 0, nh);
          [hand, nh].forEach(x => { if (handTotal(x.cards) === 21) x.done = true; });
          break;
        }
        case 'surrender': hand.surrendered = true; hand.pendingDA = false; hand.done = true; break;
        default: throw new Error('未知動作 ' + action);
      }
      if (hand.done) this._advance();
      return this;
    }
    // 莊家：發第二張，若仍有需要比點數的手才繼續補牌
    playDealer() {
      if (this.phase !== 'dealer') throw new Error('玩家尚未全部結束');
      const R = this.rules;
      this.dealer.push(this.shoe.draw());
      this.dealerBJ = isTwoCard21(this.dealer);
      const live = this.seats.some(s => s.hands.some(h => !h.bust && !h.surrendered && !h.isBJ && !h.evenMoney));
      this.dealerPlayedOut = false;
      if (!this.dealerBJ && live) {
        for (;;) {
          const i = handInfo(this.dealer);
          if (i.total < 17 || (i.total === 17 && i.soft && R.dealerHitSoft17)) this.dealer.push(this.shoe.draw());
          else break;
        }
        this.dealerPlayedOut = true;
      }
      if (this.dealerBJ) this.dealerPlayedOut = true;
      this.phase = 'settle';
      this.settle();
      return this;
    }
    dealerOutcome() {
      const t = handTotal(this.dealer);
      if (this.dealerBJ) return 'BJ';
      if (!this.dealerPlayedOut) return null;
      if (t === 22 && this.rules.dealer22Push) return '22';
      if (t > 21) return 'bust';
      return String(t);
    }
    settle() {
      const R = this.rules;
      const dT = handTotal(this.dealer);
      const dBJ = this.dealerBJ;
      const d22 = R.dealer22Push && dT === 22 && !dBJ;
      const dBust = !dBJ && (R.dealer22Push ? dT > 22 : dT > 21);
      const upA = dealerUpValue(this.dealer[0]) === 11;
      this.seats.forEach(seat => {
        seat.net = 0;
        seat.hands.forEach(h => {
          const t = handTotal(h.cards);
          let p = 0, res;
          if (h.evenMoney) { p = h.base * 1; res = 'W'; h.note = '先收1倍'; }
          else if (h.isBJ) {
            if (R.bjPaidImmediately || !dBJ) { p = h.base * R.bjPayout; res = 'W'; }
            else if (R.bjVsDealerBJ === 'pay') { p = h.base * R.bjPayout; res = 'W'; }
            else { p = 0; res = 'P'; }
            h.note = 'BJ';
          } else if (h.surrendered) { p = -h.stake * R.surrenderLoss; res = 'L'; h.note = '投降'; }
          else if (h.bust) { p = -h.stake; res = 'L'; h.note = '爆牌'; }
          else if (dBJ) {
            if (R.any21Wins && t === 21) { p = h.stake * h.winMult * R.winPayout; res = 'W'; h.note = '21點必勝'; }
            else if (R.aaSplitVsBJHalf && h.fromAA && h.fromSplit && upA) { p = -h.stake * 0.5; res = 'L'; h.note = 'AA分牌對BJ輸半注'; }
            else { p = -h.stake; res = 'L'; h.note = '莊BJ'; }
          } else {
            const bonus = R.bonus777 && t === 21 && is777or678(h.cards);
            const win = amt => { p = h.stake * h.winMult * amt; res = 'W'; };
            if (bonus) { win(R.bonus777Pay); h.note = '777/678獎金'; }
            else if (d22) { p = 0; res = 'P'; h.note = '莊22平手'; }
            else if (dBust) win(R.winPayout);
            else if (R.any21Wins && t === 21) { win(R.winPayout); h.note = '21點必勝'; }
            else if (t > dT) win(R.winPayout);
            else if (t < dT) { p = -h.stake; res = 'L'; }
            else { p = 0; res = 'P'; }
          }
          h.profit = p; h.result = res;
          seat.net += p;
        });
        // 莊 BJ 只輸原注：追加的加倍/分牌注退回（已爆牌的仍輸）
        if (dBJ && R.dealerBJOriginalOnly) {
          const live = seat.hands.filter(h => !h.isBJ && !h.evenMoney && !h.surrendered && !h.bust);
          if (live.length) {
            const bustLoss = seat.hands.filter(h => h.bust).reduce((s, h) => s - h.profit, 0);
            const liveLoss = Math.max(seat.bet - bustLoss, 0);
            live.forEach((h, i) => {
              if (h.result === 'W') return; // any21Wins 的手維持
              h.profit = i === 0 ? -liveLoss : 0;
              h.result = i === 0 && liveLoss > 0 ? 'L' : 'P';
              h.note = '莊BJ只輸原注';
            });
            seat.net = seat.hands.reduce((s, h) => s + h.profit, 0);
          }
        }
        seat.result = seat.net > 1e-9 ? 'W' : seat.net < -1e-9 ? 'L' : 'P';
      });
      this.phase = 'done';
    }
  }

  /* ---------------- 策略 ---------------- */
  const DEALER_VALS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
  const range = (a, b) => { const o = []; for (let i = a; i <= b; i++) o.push(i); return o; };
  const perDealer = f => { const o = {}; DEALER_VALS.forEach(d => { o[d] = f(d); }); return o; };

  // 原檔的 KS 預設策略（美式/英式相同，英式多加倍後投降表）
  function ksDefaultStrategy(preset) {
    const pairs = {
      2: { split: [7, 8, 11], stand: [9, 10], double: [5], hit: [2, 3, 4, 6], surrender: [] },
      3: { split: [2, 3, 7, 8, 11], stand: [9, 10], double: [5], hit: [4, 6], surrender: [] },
      4: { split: [2, 3, 7, 8, 9, 11], stand: [10], double: [5], hit: [4, 6], surrender: [] },
      5: { split: [2, 3, 6, 7, 8, 9, 11], stand: [10], double: [5], hit: [4], surrender: [] },
      6: { split: [2, 3, 6, 7, 8, 9, 11], stand: [10], double: [5], hit: [4], surrender: [] },
      7: { split: [2, 3, 7, 8, 11], stand: [9, 10], double: [5], hit: [4, 6], surrender: [] },
      8: { split: [2, 3, 8, 9, 11], stand: [10], double: [5], hit: [4, 6, 7], surrender: [] },
      9: { split: [8, 9, 11], stand: [10], double: [], hit: [2, 3, 4, 5, 6, 7], surrender: [] },
      10: { split: [11], stand: [9, 10], double: [], hit: [2, 3, 4, 5, 6, 7, 8], surrender: [] },
      11: { split: [11], stand: [9, 10], double: [], hit: [2, 3, 4, 5, 6, 7, 8], surrender: [] }
    };
    const dbl = { 2: [10, 11], 3: [10, 11], 4: [10, 11], 5: [10, 11], 6: [9, 10, 11], 7: [10, 11], 8: [10, 11], 9: [11], 10: [], 11: [] };
    const hit = { 2: range(4, 14), 3: range(4, 14), 4: range(4, 13), 5: range(4, 13), 6: range(4, 12), 7: range(4, 16), 8: range(4, 16), 9: range(4, 16), 10: range(4, 16), 11: range(4, 17) };
    const soft = { 2: range(13, 17), 3: range(13, 17), 4: range(13, 17), 5: range(13, 17), 6: range(13, 17), 7: range(13, 17), 8: range(13, 17), 9: range(13, 18), 10: range(13, 18), 11: range(13, 18) };
    const stand = { 2: range(15, 21), 3: range(15, 21), 4: range(14, 21), 5: range(14, 21), 6: range(13, 21), 7: range(17, 21), 8: range(17, 21), 9: range(19, 21), 10: range(17, 21), 11: range(18, 21) };
    const da = preset === 'british' ? { 2: [], 3: [], 4: [], 5: [], 6: [], 7: range(2, 16), 8: range(2, 16), 9: range(2, 16), 10: range(2, 16), 11: range(2, 16) } : perDealer(() => []);
    return normalizeStrategy({
      name: 'KS 預設', pairRulesMap: pairs, doubleMap: dbl, hitMap: hit, softHitMap: soft,
      standMap: stand, surrenderMap: perDealer(() => []), dasurrenderMap: da
    });
  }

  // 正規化：相容舊版 ks_rules.json（doubleMap 同時用於軟硬牌 → 拆成 hardDoubleMap/softDoubleMap）
  function normalizeStrategy(o) {
    if (!o || typeof o !== 'object') throw new Error('策略格式錯誤');
    if (!o.pairRulesMap && !o.hitMap && !o.hardDoubleMap) throw new Error('JSON 缺少 pairRulesMap / hitMap，不是策略檔');
    const clone = x => JSON.parse(JSON.stringify(x || {}));
    const fix = m => { const r = {}; DEALER_VALS.forEach(d => { r[d] = Array.isArray(m && m[d]) ? m[d].map(Number) : []; }); return r; };
    const s = {
      name: o.name || (o.meta && o.meta.name) || '匯入策略',
      pairRulesMap: {},
      hardDoubleMap: fix(o.hardDoubleMap || o.doubleMap),
      softDoubleMap: fix(o.softDoubleMap || (o.doubleMap ? perDealer(d => (o.doubleMap[d] || []).filter(t => t >= 13)) : {})),
      hitMap: fix(o.hitMap), softHitMap: fix(o.softHitMap), standMap: fix(o.standMap),
      surrenderMap: fix(o.surrenderMap), dasurrenderMap: fix(o.dasurrenderMap),
      evenMoney: o.evenMoney || 'never', evenMoneyTC: o.evenMoneyTC == null ? 3 : +o.evenMoneyTC
    };
    const pr = clone(o.pairRulesMap);
    DEALER_VALS.forEach(d => {
      const x = pr[d] || {};
      s.pairRulesMap[d] = {};
      ['split', 'double', 'stand', 'hit', 'surrender'].forEach(k => { s.pairRulesMap[d][k] = Array.isArray(x[k]) ? x[k].map(Number) : []; });
    });
    if (o.builtin) s.builtin = o.builtin;
    if (o.evenMoneyMap) { s.evenMoneyMap = {}; Object.keys(o.evenMoneyMap).forEach(k => { s.evenMoneyMap[k] = !!o.evenMoneyMap[k]; }); }
    return s;
  }

  /* ---------------- 策略表格格子（UI 與試算表共用） ----------------
     硬牌：H S Dh Ds Rh Rs｜軟牌：H S Dh Ds｜對子：- P H S D R｜加倍後投降：- R｜保險：Y N */
  const cells = (function () {
    const rm = (arr, x) => { const i = arr.indexOf(x); if (i >= 0) arr.splice(i, 1); };
    const add = (arr, x) => { if (!arr.includes(x)) arr.push(x); arr.sort((a, b) => a - b); };
    function hardHit(s, t, d) {
      if ((s.standMap[d] || []).includes(t)) return false;
      const hm = s.hitMap[d] || [];
      return hm.length ? hm.includes(t) : t < 17;
    }
    function softHit(s, t, d) { const sh = s.softHitMap[d] || []; return sh.length ? sh.includes(t) : t < 18; }
    function hardCode(s, t, d) {
      const hit = hardHit(s, t, d);
      if ((s.surrenderMap[d] || []).includes(t)) return hit ? 'Rh' : 'Rs';
      if ((s.hardDoubleMap[d] || []).includes(t)) return hit ? 'Dh' : 'Ds';
      return hit ? 'H' : 'S';
    }
    function softCode(s, t, d) {
      const hit = softHit(s, t, d);
      if ((s.softDoubleMap[d] || []).includes(t)) return hit ? 'Dh' : 'Ds';
      return hit ? 'H' : 'S';
    }
    function pairCode(s, pv, d) {
      const pr = s.pairRulesMap[d] || {};
      if ((pr.split || []).includes(pv)) return 'P';
      if ((pr.double || []).includes(pv)) return 'D';
      if ((pr.surrender || []).includes(pv)) return 'R';
      if ((pr.stand || []).includes(pv)) return 'S';
      if ((pr.hit || []).includes(pv)) return 'H';
      return '-';
    }
    const daCode = (s, t, d) => ((s.dasurrenderMap[d] || []).includes(t) ? 'R' : '-');
    const evenCode = (s, d) => (s.evenMoneyMap && s.evenMoneyMap[d] ? 'Y' : 'N');
    function setHard(s, t, d, code) {
      [s.hitMap[d], s.standMap[d], s.hardDoubleMap[d], s.surrenderMap[d]].forEach(a => rm(a, t));
      add(code === 'H' || code.endsWith('h') ? s.hitMap[d] : s.standMap[d], t);
      if (code[0] === 'D') add(s.hardDoubleMap[d], t);
      if (code[0] === 'R') add(s.surrenderMap[d], t);
    }
    function setSoft(s, t, d, code) {
      rm(s.softHitMap[d], t); rm(s.softDoubleMap[d], t);
      if (code === 'H' || code === 'Dh') add(s.softHitMap[d], t);
      if (code[0] === 'D') add(s.softDoubleMap[d], t);
    }
    function setPair(s, pv, d, code) {
      const pr = s.pairRulesMap[d];
      ['split', 'double', 'surrender', 'stand', 'hit'].forEach(k => rm(pr[k], pv));
      const k = { P: 'split', D: 'double', R: 'surrender', S: 'stand', H: 'hit' }[code];
      if (k) add(pr[k], pv);
    }
    function setDA(s, t, d, code) { rm(s.dasurrenderMap[d], t); if (code === 'R') add(s.dasurrenderMap[d], t); }
    function setEven(s, d, code) { s.evenMoneyMap = s.evenMoneyMap || {}; s.evenMoneyMap[d] = code === 'Y'; }
    // 把 fallback（空陣列）展開成明確清單，逐格修改才不會改變其他格子的行為
    function materialize(s) {
      DEALER_VALS.forEach(d => {
        const hit = [], stand = [];
        for (let t = 4; t <= 21; t++) (hardHit(s, t, d) ? hit : stand).push(t);
        s.hitMap[d] = hit; s.standMap[d] = stand;
        const sh = [];
        for (let t = 13; t <= 21; t++) if (softHit(s, t, d)) sh.push(t);
        s.softHitMap[d] = sh;
      });
      return s;
    }
    const CYCLE = { hard: ['H', 'S', 'Dh', 'Ds', 'Rh', 'Rs'], soft: ['H', 'S', 'Dh', 'Ds'], pair: ['-', 'P', 'H', 'S', 'D', 'R'], da: ['-', 'R'], even: ['N', 'Y'] };
    // 試算表代碼正規化：D=Dh、R=Rh、大小寫皆可
    function normCode(kind, raw) {
      let c = String(raw || '').trim();
      if (!c) return null;
      const up = c.toUpperCase();
      if (kind === 'even') return ['Y', '是', '收', 'TRUE', '1'].includes(up) ? 'Y' : ['N', '否', '不收', 'FALSE', '0'].includes(up) ? 'N' : null;
      if (kind === 'pair' || kind === 'da') { if (up === '·' || up === '-' || up === '') return '-'; return CYCLE[kind].includes(up) ? up : null; }
      if (up === 'D' || up === 'DH') return 'Dh';
      if (up === 'DS') return 'Ds';
      if (kind === 'hard' && (up === 'R' || up === 'RH')) return 'Rh';
      if (kind === 'hard' && up === 'RS') return 'Rs';
      if (up === 'H' || up === 'S') return up;
      return null;
    }
    return { hardHit, softHit, hardCode, softCode, pairCode, daCode, evenCode, setHard, setSoft, setPair, setDA, setEven, materialize, CYCLE, normCode };
  })();

  const cloneStrategy = s => {
    const c = normalizeStrategy(JSON.parse(JSON.stringify(s)));
    if (s.builtin) c.builtin = s.builtin;
    return c;
  };

  // 匯出成舊格式（加上新欄位），舊版程式仍讀得懂
  function exportStrategy(s, extra) {
    const doubleMap = perDealer(d => Array.from(new Set([...(s.hardDoubleMap[d] || []), ...(s.softDoubleMap[d] || [])])).sort((a, b) => a - b));
    return Object.assign({
      name: s.name, pairRulesMap: s.pairRulesMap, doubleMap, hardDoubleMap: s.hardDoubleMap, softDoubleMap: s.softDoubleMap,
      hitMap: s.hitMap, softHitMap: s.softHitMap, standMap: s.standMap, surrenderMap: s.surrenderMap,
      dasurrenderMap: s.dasurrenderMap, evenMoney: s.evenMoney, evenMoneyTC: s.evenMoneyTC, evenMoneyMap: s.evenMoneyMap,
      meta: { exportedAt: new Date().toISOString(), format: 'ks-strategy-v2' }
    }, extra || {});
  }

  /**
   * 依策略決定動作
   * @returns {string} 'hit'|'stand'|'double'|'split'|'surrender'|'even'|'wait'
   */
  /* ---------------- 分段策略（依牌況） ----------------
     segmented = { segmented:true, name, base, segments:[{ name, lo, hi, strat }] }
     牌況值：平衡系統用 True Count（無條件捨去成整數），非平衡系統（KO）用 Running Count */
  function pickSegment(strat, ctx) {
    if (!strat || !strat.segmented) return { strat, seg: null };
    if (ctx && ctx.segment) {
      const s = strat.segments.find(x => x.name === ctx.segment);
      if (s) return { strat: s.strat, seg: s };
      return { strat: strat.base, seg: null };
    }
    if (ctx && ctx.tc != null && isFinite(ctx.tc)) {
      const v = Math.floor(ctx.tc + 1e-9);
      const s = strat.segments.find(x => v >= x.lo && v <= x.hi);
      if (s) return { strat: s.strat, seg: s };
    }
    return { strat: strat.base, seg: null };
  }

  function decide(strat, hand, dealerUp, L, ctx) {
    strat = pickSegment(strat, ctx).strat;
    const d = dealerUpValue(dealerUp);
    if (L.even) {
      if (strat.evenMoneyMap && strat.evenMoneyMap[d] != null) return strat.evenMoneyMap[d] ? 'even' : 'wait';
      const m = strat.evenMoney;
      const take = m === 'always' || (m === 'tc' && ctx && ctx.tc != null && ctx.tc >= strat.evenMoneyTC);
      return take ? 'even' : 'wait';
    }
    const info = handInfo(hand.cards);
    const t = info.total;
    if (hand.pendingDA) return L.surrender && (strat.dasurrenderMap[d] || []).includes(t) ? 'surrender' : 'stand';
    const two = hand.cards.length === 2;
    if (two && rankOf(hand.cards[0]) === rankOf(hand.cards[1])) {
      const pv = bjValue(hand.cards[0]);
      const pr = strat.pairRulesMap[d] || {};
      if (L.split && (pr.split || []).includes(pv)) return 'split';
      if (L.double && (pr.double || []).includes(pv)) return 'double';
      if (L.surrender && (pr.surrender || []).includes(pv)) return 'surrender';
      if ((pr.stand || []).includes(pv)) return 'stand';
      if (L.hit && (pr.hit || []).includes(pv)) return 'hit';
    }
    if (L.surrender && !info.soft && (strat.surrenderMap[d] || []).includes(t)) return 'surrender';
    if (L.double && ((info.soft ? strat.softDoubleMap[d] : strat.hardDoubleMap[d]) || []).includes(t)) return 'double';
    if (!L.hit) return 'stand';
    if (info.soft) {
      const sh = strat.softHitMap[d] || [];
      if (sh.length) return sh.includes(t) ? 'hit' : 'stand';
      return t < 18 ? 'hit' : 'stand';
    }
    if ((strat.standMap[d] || []).includes(t)) return 'stand';
    const hm = strat.hitMap[d] || [];
    if (hm.length) return hm.includes(t) ? 'hit' : 'stand';
    return t < 17 ? 'hit' : 'stand';
  }

  /* ---------------- EV / 機率計算 ---------------- */
  // counts10：A,2..9,T 剩餘張數陣列
  const VAL10 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const OUTCOMES = ['17', '18', '19', '20', '21', 'BJ', '22', 'bust'];

  // 莊家最終分佈（含抽牌時的牌組變化）
  function dealerDist(upIdx, counts10, R) {
    const memo = new Map();
    const c = counts10.slice();
    function rec(sum, ace, n, left) {
      const soft = ace && sum + 10 <= 21;
      const t = soft ? sum + 10 : sum;
      if (n === 2 && t === 21) return { BJ: 1 };
      if (n >= 2) {
        if (t > 21) return (R.dealer22Push && t === 22) ? { '22': 1 } : { bust: 1 };
        if (t > 17 || (t === 17 && !(soft && R.dealerHitSoft17))) return { [String(t)]: 1 };
      }
      const key = sum + '|' + (ace ? 1 : 0) + '|' + (n < 2 ? n : 2) + '|' + c.join(',');
      const m = memo.get(key);
      if (m) return m;
      const out = {};
      if (left <= 0) { out[t > 21 ? 'bust' : String(Math.max(17, t))] = 1; memo.set(key, out); return out; }
      for (let i = 0; i < 10; i++) {
        if (!c[i]) continue;
        const p = c[i] / left;
        c[i]--;
        const r = rec(sum + VAL10[i], ace || i === 0, n + 1, left - 1);
        c[i]++;
        for (const k in r) out[k] = (out[k] || 0) + p * r[k];
      }
      memo.set(key, out);
      return out;
    }
    const left = c.reduce((a, b) => a + b, 0);
    const r = rec(VAL10[upIdx], upIdx === 0, 1, left);
    const D = {};
    OUTCOMES.forEach(k => { D[k] = r[k] || 0; });
    return D;
  }

  const vec = (ev, w, p, l) => ({ ev, w, p, l });
  const vadd = (a, b, k) => { a.ev += k * b.ev; a.w += k * b.w; a.p += k * b.p; a.l += k * b.l; };
  const better = (a, b) => (b && b.ev > a.ev ? b : a);

  /**
   * 對手牌最終點數 t（未爆）面對莊家分佈 D 的結果
   * kind: { stake (輸的倍數), winMult, bjLoss (莊 BJ 時輸的倍數), is21NotBJ }
   */
  function standVec(t, D, R, kind) {
    const k = kind || {};
    const stake = k.stake || 1, win = (k.winMult || 1) * stake * R.winPayout;
    const bjLoss = k.bjLoss == null ? stake : k.bjLoss;
    const v = vec(0, 0, 0, 0);
    for (const o of OUTCOMES) {
      const q = D[o];
      if (!q) continue;
      if (o === 'BJ') {
        if (R.any21Wins && t === 21) { v.ev += q * win; v.w += q; }
        else { v.ev -= q * bjLoss; v.l += q; }
      } else if (o === '22') v.p += q;
      else if (o === 'bust') { v.ev += q * win; v.w += q; }
      else {
        const dt = +o;
        if (t > dt || (R.any21Wins && t === 21)) { v.ev += q * win; v.w += q; }
        else if (t < dt) { v.ev -= q * stake; v.l += q; }
        else v.p += q;
      }
    }
    return v;
  }

  /**
   * 計算目前手牌所有動作的 EV
   * @param {Array} cards 玩家手牌
   * @param {*} up 莊家明牌
   * @param {Array} counts10 剩餘牌（已扣除所有看得到的牌）
   * @param {object} R 規則
   * @param {object} L 合法動作（Round.legal）
   * @param {object} opt { fromSplit, splitAcesHand, D }
   */
  function evaluate(cards, up, counts10, R, L, opt) {
    opt = opt || {};
    const D = opt.D || dealerDist(idx10(up), counts10, R);
    const upV = dealerUpValue(up);
    const bjProb = D.BJ;
    const c = counts10.slice();
    const info = handInfo(cards);
    // 莊 BJ 時的損失倍數
    const bjLossFor = (stake, fromAA) => {
      if (R.dealerBJOriginalOnly) return 1;
      if (R.aaSplitVsBJHalf && fromAA && upV === 11) return stake * 0.5;
      return stake;
    };
    const memo = new Map();
    // 從 (sum, ace) 開始，遵循最佳要牌/停牌的結果（有扣牌）
    function playOut(sum, ace, kind) {
      const soft = ace && sum + 10 <= 21;
      const t = soft ? sum + 10 : sum;
      if (t > 21) return vec(-(kind.stake || 1), 0, 0, 1);
      const sv = standVec(t, D, R, kind);
      if (t === 21) return sv;
      const key = sum + '|' + (ace ? 1 : 0) + '|' + kind.id + '|' + c.join(',');
      const m = memo.get(key);
      if (m) return m;
      const hv = hitVec(sum, ace, kind);
      const r = better(sv, hv);
      memo.set(key, r);
      return r;
    }
    function hitVec(sum, ace, kind) {
      const left = c.reduce((a, b) => a + b, 0);
      const v = vec(0, 0, 0, 0);
      if (!left) return vec(-99, 0, 0, 1);
      for (let i = 0; i < 10; i++) {
        if (!c[i]) continue;
        const p = c[i] / left;
        c[i]--;
        vadd(v, playOut(sum + VAL10[i], ace || i === 0, kind), p);
        c[i]++;
      }
      return v;
    }
    function doubleVec(sum, ace, free, fromAA) {
      const left = c.reduce((a, b) => a + b, 0);
      const v = vec(0, 0, 0, 0);
      const stake = free ? 1 : 2;
      const kind = { stake, winMult: free ? 2 : 1, bjLoss: bjLossFor(stake, fromAA) };
      for (let i = 0; i < 10; i++) {
        if (!c[i]) continue;
        const p = c[i] / left;
        const s = sum + VAL10[i], a = ace || i === 0;
        const t = a && s + 10 <= 21 ? s + 10 : s;
        let r;
        if (t > 21) r = vec(-stake, 0, 0, 1);
        else {
          r = standVec(t, D, R, kind);
          if (R.surrenderAfterDouble && !free && r.ev < -1) r = vec(-1, 0, 0, 1); // 加倍後投降退回原注
        }
        vadd(v, r, p);
      }
      return v;
    }
    const baseKind = { id: 'n', stake: 1, bjLoss: bjLossFor(1, opt.fromAA) };
    const out = { D, dealerBJ: bjProb };
    out.stand = info.total > 21 ? vec(-1, 0, 0, 1) : standVec(info.total, D, R, baseKind);
    const hasAce = cards.some(x => bjValue(x) === 11);
    if (L.hit) out.hit = hitVec(info.hard, hasAce, baseKind);
    if (L.double) out.double = doubleVec(info.hard, hasAce, !!L.doubleFree, opt.fromAA);
    if (L.surrender) out.surrender = vec(-R.surrenderLoss, 0, 0, 1);
    if (L.split) {
      // 近似：兩手各自補一張後依最佳策略（不再分牌）
      const pc = cards[0], pv = bjValue(pc), isA = pv === 11;
      const oneCard = isA && R.splitAcesOneCard;
      const aa = isA || opt.fromAA;
      const bjl = R.dealerBJOriginalOnly ? 0.5 : bjLossFor(1, aa);
      const kind = { id: 's', stake: 1, bjLoss: bjl };
      const left = c.reduce((a, b) => a + b, 0);
      const one = vec(0, 0, 0, 0);
      for (let i = 0; i < 10; i++) {
        if (!c[i]) continue;
        const p = c[i] / left;
        c[i]--;
        const s = (isA ? 1 : pv) + VAL10[i], a = isA || i === 0;
        const t = a && s + 10 <= 21 ? s + 10 : s;
        let r;
        if (oneCard) r = standVec(t, D, R, kind);
        else {
          r = playOut(s, a, kind);
          if (R.das && t < 21) {
            const free = R.freeDouble && !(a && s + 10 <= 21) && t >= 9 && t <= 11;
            r = better(r, doubleVec(s, a, free, aa));
          }
        }
        vadd(one, r, p);
        c[i]++;
      }
      out.split = vec(one.ev * 2, one.w, one.p, one.l);
    }
    if (L.even) {
      out.even = vec(1, 1, 0, 0);
      const bjWin = R.bjPayout;
      const pDBJ = bjProb;
      out.wait = R.bjVsDealerBJ === 'pay' ? vec(bjWin, 1, 0, 0) : vec((1 - pDBJ) * bjWin, 1 - pDBJ, pDBJ, 0);
    }
    let best = null;
    ['stand', 'hit', 'double', 'split', 'surrender', 'even', 'wait'].forEach(k => {
      if (out[k] && (!best || out[k].ev > out[best].ev + 1e-12)) best = k;
    });
    out.best = best;
    return out;
  }

  // 由 composition（13 點數）轉 10 格
  function toCounts10(rem) {
    const a = new Array(10).fill(0);
    RANKS.forEach(r => { a[idx10(r)] += rem[r] || 0; });
    return a;
  }

  /**
   * 依規則與牌組自動產生「最佳基本策略」（組成相依近似）
   */
  function generateOptimalStrategy(R, counts13, name) {
    const full = toCounts10(counts13);
    const s = {
      name: name || '最佳基本策略（自動計算）', builtin: 'optimal',
      pairRulesMap: {}, hardDoubleMap: {}, softDoubleMap: {}, hitMap: {}, softHitMap: {}, standMap: {},
      surrenderMap: {}, dasurrenderMap: {}, evenMoney: 'never', evenMoneyTC: 3
    };
    const hardRep = { 4: [2, 2], 5: [2, 3], 6: [2, 4], 7: [2, 5], 8: [3, 5], 9: [4, 5], 10: [4, 6], 11: [5, 6], 12: [10, 2], 13: [10, 3], 14: [10, 4], 15: [10, 5], 16: [10, 6], 17: [10, 7], 18: [10, 8], 19: [10, 9], 20: [10, 10] };
    const v2i = v => (v === 11 || v === 1 ? 0 : v === 10 ? 9 : v - 1);
    const i2r = i => (i === 0 ? 'A' : i === 9 ? '10' : String(i + 1));
    const L2 = { hit: true, stand: true, double: true, surrender: R.surrender !== 'none', doubleFree: false };
    DEALER_VALS.forEach(d => {
      const upI = v2i(d);
      const base = full.slice(); if (base[upI] > 0) base[upI]--;
      const D = dealerDist(upI, base, R);
      s.hitMap[d] = []; s.standMap[d] = []; s.hardDoubleMap[d] = []; s.softDoubleMap[d] = [];
      s.softHitMap[d] = []; s.surrenderMap[d] = []; s.dasurrenderMap[d] = [];
      s.pairRulesMap[d] = { split: [], double: [], stand: [], hit: [], surrender: [] };
      const calc = (cardVals, L, opt) => {
        const c = base.slice();
        cardVals.forEach(v => { if (c[v2i(v)] > 0) c[v2i(v)]--; });
        return evaluate(cardVals.map(v => i2r(v2i(v))), i2r(upI), c, R, L, Object.assign({ D }, opt));
      };
      s.standMap[d].push(21);
      // 硬牌
      for (let t = 4; t <= 20; t++) {
        const rep = hardRep[t];
        const freeD = R.freeDouble && t >= 9 && t <= 11;
        const e = calc(rep.map(v => v), Object.assign({}, L2, { doubleFree: freeD, hit: t < 21, double: t < 21 }));
        const hs = e.hit && e.hit.ev > e.stand.ev ? 'hit' : 'stand';
        (hs === 'hit' ? s.hitMap : s.standMap)[d].push(t);
        if (e.double && e.double.ev > Math.max(e.stand.ev, e.hit ? e.hit.ev : -9)) s.hardDoubleMap[d].push(t);
        if (e.surrender && e.surrender.ev > Math.max(e.stand.ev, e.hit ? e.hit.ev : -9, e.double ? e.double.ev : -9)) s.surrenderMap[d].push(t);
        if (R.surrenderAfterDouble && t >= 5) {
          const sv = standVec(t, D, R, { stake: 2 });
          if (sv.ev < -1) s.dasurrenderMap[d].push(t);
        }
      }
      // 軟牌 A+x
      for (let x = 2; x <= 10; x++) {
        const t = 11 + x;
        const e = calc([11, x], Object.assign({}, L2, { hit: t < 21, double: t < 21, surrender: false }));
        if (e.hit && e.hit.ev > e.stand.ev) s.softHitMap[d].push(t);
        if (e.double && e.double.ev > Math.max(e.stand.ev, e.hit ? e.hit.ev : -9)) s.softDoubleMap[d].push(t);
      }
      // 對子
      for (let pv = 2; pv <= 11; pv++) {
        const e = calc([pv, pv], Object.assign({}, L2, { split: true, doubleFree: R.freeDouble && pv * 2 >= 9 && pv * 2 <= 11 }), { fromAA: pv === 11 });
        const others = ['stand', 'hit', 'double', 'surrender'].filter(k => e[k]).map(k => e[k].ev);
        if (e.split && e.split.ev > Math.max(...others)) s.pairRulesMap[d].split.push(pv);
      }
    });
    return normalizeStrategy(s);
  }

  /* ---------------- 模擬器 ---------------- */
  function parseRamp(str) {
    // "1:1,2:2,3:4,4:8,5:12" → [[1,1],[2,2],...]
    return String(str || '').split(',').map(x => x.split(':').map(Number)).filter(x => x.length === 2 && !isNaN(x[0]) && !isNaN(x[1])).sort((a, b) => a[0] - b[0]);
  }

  class Simulator {
    /**
     * cfg: { rules, counts, penetration, shuffleEveryRound, countSystem,
     *        seats: [{ bet, betMode:'fixed'|'boost'|'ramp', strategy, fixed:[r1,r2] }],
     *        boostSeq:[], ramp:[[tc,units]], dealerUp, logLimit }
     */
    constructor(cfg) {
      this.cfg = cfg;
      this.R = cfg.rules;
      this.shoe = new KS.Shoe({ counts: cfg.counts, penetration: cfg.penetration });
      this.counter = new KS.Counter(cfg.countSystem || 'hilo', this.shoe.total);
      this.shoe.onDraw = c => this.counter.see(c);
      this.shoe.onShuffle = () => this.counter.reset(this.shoe.total);
      this.round = 0;
      this.logs = [];
      this.seatState = cfg.seats.map(() => ({ boostIdx: 0 }));
      this.stats = cfg.seats.map(() => ({
        rounds: 0, hands: 0, hW: 0, hL: 0, hP: 0, rW: 0, rL: 0, rP: 0, bj: 0, bust: 0, surrender: 0,
        dbl: 0, dblW: 0, dblFree: 0, dblFreeW: 0, split: 0, splitHands: 0, splitW: 0, even: 0,
        wagered: 0, net: 0, acc: new KS.Acc(), bank: new KS.Bankroll(), streak: new KS.StreakTracker(10),
        road: [], tc: {}, seg: {}, maxBet: 0
      }));
      this.dealerStats = { total: 0, played: 0 };
      OUTCOMES.forEach(k => { this.dealerStats[k] = 0; });
      this.warnings = new Set();
    }
    _betFor(i, tc) {
      const s = this.cfg.seats[i], st = this.seatState[i];
      if (s.betMode === 'boost' && this.cfg.boostSeq && this.cfg.boostSeq.length) return this.cfg.boostSeq[Math.min(st.boostIdx, this.cfg.boostSeq.length - 1)];
      if (s.betMode === 'ramp' && this.cfg.ramp && this.cfg.ramp.length) {
        let u = this.cfg.ramp[0][1];
        for (const [t, units] of this.cfg.ramp) if (Math.floor(tc) >= t) u = units;
        return s.bet * u;
      }
      return s.bet;
    }
    step() {
      const cfg = this.cfg, R = this.R;
      this.round++;
      if (cfg.shuffleEveryRound || this.shoe.needsShuffle()) this.shoe.shuffle();
      const tc = this.counter.index(this.shoe.size());
      const tcKey = Math.max(-5, Math.min(6, Math.floor(tc + 1e-9)));
      const seats = cfg.seats.map((s, i) => ({ bet: this._betFor(i, tc), fixed: s.fixed || [] }));
      const rd = new Round({ rules: R, shoe: this.shoe }, seats, { dealerUp: cfg.dealerUp || null }).start();
      rd.warnings.forEach(w => this.warnings.add(w));
      let guard = 0;
      while (rd.phase === 'player') {
        const c = rd.current();
        const L = rd.legal(c.hand, c.seat);
        const a = decide(cfg.seats[c.seatIdx].strategy, c.hand, rd.dealer[0], L, { tc: this.counter.index(this.shoe.size()) });
        c.hand.decisionTC = tc;
        rd.act(L[a] ? a : 'stand');
        if (++guard > 500) throw new Error('決策迴圈異常');
      }
      rd.playDealer();
      this.shoe.endRound();
      // 莊家統計（同一局只有一手莊家牌）
      const dout = rd.dealerOutcome();
      this.dealerStats.total++;
      if (dout) { this.dealerStats.played++; this.dealerStats[dout] = (this.dealerStats[dout] || 0) + 1; }
      // 玩家統計
      rd.seats.forEach((seat, i) => {
        const S = this.stats[i], st = this.seatState[i];
        S.rounds++;
        S.maxBet = Math.max(S.maxBet, seat.bet);
        let wager = 0;
        seat.hands.forEach(h => {
          S.hands++;
          wager += h.stake;
          if (h.result === 'W') S.hW++; else if (h.result === 'L') S.hL++; else S.hP++;
          if (h.isBJ) S.bj++;
          if (h.bust) S.bust++;
          if (h.surrendered) S.surrender++;
          if (h.evenMoney) S.even++;
          if (h.doubled) {
            if (h.freeDouble) { S.dblFree++; if (h.result === 'W') S.dblFreeW++; }
            else { S.dbl++; if (h.result === 'W') S.dblW++; }
          }
          if (h.fromSplit) { S.splitHands++; if (h.result === 'W') S.splitW++; }
        });
        if (seat.hands.length > 1) S.split += seat.hands.length - 1;
        S.wagered += wager;
        S.net += seat.net;
        S.acc.add(seat.net / cfg.seats[i].bet);
        S.bank.add(seat.net);
        if (seat.result === 'W') S.rW++; else if (seat.result === 'L') S.rL++; else S.rP++;
        S.streak.push(seat.result);
        if (S.road.length < 600) S.road.push(seat.result);
        const tb = S.tc[tcKey] || (S.tc[tcKey] = { n: 0, units: 0, w: 0, l: 0 });
        tb.n++; tb.units += seat.net / cfg.seats[i].bet;
        if (seat.result === 'W') tb.w++; else if (seat.result === 'L') tb.l++;
        // 依牌況分段統計（試算表分段策略）
        const segName = cfg.seats[i].strategy.segmented ? (pickSegment(cfg.seats[i].strategy, { tc }).seg || { name: '基本' }).name : null;
        if (segName) {
          const sb = S.seg[segName] || (S.seg[segName] = { n: 0, units: 0, w: 0, l: 0 });
          sb.n++; sb.units += seat.net / cfg.seats[i].bet;
          if (seat.result === 'W') sb.w++; else if (seat.result === 'L') sb.l++;
        }
        // 智慧加注：贏往下一階、輸回第一階、和局不變
        if (seat.result === 'W') st.boostIdx++; else if (seat.result === 'L') st.boostIdx = 0;
        if (cfg.boostSeq && st.boostIdx >= cfg.boostSeq.length) st.boostIdx = cfg.boostSeq.length - 1;
      });
      if (this.logs.length < (cfg.logLimit || 0)) this.logs.push(this._logEntry(rd, tc));
      return rd;
    }
    _logEntry(rd, tc) {
      return {
        round: this.round, tc, rc: this.counter.rc,
        dealer: rd.dealer.map(KS.cardText), dealerTotal: handTotal(rd.dealer), dealerBJ: rd.dealerBJ, dealerOutcome: rd.dealerOutcome(),
        seats: rd.seats.map(s => ({
          bet: s.bet, net: s.net, result: s.result,
          hands: s.hands.map(h => ({ cards: h.cards.map(KS.cardText), total: handTotal(h.cards), actions: h.actions.slice(), result: h.result, profit: h.profit, note: h.note || '', stake: h.stake, free: h.freeDouble }))
        }))
      };
    }
    finish() { this.stats.forEach(S => S.streak.finish()); }
  }

  const ACTION_LABEL = { hit: '要牌', stand: '停牌', double: '加倍', split: '分牌', surrender: '投降', even: '先收1倍', wait: '等莊家', doubleFree: '免費加倍' };

  KS.BJ = {
    BASE_RULES, PRESETS, RULE_FIELDS, OUTCOMES, DEALER_VALS, ACTION_LABEL,
    handInfo, handTotal, isTwoCard21, is777or678, Round, decide, pickSegment, cells, cloneStrategy, normalizeStrategy, exportStrategy,
    ksDefaultStrategy, dealerDist, standVec, evaluate, toCounts10, generateOptimalStrategy, Simulator, parseRamp
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = KS;
})(typeof window !== 'undefined' ? window : globalThis);
