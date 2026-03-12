;(function(){
  try{Object.defineProperty(navigator,'webdriver',{get:()=>undefined,configurable:true});}catch(e){}
  try{if(!window.chrome)window.chrome={app:{isInstalled:false},runtime:{},csi:function(){},loadTimes:function(){}};}catch(e){}
  try{Object.defineProperty(navigator,'languages',{get:()=>['ja-JP','ja','en-US','en'],configurable:true});}catch(e){}
  try{if(navigator.plugins.length===0)Object.defineProperty(navigator,'plugins',{get:()=>[1,2,3,4,5],configurable:true});}catch(e){}
})();
