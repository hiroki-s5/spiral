;(function(){
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.7103.92 Safari/537.36';
  const CV = '136';
  const CFV = '136.0.7103.92';

  // --- navigator偽装 ---
  try{ Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true}); }catch(e){}
  try{ Object.defineProperty(navigator,'userAgent',{get:()=>UA,configurable:true}); }catch(e){}
  try{ Object.defineProperty(navigator,'appVersion',{get:()=>UA.replace('Mozilla/',''),configurable:true}); }catch(e){}
  try{ Object.defineProperty(navigator,'languages',{get:()=>['ja-JP','ja','en-US','en'],configurable:true}); }catch(e){}
  try{ if(navigator.plugins.length===0) Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5],configurable:true}); }catch(e){}
  try{
    Object.defineProperty(navigator,'userAgentData',{configurable:true,get:()=>({
      brands:[{brand:'Chromium',version:CV},{brand:'Google Chrome',version:CV},{brand:'Not-A.Brand',version:'24'}],
      mobile:false, platform:'macOS',
      getHighEntropyValues:(hints)=>Promise.resolve({
        architecture:'arm', bitness:'64',
        brands:[{brand:'Chromium',version:CV},{brand:'Google Chrome',version:CV},{brand:'Not-A.Brand',version:'24'}],
        fullVersionList:[{brand:'Chromium',version:CFV},{brand:'Google Chrome',version:CFV},{brand:'Not-A.Brand',version:'24.0.0.0'}],
        mobile:false, model:'', platform:'macOS', platformVersion:'15.0.0', uaFullVersion:CFV,
      }),
      toJSON:()=>({brands:[{brand:'Chromium',version:CV},{brand:'Google Chrome',version:CV}],mobile:false,platform:'macOS'}),
    })});
  }catch(e){}

  // --- Electron痕跡を隠す ---
  try{ if(window.process?.versions) Object.defineProperty(window.process.versions,'electron',{get:()=>undefined,configurable:true}); }catch(e){}
  try{ delete window.__electron; }catch(e){}
  try{ delete window.electronRemote; }catch(e){}

  // --- chrome.* API完全偽装（ページJS実行前に注入） ---
  function makeStorage(ns){
    var _s={};
    return {
      get:function(k,cb){
        var r={};
        if(k==null){r=Object.assign({},_s);}
        else if(typeof k==='string'){r[k]=_s[k];}
        else if(Array.isArray(k)){k.forEach(function(x){r[x]=_s[x];});}
        else if(typeof k==='object'){Object.keys(k).forEach(function(x){r[x]=_s[x]!==undefined?_s[x]:k[x];});}
        if(cb)cb(r); return Promise.resolve(r);
      },
      set:function(items,cb){Object.assign(_s,items||{});if(cb)cb();return Promise.resolve();},
      remove:function(k,cb){(Array.isArray(k)?k:[k]).forEach(function(x){delete _s[x];});if(cb)cb();return Promise.resolve();},
      clear:function(cb){_s={};if(cb)cb();return Promise.resolve();},
      getBytesInUse:function(k,cb){if(cb)cb(0);return Promise.resolve(0);},
      onChanged:{addListener:function(){},removeListener:function(){}},
      QUOTA_BYTES:10485760,
    };
  }

  try{
    if(!window.chrome) window.chrome={};
    var c=window.chrome;

    c.app={
      isInstalled:false,
      getIsInstalled:function(cb){if(cb)cb(false);},
      installState:function(cb){if(cb)cb('not_installed');},
      runningState:function(){return 'cannot_run';},
      getDetails:function(){return null;},
    };
    c.runtime={
      id:undefined, lastError:null,
      onMessage:{addListener:function(){},removeListener:function(){},hasListener:function(){return false;}},
      onConnect:{addListener:function(){},removeListener:function(){}},
      onInstalled:{addListener:function(){},removeListener:function(){}},
      onStartup:{addListener:function(){},removeListener:function(){}},
      onSuspend:{addListener:function(){},removeListener:function(){}},
      sendMessage:function(){},
      connect:function(){return{postMessage:function(){},onMessage:{addListener:function(){}},onDisconnect:{addListener:function(){}},disconnect:function(){}};},
      getManifest:function(){return{};},
      getURL:function(p){return p;},
      reload:function(){},
      openOptionsPage:function(){},
      setUninstallURL:function(){},
    };
    c.management={
      getAll:function(cb){if(cb)cb([]);return Promise.resolve([]);},
      get:function(id,cb){if(cb)cb(undefined);return Promise.resolve(undefined);},
      getSelf:function(cb){if(cb)cb(undefined);return Promise.resolve(undefined);},
      install:function(o,cb){if(cb)cb();return Promise.resolve();},
      uninstall:function(id,o,cb){if(cb)cb();return Promise.resolve();},
      setEnabled:function(id,e,cb){if(cb)cb();return Promise.resolve();},
      onInstalled:{addListener:function(){},removeListener:function(){}},
      onUninstalled:{addListener:function(){},removeListener:function(){}},
      onEnabled:{addListener:function(){},removeListener:function(){}},
      onDisabled:{addListener:function(){},removeListener:function(){}},
    };
    c.storage={
      sync:makeStorage('sync'), local:makeStorage('local'),
      session:makeStorage('session'), managed:makeStorage('managed'),
      onChanged:{addListener:function(){},removeListener:function(){}},
    };
    c.identity={
      getAuthToken:function(d,cb){if(cb)cb(undefined);return Promise.resolve(undefined);},
      getProfileUserInfo:function(d,cb){var r={email:'',id:''};if(cb)cb(r);return Promise.resolve(r);},
      removeCachedAuthToken:function(d,cb){if(cb)cb();return Promise.resolve();},
      onSignInChanged:{addListener:function(){},removeListener:function(){}},
    };
    c.permissions={
      contains:function(p,cb){if(cb)cb(true);return Promise.resolve(true);},
      request:function(p,cb){if(cb)cb(true);return Promise.resolve(true);},
      getAll:function(cb){var r={permissions:[],origins:[]};if(cb)cb(r);return Promise.resolve(r);},
      remove:function(p,cb){if(cb)cb(true);return Promise.resolve(true);},
      onAdded:{addListener:function(){},removeListener:function(){}},
      onRemoved:{addListener:function(){},removeListener:function(){}},
    };
    c.tabs={
      query:function(q,cb){if(cb)cb([]);return Promise.resolve([]);},
      get:function(id,cb){if(cb)cb(undefined);return Promise.resolve(undefined);},
      getCurrent:function(cb){if(cb)cb(undefined);return Promise.resolve(undefined);},
      create:function(p,cb){if(cb)cb({});return Promise.resolve({});},
      update:function(id,p,cb){if(cb)cb({});return Promise.resolve({});},
      remove:function(id,cb){if(cb)cb();return Promise.resolve();},
      sendMessage:function(){},
      onActivated:{addListener:function(){},removeListener:function(){}},
      onUpdated:{addListener:function(){},removeListener:function(){}},
      onRemoved:{addListener:function(){},removeListener:function(){}},
    };
    c.cookies={
      get:function(d,cb){if(cb)cb(null);return Promise.resolve(null);},
      getAll:function(d,cb){if(cb)cb([]);return Promise.resolve([]);},
      set:function(d,cb){if(cb)cb(null);return Promise.resolve(null);},
      remove:function(d,cb){if(cb)cb(null);return Promise.resolve(null);},
      onChanged:{addListener:function(){},removeListener:function(){}},
    };
    c.browsingData={
      remove:function(o,t,cb){if(cb)cb();return Promise.resolve();},
      removeCache:function(o,cb){if(cb)cb();return Promise.resolve();},
      removeCookies:function(o,cb){if(cb)cb();return Promise.resolve();},
    };
    c.webstore={
      install:function(url,ok,fail){
        var m=[window.location.href,url||''].map(function(s){return s.match(/\/([a-z]{32})(?:[/?]|$)/);}).find(Boolean);
        if(!m){if(fail)fail('Extension ID not found');return;}
        window._spiralInstallExt(m[1]).then(function(r){r&&r.error?fail&&fail(r.error):ok&&ok();}).catch(function(e){fail&&fail(String(e));});
      },
      onInstallStageChanged:{addListener:function(){},removeListener:function(){}},
      onDownloadProgress:{addListener:function(){},removeListener:function(){}},
    };
    c.csi=function(){};
    c.loadTimes=function(){};
  }catch(e){}
})();

