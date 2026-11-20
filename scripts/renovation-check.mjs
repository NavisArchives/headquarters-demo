// Only the isolated demo: never navigate to a user-supplied host or live data.
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
// The demo's password, read the same way axe-check does; never printed.
const password=readFileSync(new URL('../.dev.vars', import.meta.url),'utf8').split('\n').find((l)=>l.startsWith('HQ_PASSWORD='))?.slice('HQ_PASSWORD='.length).trim().replace(/^["']|["']$/g,'');
const base='http://127.0.0.1:8790'; // the demo's registered port (npm run demo)
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  const login=await context.request.post(`${base}/login`,{form:{password}});
  if(login.status()>=400)throw new Error('Demo login failed');
  const check=await context.request.get(`${base}/api/environment`);
  if((await check.json()).demo!==true)throw new Error('This is not the fictional demo');
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const results=[];
  for(const [width,height] of [[1440,1000],[1280,800],[390,844]]) {
    await page.setViewportSize({width,height});
    for(const path of ['/outreach','/outreach?view=today','/outreach?view=planner','/outreach?view=batches','/outreach?view=sent','/outreach?view=no_contact','/leads','/pipeline','/finance','/reports']) {
      await page.goto(base+path);await page.waitForTimeout(450);
      if(await page.getByText('Could not load outreach',{exact:true}).count())throw new Error(`Outreach failed: ${path}`);
      const sizes=await page.evaluate(()=>({x:document.documentElement.scrollWidth-innerWidth,y:document.documentElement.scrollHeight-innerHeight}));
      results.push({width,path,...sizes});
      if(width===1440 && path==='/outreach')await page.screenshot({path:'/private/tmp/hq-renovation-overview.png',fullPage:true});
      if(width===390 && path==='/outreach')await page.screenshot({path:'/private/tmp/hq-renovation-mobile.png',fullPage:true});
    }
  }
  if(errors.length)throw new Error(errors.join('\n'));
  writeFileSync('/private/tmp/hq-renovation-visual-results.json',JSON.stringify(results,null,2));
  console.log(JSON.stringify(results));
}finally{await browser.close();}
