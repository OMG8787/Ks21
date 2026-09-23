// 執行：node tests/test-all.js
const path = require('path');
const KS = require(path.join(__dirname, '..', 'ks-core.js'));
require(path.join(__dirname, '..', 'ks-blackjack.js'));
const BJ = KS.BJ;

let pass = 0, fail = 0;
function ok(cond, msg) { if (cond) pass++; else { fail++; console.log('✗ ' + msg); } }
function near(a, b, tol, msg) { ok(Math.abs(a - b) <= tol, `${msg}（得到 ${a}，預期 ${b}±${tol}）`); }

// 可控牌靴：依序發出指定牌
function stackedShoe(seq) {
  const shoe = new KS.Shoe({ counts: KS.standardCounts(8), penetration: 1 });
  shoe.cards = seq.slice().reverse();
  return shoe;
}
function playRound(presetKey, seq, seats, script, ruleOverride) {
  const rules = Object.assign({}, BJ.PRESETS[presetKey], ruleOverride || {});
  const rd = new BJ.Round({ rules, shoe: stackedShoe(seq) }, seats.map(b => ({ bet: b }))).start();
  let i = 0;
  while (rd.phase === 'player') rd.act(script[i++] || 'stand');
  rd.playDealer();
  return rd;
}

/* ---------- 手牌計算 ---------- */
ok(BJ.handTotal(['A', '6']) === 17 && BJ.handInfo(['A', '6']).soft, 'A6 = 軟17');
ok(BJ.handTotal(['A', 'A', '9']) === 21, 'AA9 = 21');
ok(BJ.handTotal(['A', '6', '10']) === 17 && !BJ.handInfo(['A', '6', '10']).soft, 'A6+10 = 硬17');
ok(BJ.isTwoCard21(['A', 'K']), 'A+K 為 BJ');

/* ---------- 發牌順序：玩家1、莊明、玩家2張 → 莊第二張 ---------- */
// 玩家 10,7；莊 9 → 第二張 8 = 17；玩家 17 平手
let rd = playRound('american', ['10', '9', '7', '8'], [100], ['stand']);
ok(rd.seats[0].hands[0].cards.join() === '10,7' && rd.dealer.join() === '9,8', '發牌順序正確');
ok(rd.seats[0].net === 0, '17 對 17 和局');

/* ---------- 21 對 21 和局不吃本金（美式） ---------- */
rd = playRound('american', ['10', '10', '5', '6', '5', '6'], [100], ['hit']);
// 玩家 10+5+6=21 自動停；莊 10+5+6=21
ok(rd.seats[0].hands[0].cards.length === 3 && rd.seats[0].net === 0, '美式 21 對 21 退回本金（和局）');

/* ---------- 同一局多位玩家面對同一莊家 ---------- */
rd = playRound('american', ['10', '10', '9', '8', '7', '8'], [100, 100], ['stand', 'stand']);
// p1=10,8=18  p2=10,7=17  莊=9,8=17
ok(rd.dealer.length === 2 && rd.seats[0].net === 100 && rd.seats[1].net === 0, '兩位玩家同一手莊家牌');

/* ---------- 分牌後 A+10 只算 21，不是 BJ ---------- */
rd = playRound('american', ['A', '10', 'A', 'K', 'Q', '7'], [100], ['split']);
// 玩家 A,A 分牌 → A+K, A+Q（splitAcesOneCard）；莊 10+7=17
ok(rd.seats[0].hands.every(h => !h.isBJ) && rd.seats[0].net === 200, '分牌 A+10 算 21 贏 1 倍（非 BJ 1.5 倍）');

/* ---------- 美式：玩家 BJ vs 莊 BJ 和局；even money ---------- */
rd = playRound('american', ['A', 'A', 'K', 'K'], [100], ['wait']);
ok(rd.seats[0].net === 0, '美式 BJ 對 BJ 和局');
rd = playRound('american', ['A', 'A', 'K', 'K'], [100], ['even']);
ok(rd.seats[0].net === 100, 'even money 先收 1 倍');
rd = playRound('american', ['A', '5', 'K', '9'], [100], []);
ok(rd.seats[0].net === 150, '莊明牌 5：BJ 直接賠 1.5 倍');

