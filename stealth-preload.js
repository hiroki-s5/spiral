;(function(){
  const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.6998.89 Safari/537.36';
  try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true});}catch(e){}
  try{Object.defineProperty(navigator,'userAgent',{get:()=>UA,configurable:true});}catch(e){}
  try{Object.defineProperty(navigator,'appVersion',{get:()=>UA.replace('Mozilla/',''),configurable:true});}catch(e){}
  try{if(!window.chrome)window.chrome={app:{isInstalled:false},runtime:{},csi:function(){},loadTimes:function(){}};}catch(e){}
  try{Object.defineProperty(navigator,'languages',{get:()=>['ja-JP','ja','en-US','en'],configurable:true});}catch(e){}
  try{if(navigator.plugins.length===0)Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5],configurable:true});}catch(e){}
  // userAgentDataの上書き（SlackはこちらもチェックするためChrome 134と偽装）
  try{
    Object.defineProperty(navigator,'userAgentData',{get:()=>({
      brands:[{brand:'Chromium',version:'134'},{brand:'Google Chrome',version:'134'},{brand:'Not-A.Brand',version:'24'}],
      mobile:false,
      platform:'macOS',
      getHighEntropyValues:()=>Promise.resolve({})
    }),configurable:true});
  }catch(e){}
  // process.versionsからElectronを隠す
  try{
    if(window.process && window.process.versions){
      Object.defineProperty(window.process.versions,'electron',{get:()=>undefined,configurable:true});
    }
  }catch(e){}
  // _electronフラグを隠す
  try{ delete window.__electron; }catch(e){}
  try{ delete window.electronRemote; }catch(e){}
})();

// Chromeウェブストア拡張機能インストール用ブリッジ
const { contextBridge, ipcRenderer } = require('electron');
try {
  contextBridge.exposeInMainWorld('_spiralInstallExt', function(extId) {
    return ipcRenderer.invoke('ext:install', extId);
  });
} catch(e) {}
