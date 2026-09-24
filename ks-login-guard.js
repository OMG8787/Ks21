// 登入檢查（放在 <head>，頁面畫出來之前執行）：
// 沒有登入金鑰 cookie 就回到 index.html 登入；有金鑰時，遊戲頁載入後會再向資料庫驗證（被踢除的裝置會被導回登入頁）
// 需先載入 ks-config.js；apiUrl 留空時為本機模式，不檢查登入
(function () {
    var cfg = window.KS_CONFIG || {};
    if (!cfg.apiUrl) return;
    if (/(?:^|;\s*)ks_key=[^;]+/.test(document.cookie)) return;
    var page = location.pathname.split('/').pop() || '';
    location.replace('index.html?next=' + encodeURIComponent(page));
})();