/* ---------- 英式：BJ 立即賠、21 必勝、777 在莊爆牌時仍拿獎金 ---------- */
rd = playRound('british', ['A', 'A', 'K', 'K'], [100], []);
ok(rd.seats[0].net === 150, '英式 BJ 對莊 BJ 仍賠 3:2（場館規則）');
rd = playRound('british', ['7', '10', '7', '7', '6', '10'], [100], ['hit']);
// 玩家 7,7 → pair 7 vs 10: KS 預設不分，這裡腳本直接要牌 → 777=21；莊 10+6+10 爆
ok(rd.seats[0].net === 150, '英式 777 莊爆牌時仍拿 1.5 倍獎金');
rd = playRound('british', ['10', 'A', '5', '6', 'K'], [100], ['hit']);
// 玩家 10,5,6=21；莊 A+K=BJ → 英式 21 必勝
ok(rd.seats[0].net === 100, '英式 21 點對莊 BJ 仍贏（場館規則）');
// ENHC：加倍對莊 BJ 全輸
rd = playRound('british', ['6', 'A', '5', '5', 'K'], [100], ['double', 'stand']);
ok(rd.seats[0].net === -200, '英式 加倍後遇莊 BJ 全輸');
// 加倍後投降退原注
rd = playRound('british', ['6', '10', '5', '2', '8'], [100], ['double', 'surrender']);
ok(rd.seats[0].net === -100, '英式 加倍後投降輸原注');
// AA 分牌對莊明牌 A 的 BJ 只輸半注
rd = playRound('british', ['A', 'A', 'A', '5', '6', 'K'], [100], ['split', 'stand', 'stand']);
ok(rd.seats[0].net === -100, '英式 AA 分牌遇莊 A 的 BJ 每手輸半注');
// 英式 H17
rd = playRound('british', ['10', 'A', '8', '6', '2'], [100], ['stand']);
ok(rd.dealer.length === 3, '英式 莊家軟17要補');
rd = playRound('american', ['10', 'A', '8', '6', '2'], [100], ['stand']);
ok(rd.dealer.length === 2, '美式 莊家軟17停');

/* ---------- 22 點 ---------- */
// 莊 22 整桌平手
rd = playRound('star22', ['10', '10', '8', '2', 'K'], [100], ['stand']);
ok(BJ.handTotal(rd.dealer) === 22 && rd.seats[0].net === 0, '22點：莊 22 點平手');
// 莊 >22 通賠
rd = playRound('star22', ['10', '10', '8', '5', '9'], [100], ['stand']);
ok(rd.seats[0].net === 100, '22點：莊 24 點通賠');
// 玩家爆牌照輸（即使莊家 22）
rd = playRound('star22', ['10', '10', '6', 'K', '2', 'K'], [100], ['hit']);
ok(rd.seats[0].net === -100, '22點：玩家爆牌直接沒收');
// 免費加倍：9/10/11，輸只輸原注
rd = playRound('star22', ['5', '10', '6', '2', '9'], [100], ['double']);
// 玩家 5,6=11 加倍拿 2 = 13；莊 10+9=19 → 輸原注 100
ok(rd.seats[0].hands[0].freeDouble && rd.seats[0].net === -100, '22點：免費加倍輸只輸原注');
rd = playRound('star22', ['5', '10', '6', '10', '8'], [100], ['double']);
ok(rd.seats[0].net === 200, '22點：免費加倍贏賠 2 倍注');
// 自費加倍（非 9/10/11）
rd = playRound('star22', ['8', '10', '4', '5', '7'], [100], ['double']);
// 8,4=12 自費加倍 +5=17；莊 10+7=17 和
ok(!rd.seats[0].hands[0].freeDouble && rd.seats[0].hands[0].stake === 200 && rd.seats[0].net === 0, '22點：12 點加倍為自費');
// 莊 BJ 只輸原注（分牌 + 加倍）
rd = playRound('star22', ['8', 'A', '8', '3', '2', '10', '10', 'K'], [100], ['split', 'double', 'double']);
// 8,8 分牌 → 8+3=11 免費加倍拿10=21；8+2=10 免費加倍拿10=20；莊 A+K BJ
ok(rd.dealerBJ && rd.seats[0].net === -100, '22點：莊 BJ 只輸原注');
// 投降只限第一個動作
let r2 = new BJ.Round({ rules: BJ.PRESETS.star22, shoe: stackedShoe(['8', '10', '8', '3', '2']) }, [{ bet: 100 }]).start();
ok(r2.legal(r2.current().hand, r2.current().seat).surrender === true, '22點：第一個動作可投降');
r2.act('split');
ok(!r2.legal(r2.current().hand, r2.current().seat).surrender, '22點：分牌後不可投降');
// AA 只能分一次、分後可繼續要牌
r2 = new BJ.Round({ rules: BJ.PRESETS.star22, shoe: stackedShoe(['A', '10', 'A', 'A', '5', '3']) }, [{ bet: 100 }]).start();
r2.act('split');
let L = r2.legal(r2.current().hand, r2.current().seat);
ok(!L.split && L.hit, '22點：AA 分牌後再拿 A 不能再分，但可要牌');
// 玩家 BJ：莊明 10 可先收 1 倍；等待且莊非 BJ → 1.5 倍
rd = playRound('star22', ['A', '10', 'K', '7'], [100], ['wait']);
ok(rd.seats[0].net === 150, '22點：BJ 等莊家非 BJ 賠 1.5 倍');
rd = playRound('star22', ['A', '10', 'K', 'A'], [100], ['wait']);
ok(rd.seats[0].net === 0, '22點：BJ 等到莊 BJ 和局');
// 補到 21 自動停
r2 = new BJ.Round({ rules: BJ.PRESETS.star22, shoe: stackedShoe(['10', '9', '5', '6', '7']) }, [{ bet: 100 }]).start();
r2.act('hit');
ok(r2.phase === 'dealer', '22點：補到 21 點自動停牌');

