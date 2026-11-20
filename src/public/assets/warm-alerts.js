import { apiFetch } from './api.js';

export function startWarmAlerts() {
  let busy=false;
  const check=async()=>{
    if(busy || !('Notification' in window) || Notification.permission!=='granted') return;
    try {
      if(localStorage.getItem('hq.warm-alerts')!=='on') return;
      busy=true;
      const {queue}=await apiFetch('/api/outreach/cockpit');
      for(const item of queue.filter(x=>x.kind==='warm_reply')) {
        const key=`hq.alerted.${item.key}`;
        if(localStorage.getItem(key))continue;
        const registration=await navigator.serviceWorker?.getRegistration();
        if(registration)await registration.showNotification('A warm lead needs your answer',{body:item.title,tag:item.key,data:{href:item.href}});
        else {
          const note=new Notification('A warm lead needs your answer',{body:item.title,tag:item.key});
          note.onclick=()=>{window.focus();window.location.assign(item.href);};
        }
        localStorage.setItem(key,'1');
      }
    }catch{/* Queue remains authoritative. Closed-app push is not enabled. */}finally{busy=false;}
  };
  const timer=setInterval(check,60000);
  window.addEventListener('focus',check);
  window.addEventListener('pagehide',()=>{clearInterval(timer);window.removeEventListener('focus',check);},{once:true});
}
