/* 全策略試算（ks-verify.html）的模擬核心
 * 同一份程式碼兩種用法：
 * 1. 當 Web Worker（背景執行緒）：new Worker('ks-verify-sim.js')，每條 Worker 跑在不同 CPU 核心，多條同時跑才會真的變快。
 * 2. 當一般 <script> 載入：瀏覽器不能開 Worker 時（例如直接用 file:// 開），主畫面改用這裡的 makeRunner 單核心慢慢跑。
 * 模擬邏輯：強制第一個動作，之後照最佳基本策略打到底；每局都用設定的牌組組成重新洗牌。
 * 同桌其他玩家（others 人）：每局隨機發牌、照最佳基本策略打，他們用掉的牌會影響莊家補到的牌；只統計自己（第 1 個座位）。
 */
(function (root) {
  'use strict';
  const isWorker = typeof importScripts === 'function' && typeof document === 'undefined';
  if (isWorker && !root.KS) importScripts('ks-core.js', 'ks-blackjack.js');
  const KSU = root.KS, BJ = KSU.BJ;

  const LOG_LIMIT = 50; // 每個「格子＋動作」最多留幾筆局紀錄給人工檢查
  const DEALER_OUTS = ['BJ', '17', '18', '19', '20', '21', '22', 'bust'];
  const upLabelOf = d => (d === 11 ? 'A' : String(d));

  function newStats() {
    return { rounds: 0, hands: 0, hW: 0, hL: 0, hP: 0, rW: 0, rL: 0, rP: 0, bj: 0, bust: 0, surrender: 0,
      dbl: 0, dblW: 0, dblFree: 0, dblFreeW: 0, splitHands: 0, splitW: 0, even: 0, wagered: 0, net: 0, acc: new KSU.Acc() };
  }
  function newDealerStats() {
    const D = { rounds: 0 };
    DEALER_OUTS.forEach(k => { D[k] = 0; });
    return D;
  }

  // 自己固定第 1 個座位（最先動作），其他玩家的座位不指定牌＝隨機發
  function newRound(R, shoe, job, others) {
    const seats = [{ bet: 1, fixed: job.cards }];
    for (let i = 0; i < others; i++) seats.push({ bet: 1 });
    return new BJ.Round({ rules: R, shoe: shoe }, seats, { dealerUp: upLabelOf(job.d) }).start();
  }
  // 讓所有玩家做完決定：自己的第一個決定用 firstAct(L)，其餘（自己後續、其他玩家）照最佳基本策略
  function playPlayers(rd, opt, firstAct) {
    let first = true, guard = 0;
    while (rd.phase === 'player' && guard++ < 400) {
      const c = rd.current();
      const L = rd.legal(c.hand, c.seat);
      let a;
      if (first && c.seatIdx === 0) { a = firstAct(L); first = false; }
      else a = BJ.decide(opt, c.hand, rd.dealer[0], L, {});
      rd.act(L[a] ? a : 'stand');
    }
  }
  const othersLog = rd => rd.seats.slice(1).map(s => s.hands.map(x => x.cards.map(KSU.cardText).join(' ')).join('｜'));

  // 一般動作：一局
  function playOne(R, shoe, opt, job, S, logs, wantLogs, others) {
    shoe.shuffle();
    const rd = newRound(R, shoe, job, others);
    playPlayers(rd, opt, L => (L[job.action] ? job.action : 'stand'));
    rd.playDealer();
    const seat = rd.seats[0];
    if (wantLogs && logs.length < LOG_LIMIT) {
      logs.push({
        dealer: rd.dealer.map(KSU.cardText), dealerOutcome: rd.dealerOutcome(),
        hands: seat.hands.map(x => ({ cards: x.cards.map(KSU.cardText), total: BJ.handTotal(x.cards), actions: x.actions.slice(), result: x.result, profit: x.profit, note: x.note || '', free: x.freeDouble, freeSplit: x.freeSplit })),
        net: seat.net,
        others: othersLog(rd)
      });
    }
    // 跟遊戲「模擬」頁同一套統計方式（Simulator.step()）
    S.rounds++;
    let wager = 0;
    seat.hands.forEach(x => {
      S.hands++;
      wager += x.stake;
      if (x.result === 'W') S.hW++; else if (x.result === 'L') S.hL++; else S.hP++;
      if (x.isBJ) S.bj++;
      if (x.bust) S.bust++;
      if (x.surrendered) S.surrender++;
      if (x.evenMoney) S.even++;
      if (x.doubled) { if (x.freeDouble) { S.dblFree++; if (x.result === 'W') S.dblFreeW++; } else { S.dbl++; if (x.result === 'W') S.dblW++; } }
      if (x.fromSplit) { S.splitHands++; if (x.result === 'W') S.splitW++; }
    });
    S.wagered += wager;
    S.net += seat.net;
    S.acc.add(seat.net / 1);
    if (seat.result === 'W') S.rW++; else if (seat.result === 'L') S.rL++; else S.rP++;
    shoe.endRound();
  }

  // 投降：玩家固定輸半注，不模擬玩家；統計「投降後莊家如果繼續補牌」的結果
  function playSurrender(R, shoe, opt, job, D, logs, wantLogs, others) {
    shoe.shuffle();
    const rd = newRound(R, shoe, job, others);
    // 自己投降（牌收回牌靴的規則會在這裡把玩家的牌洗回去），其他玩家照最佳策略打完；莊家下面自己補（不管有沒有人還在場都補完）
    playPlayers(rd, opt, L => (L.surrender ? 'surrender' : 'stand'));
    const dealer = rd.dealer.slice();
    dealer.push(shoe.draw()); // 莊家第二張
    const bj = BJ.isTwoCard21(dealer);
    if (!bj) {
      for (;;) {
        const inf = BJ.handInfo(dealer);
        if (inf.total < 17 || (inf.total === 17 && inf.soft && R.dealerHitSoft17)) dealer.push(shoe.draw());
        else break;
      }
    }
    const t = BJ.handTotal(dealer);
    const out = bj ? 'BJ' : (t === 22 && R.dealer22Push) ? '22' : t > 21 ? 'bust' : String(t);
    D[out]++; D.rounds++;
    if (wantLogs && logs.length < LOG_LIMIT) logs.push({ player: rd.seats[0].hands[0].cards.map(KSU.cardText), dealer: dealer.map(KSU.cardText), total: t, out, others: othersLog(rd) });
    shoe.endRound();
  }

  /* 一段工作（一個「格子＋動作」的全部或其中一段局數）：step(ms) 每次跑一小段時間，回傳是否跑完 */
  function makeRunner(R, baseCounts, opt, job, n, wantLogs, others) {
    others = Math.max(0, others | 0);
    const shoe = new KSU.Shoe({ counts: baseCounts, penetration: 1 });
    const isSur = job.action === 'surrender';
    const S = isSur ? null : newStats();
    const D = isSur ? newDealerStats() : null;
    const logs = [];
    const r = {
      done: 0,
      step(ms) {
        const t0 = Date.now();
        while (r.done < n && Date.now() - t0 < ms) {
          // 一次跑 64 局再看時間，少呼叫 Date.now()
          for (let k = 0; k < 64 && r.done < n; k++, r.done++) {
            if (isSur) playSurrender(R, shoe, opt, job, D, logs, wantLogs, others);
            else playOne(R, shoe, opt, job, S, logs, wantLogs, others);
          }
        }
        return r.done >= n;
      },
      result() { return isSur ? { D, logs } : { S, logs }; }
    };
    return r;
  }

  /* 合併同一個「格子＋動作」拆成好幾段（分給不同 Worker）的結果：計數相加；Acc 的 n/sum/sq 相加；局紀錄用第一段的 */
  function mergeResults(parts) {
    const first = parts[0];
    if (first.D) {
      const D = newDealerStats();
      parts.forEach(p => Object.keys(D).forEach(k => { D[k] += p.D[k] || 0; }));
      return { D, logs: first.logs };
    }
    const S = newStats();
    parts.forEach(p => Object.keys(S).forEach(k => {
      if (k === 'acc') { S.acc.n += p.S.acc.n; S.acc.sum += p.S.acc.sum; S.acc.sq += p.S.acc.sq; }
      else S[k] += p.S[k] || 0;
    }));
    return { S, logs: first.logs };
  }

  root.KSVerifySim = { LOG_LIMIT, DEALER_OUTS, makeRunner, mergeResults, newStats, newDealerStats };

  /* ---------------- Worker 模式：收到工作就一路跑完，每 0.2 秒回報一次進度 ---------------- */
  if (isWorker) {
    let optCache = { key: null, opt: null };
    root.onmessage = e => {
      const m = e.data;
      if (!m || m.type !== 'run') return;
      try {
        let opt = null;
        if (m.job.action !== 'surrender' || m.others > 0) { // 投降但有其他玩家：他們也要照最佳策略打
          const key = JSON.stringify([m.R, m.baseCounts]);
          if (optCache.key !== key) optCache = { key, opt: BJ.generateOptimalStrategy(m.R, m.baseCounts) };
          opt = optCache.opt;
        }
        const runner = makeRunner(m.R, m.baseCounts, opt, m.job, m.n, m.wantLogs, m.others);
        while (!runner.step(200)) root.postMessage({ type: 'progress', id: m.id, done: runner.done });
        root.postMessage({ type: 'done', id: m.id, done: runner.done, res: runner.result() });
      } catch (err) {
        root.postMessage({ type: 'error', id: m.id, message: String(err && err.stack || err) });
      }
    };
  }
})(typeof window !== 'undefined' ? window : self);