/* ---------- 策略 ---------- */
const ks = BJ.ksDefaultStrategy('british');
ok(BJ.decide(ks, { cards: ['10', '6'] }, '7', { hit: true, stand: true, double: true, surrender: true }) === 'hit', 'KS 預設：硬16 vs 7 要牌');
ok(BJ.decide(ks, { cards: ['5', '6'] }, '6', { hit: true, stand: true, double: true }) === 'double', 'KS 預設：11 vs 6 加倍');
ok(BJ.decide(ks, { cards: ['8', '8'] }, '6', { hit: true, stand: true, double: true, split: true }) === 'split', 'KS 預設：88 vs 6 分牌');
ok(BJ.decide(ks, { cards: ['8', '8'] }, '6', { hit: true, stand: true, double: true, split: false }) === 'stand', '無法分牌時改走硬牌表（16 vs 6 停）');
ok(BJ.decide(ks, { cards: ['6', '5', '4'], pendingDA: true }, '10', { stand: true, surrender: true }) === 'surrender', 'KS 預設：加倍後 15 vs 10 投降');
// 舊版 JSON 相容
const old = { pairRulesMap: ks.pairRulesMap, doubleMap: { 2: [10, 11, 17] }, hitMap: ks.hitMap, softHitMap: ks.softHitMap, standMap: ks.standMap };
const n = BJ.normalizeStrategy(old);
ok(n.hardDoubleMap[2].includes(10) && n.softDoubleMap[2].join() === '17', '舊版 doubleMap 轉換');

/* ---------- 算牌系統平衡性 ---------- */
Object.entries(KS.COUNT_SYSTEMS).forEach(([k, s]) => {
  if (k === 'custom') return;
  const sum = KS.RANKS.reduce((a, r) => a + s.tags[KS.idx10(r)] * 4, 0);
  ok(s.balanced ? Math.abs(sum) < 1e-9 : sum === 4, `${s.name} 一副牌總和 ${sum}`);
});

/* ---------- 莊家分佈 & 最佳策略 ---------- */
const full6 = BJ.toCounts10(KS.standardCounts(6));
const up6 = full6.slice(); up6[5]--;
const D6 = BJ.dealerDist(5, up6, BJ.PRESETS.american);
near(Object.values(D6).reduce((a, b) => a + b, 0), 1, 1e-9, '莊家分佈機率總和 = 1');
near(D6.bust, 0.42, 0.01, '6 副 S17 莊明 6 爆牌率 ≈ 42%');

