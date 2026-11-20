import { el } from './dom.js';
import { apiFetch } from './api.js';
import { toast } from './leads-ui.js';

// Kept separate from estimated opportunity value. Won alone never invents a signature.
export function signedAgreementCard(prospect) {
  const c=el('section','card');c.append(el('p','eyebrow','Signed business · confirmed facts'));
  const fields={};
  for(const [key,label,type] of [['signed_on','Signed date','date'],['amount','Signed amount','number'],['currency','Currency (EUR, USD…)','text'],['evidence','Signed agreement reference','text']]) {
    const wrap=el('label','ow-field');wrap.append(el('span',null,label));
    const input=el('input','text-input');input.type=type;if(type==='number'){input.min='0';input.step='.01';}
    input.value=key==='currency'?'EUR':'';fields[key]=input;wrap.append(input);c.append(wrap);
  }
  const save=el('button','btn small','Save confirmed agreement');save.type='button';
  save.addEventListener('click',async()=>{
    save.disabled=true;
    try {
      if(!fields.amount.value.trim())throw new Error('Enter the signed amount');
      const amount=Number(fields.amount.value);
      if(!Number.isFinite(amount) || amount<0)throw new Error('Enter a valid amount');
      await apiFetch(`/api/outreach/agreements/${prospect.id}`,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({signed_on:fields.signed_on.value,amount_cents:Math.round(amount*100),currency:fields.currency.value.toUpperCase().trim(),evidence:fields.evidence.value})});toast('Signed agreement recorded. Payments remain separate.');
    }catch(e){toast(e.message);}finally{save.disabled=false;}
  });c.append(save);
  apiFetch(`/api/outreach/agreements/${prospect.id}`).then(({agreement:a})=>{if(!a)return;fields.signed_on.value=a.signed_on;fields.amount.value=String(a.amount_cents/100);fields.currency.value=a.currency;fields.evidence.value=a.evidence;}).catch(()=>toast('Could not load signed agreement details'));
  return c;
}