// Chromeウェブストア拡張機能インストール用ブリッジ
// contextIsolation: false なので window に直接置ける
const { ipcRenderer } = require('electron');
try {
  window._spiralInstallExt = function(extId) {
    return ipcRenderer.invoke('ext:install', extId);
  };
  // chrome.webstore.install もここで上書き（pageのwindowに直接届く）
  if (window.chrome) {
    window.chrome.webstore = {
      install: function(url, ok, fail) {
        var m = [window.location.href, url||''].map(function(s){ return s.match(/\/([a-z]{32})(?:[\/?]|$)/); }).find(Boolean);
        if (!m) { if(fail) fail('Extension ID not found'); return; }
        window._spiralInstallExt(m[1]).then(function(r){ r&&r.error ? (fail&&fail(r.error)) : (ok&&ok()); }).catch(function(e){ if(fail) fail(String(e)); });
      },
      onInstallStageChanged: { addListener: function(){}, removeListener: function(){} },
      onDownloadProgress:    { addListener: function(){}, removeListener: function(){} },
    };
  }
} catch(e) {}

// 左端ホバー検知
;(function() {
  let _atLeft = false;
  document.addEventListener('mousemove', function(e) {
    const now = e.clientX <= 20;
    if (now !== _atLeft) { _atLeft = now; ipcRenderer.send(now ? 'trig:enter' : 'trig:leave'); }
  }, { passive: true });
})();