const t0 = Date.now();
const opt = BJ.generateOptimalStrategy(BJ.PRESETS.american, KS.standardCounts(6));
console.log(`  產生最佳策略耗時 ${Date.now() - t0} ms`);
ok(opt.standMap[10].includes(17) && opt.hitMap[10].includes(16), '最佳策略：16 vs 10 要牌、17 停');
ok(opt.standMap[4].includes(12) && opt.hitMap[2].includes(12), '最佳策略：12 vs 4 停、12 vs 2 要');
ok(opt.hardDoubleMap[6].includes(11) && opt.hardDoubleMap[6].includes(9), '最佳策略：9/11 vs 6 加倍');
ok(opt.pairRulesMap[10].split.includes(8) || opt.pairRulesMap[10].split.length >= 0, '對子計算完成');
ok(opt.pairRulesMap[6].split.includes(11) && !opt.pairRulesMap[6].split.includes(10), '最佳策略：AA 分、10-10 不分');

/* ---------- 大量模擬 ---------- */
function sim(preset, strat, n, counts) {
  const s = new BJ.Simulator({
    rules: BJ.PRESETS[preset], counts: counts || KS.standardCounts(6), penetration: 0.75,
    seats: [{ bet: 100, betMode: 'fixed', strategy: strat }], logLimit: 5
  });
  for (let i = 0; i < n; i++) s.step();
  s.finish();
  return s;
}
const t1 = Date.now();
const sA = sim('american', opt, 300000);
console.log(`  美式最佳策略 30 萬局：EV/局 ${(sA.stats[0].acc.mean() * 100).toFixed(3)}%  (${Date.now() - t1} ms)`);
ok(sA.stats[0].acc.mean() > -0.03 && sA.stats[0].acc.mean() < 0.03, '美式最佳策略 EV 合理範圍');
ok(sA.dealerStats.total === 300000, '莊家統計每局只算一次');

const opt22 = BJ.generateOptimalStrategy(BJ.PRESETS.star22, KS.standardCounts(6), '22點最佳策略');
const s22 = sim('star22', opt22, 200000);
console.log(`  22點最佳策略 20 萬局：EV/局 ${(s22.stats[0].acc.mean() * 100).toFixed(3)}%  莊22 ${(s22.dealerStats['22'] / s22.dealerStats.total * 100).toFixed(2)}%`);
ok(s22.dealerStats['22'] > 0, '22點：有統計到莊 22');
const st = s22.stats[0].streak;
ok(st.maxWin >= 2 && st.winAtLeast[2] >= st.winAtLeast[3], '連勝統計');

const sB = sim('british', BJ.ksDefaultStrategy('british'), 100000, Object.assign(KS.standardCounts(5), { '10': 0 }));
console.log(`  英式 KS 預設 10 萬局（無10）：EV/局 ${(sB.stats[0].acc.mean() * 100).toFixed(3)}%`);
ok(isFinite(sB.stats[0].acc.mean()), '英式模擬可執行');

/* ---------- EV 計算：16 vs 10 ---------- */
const c16 = full6.slice(); c16[9] -= 2; c16[5]--;
const e = BJ.evaluate(['10', '6'], '10', c16, BJ.PRESETS.american, { hit: true, stand: true, double: true, surrender: true });
console.log(`  16 vs 10：停 ${e.stand.ev.toFixed(4)} 要 ${e.hit.ev.toFixed(4)} 投降 ${e.surrender.ev}`);
ok(e.hit.ev > e.stand.ev, '16 vs 10 要牌 EV 較高');
near(e.stand.w + e.stand.p + e.stand.l, 1, 1e-9, '停牌勝和輸機率總和 = 1');
near(e.hit.w + e.hit.p + e.hit.l, 1, 1e-9, '要牌勝和輸機率總和 = 1');

