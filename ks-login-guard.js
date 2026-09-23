// 登入檢查：未登入（或登入超過 12 小時）就回到 index.html 登入
// 需先載入 ks-config.js；apiUrl 留空時為本機模式，不檢查登入
(function () {
    var cfg = window.KS_CONFIG || {};
    if (!cfg.apiUrl) return;
    var s = null;
    try { s = JSON.parse(localStorage.getItem('ks_session') || 'null'); } catch (e) { s = null; }
    if (s && s.token && Date.now() - s.at <= 12 * 3600 * 1000) return;
    var page = location.pathname.split('/').pop() || '';
    location.replace('index.html?next=' + encodeURIComponent(page));
})();
