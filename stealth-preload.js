// ページのJSが実行される前に注入されるステルススクリプト
// (Electron の setPreloads で使用)
(function() {
  try {
    Object.defineProperty(navigator, 'webdriver', {
      get: () => undefined,
      configurable: true
    });
  } catch(e) {}

  try {
    if (!window.chrome) {
      window.chrome = {
        app: { isInstalled: false },
        runtime: {},
        csi: function(){},
        loadTimes: function(){}
      };
    }
  } catch(e) {}

  try {
    const originalQuery = window.navigator.permissions
      ? window.navigator.permissions.query.bind(window.navigator.permissions)
      : null;
    if (originalQuery) {
      window.navigator.permissions.query = (parameters) =>
        parameters.name === 'notifications'
          ? Promise.resolve({ state: Notification.permission })
          : originalQuery(parameters);
    }
  } catch(e) {}
})();