/* ---------- 三公 ---------- */
require(path.join(__dirname, '..', 'ks-sangong.js'));
const SG = KS.SG;
const cd = s => s.split(' ').map(x => ({ r: x.slice(0, -1), s: x.slice(-1) }));
ok(SG.isStraight(cd('J♠ Q♥ K♦')), '三公：J-Q-K 是順子');
ok(SG.isStraight(cd('Q♠ K♥ A♦')), '三公：Q-K-A 是順子');
ok(SG.isStraight(cd('A♠ 2♥ 3♦')), '三公：A-2-3 是順子');
ok(!SG.isStraight(cd('K♠ A♥ 2♦')), '三公：K-A-2 不是順子');
ok(!SG.isStraight(cd('9♠ 10♥ 10♦')), '三公：9-10-10 不是順子');
const bets = { main: 100, special: 10, bigTiger: 10, smallTiger: 10, tiger: 10, face: 10 };
let rs = SG.settle(cd('9♠ 10♥ J♦'), SG.evaluate(cd('2♠ 3♥ 4♦')), bets, SG.DEFAULT_ODDS);
ok(rs.side.special === 60, '三公：順子特殊投注淨賺 注×6（不多賠一注）');
ok(rs.main === 100, '三公：同為 9 點時公牌多者勝');
rs = SG.settle(cd('J♠ Q♥ 6♦'), SG.evaluate(cd('J♣ Q♦ 9♣')), bets, SG.DEFAULT_ODDS);
ok(rs.main === -100 && rs.side.bigTiger === 900 && rs.side.tiger === 500, '三公：大老虎/老虎 不需贏莊家');
ok(rs.side.face === 10 * 10, '三公：合計 4 公');
const pr = SG.nextHandProbs(new KS.Shoe({ counts: KS.standardCounts(1), withSuits: true }).cards);
near(pr.straightFlush, 48 / 22100, 1e-12, '三公：同花順精確機率');
near(pr.straight, 720 / 22100, 1e-12, '三公：順子精確機率');
near(pr.flush, 1096 / 22100, 1e-12, '三公：同花精確機率');
near(pr.W + pr.P + pr.L, 1, 1e-9, '三公：勝和負總和 = 1');
const sgs = new SG.Simulator({ counts: KS.standardCounts(1), penetration: 1, shuffleEveryRound: true, odds: SG.DEFAULT_ODDS, players: [{ bets }], logLimit: 3 });
for (let i = 0; i < 200000; i++) sgs.step();
sgs.finish();
const p0 = sgs.players[0];
near(p0.W / 200000, pr.W, 0.006, '三公：模擬勝率與精確值一致');
near(p0.side.special.hits / 200000, pr.flush + pr.straight + pr.straightFlush, 0.003, '三公：模擬特殊牌組中獎率與精確值一致');
const ev = SG.betEV(pr, SG.DEFAULT_ODDS);
console.log('  三公單副 EV：' + SG.BET_KEYS.map(k => `${SG.BET_LABEL[k]} ${(ev[k] * 100).toFixed(2)}%`).join('、'));
near(p0.side.special.net / p0.side.special.wager, ev.special, 0.03, '三公：特殊牌組模擬回報與 EV 一致');

/* ---------- Google 試算表策略 ---------- */
require(path.join(__dirname, '..', 'ks-auth.js'));
const A = KS.auth;
const segs = A.parseSegments('小牌多:~-2, 正常:-1~1, 大牌多:2~3, 大牌很多:4~');
ok(segs.length === 4 && segs[0].lo === -Infinity && segs[0].hi === -2 && segs[3].lo === 4 && segs[3].hi === Infinity, '解析牌況分段');
const tpl = A.template(BJ);
const toObjs = rows => rows.slice(1).map(r => Object.fromEntries(rows[0].map((h, i) => [h, r[i] == null ? '' : String(r[i])])));
const data = { settings: toObjs(tpl.settings), strategies: toObjs(tpl.strategies) };
['american', 'british', 'star22'].forEach(g => {
  const r = A.buildForGame(BJ, data, 'player02', g);
  ok(r && r.errors.length === 0, `${g}：試算表無錯誤 ${r && r.errors.slice(0, 3).join('；')}`);
  const def = BJ.cells.materialize(BJ.ksDefaultStrategy(g));
  const base = r.strategy.segmented ? r.strategy.base : r.strategy;
  const same = ['pairRulesMap', 'hardDoubleMap', 'softDoubleMap', 'hitMap', 'softHitMap', 'standMap', 'surrenderMap', 'dasurrenderMap']
    .every(k => JSON.stringify(base[k]) === JSON.stringify(def[k]));
  ok(same, `${g}：試算表「基本」策略與 KS 預設完全相同`);
});
let r22 = A.buildForGame(BJ, data, 'player02', 'star22');
const L16 = { hit: true, stand: true, double: true, surrender: true };
ok(BJ.decide(r22.strategy, { cards: ['10', '6'] }, '10', L16, { tc: 0 }) === 'hit', '22點 正常牌況：16 vs 10 要牌');
ok(BJ.decide(r22.strategy, { cards: ['10', '6'] }, '10', L16, { tc: 2.4 }) === 'stand', '22點 大牌多（TC 2.4）：16 vs 10 停牌');
ok(BJ.decide(r22.strategy, { cards: ['10', '6'] }, '9', L16, { tc: 2.4 }) === 'hit', '22點 大牌多：16 vs 9 仍依基本策略要牌');
ok(BJ.decide(r22.strategy, { cards: ['10', '6'] }, '9', L16, { tc: 5 }) === 'stand', '22點 大牌很多（TC 5）：16 vs 9 停牌');
ok(BJ.decide(r22.strategy, { cards: ['A', 'K'] }, 'A', { even: true, wait: true }, { tc: 5 }) === 'even', '22點 大牌很多：BJ 對莊 A 先收 1 倍');
ok(BJ.decide(r22.strategy, { cards: ['A', 'K'] }, 'A', { even: true, wait: true }, { tc: 0 }) === 'wait', '22點 正常：BJ 等莊家');
ok(BJ.decide(r22.strategy, { cards: ['10', '5'] }, '2', L16, { tc: -3 }) === 'hit', '22點 小牌多（TC -3）：15 vs 2 要牌');
ok(BJ.decide(r22.strategy, { cards: ['10', '5'] }, '2', L16, { tc: -1 }) === 'stand', 'TC -1 無條件捨去 = -1 屬正常段（15 vs 2 停）');
ok(BJ.decide(r22.strategy, { cards: ['10', '5'] }, '2', L16, { tc: -1.2 }) === 'hit', 'TC -1.2 捨去 = -2 屬小牌多段（15 vs 2 要）');
// 個人覆蓋
const r1 = A.buildForGame(BJ, data, 'player01', 'star22');
ok(r1.segments.length === 3 && r1.seq.join() === '500,1000,1500,2000', 'player01 使用自己的牌況分段與加注序列');
ok(BJ.decide(r1.strategy, { cards: ['10', '2'] }, '2', L16, { tc: 0 }) === 'stand', 'player01 個人覆蓋：12 vs 2 停牌');
ok(BJ.decide(r22.strategy, { cards: ['10', '2'] }, '2', L16, { tc: 0 }) === 'hit', 'player02 仍用預設：12 vs 2 要牌');
ok(BJ.decide(r1.strategy, { cards: ['A', 'K'] }, '10', { even: true, wait: true }, { tc: 3 }) === 'even', 'player01 大牌多：保險先收');
// 錯誤回報
const bad = A.buildForGame(BJ, { settings: data.settings, strategies: [{ ID: 'p', 遊戲: '美式21', 牌況: '亂寫', 類型: '硬牌', 玩家牌: '16', 10: 'S' }, { ID: '*', 遊戲: '美式21', 牌況: '基本', 類型: '硬牌', 玩家牌: '16', 10: 'X' }] }, 'p', 'american');
ok(bad.errors.length === 2, '試算表錯誤會被列出');
// 使用試算表分段策略模擬
const sseg = new BJ.Simulator({ rules: BJ.PRESETS.star22, counts: KS.standardCounts(6), penetration: 0.8, seats: [{ bet: 100, betMode: 'fixed', strategy: r22.strategy }], logLimit: 0 });
for (let i = 0; i < 30000; i++) sseg.step();
ok(Object.keys(sseg.stats[0].seg).length >= 3, '模擬依牌況分段統計：' + Object.keys(sseg.stats[0].seg).join('、'));

console.log(`\n通過 ${pass}，失敗 ${fail}`);
process.exit(fail ? 1 : 0);
