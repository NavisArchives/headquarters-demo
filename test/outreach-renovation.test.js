import { describe,it,expect } from 'vitest';
import { freshDatabase } from './helpers/d1.js';
import { logMessage } from '../src/worker/message-log.js';
import { createBatch,approveBatch,saveSender,cockpit,recordAgreement,cancelBatch } from '../src/worker/outreach.js';
import { responseDeadline } from '../src/worker/business-hours.js';
import { eligibility } from '../src/worker/outreach-policy.js';
import { handleOutreach } from '../src/worker/api/outreach.js';
import { setHqTimeZone } from '../src/worker/db.js';

const now=new Date('2026-11-18T15:00:00.000Z');
const item={uid:'d/a',subject:'A personal note',body:'A useful message. A simple no thanks is enough.',lang:'EN'};
async function fixture(fn) {
  const {database:db,dispose}=await freshDatabase();
  try {
    setHqTimeZone('America/Lima');
    await db.prepare("INSERT INTO datasets(key,business,title,tier_hot,tier_warm,imported_at) VALUES('d','UGC','D',70,50,'x')").run();
    await db.prepare(`INSERT INTO leads(uid,dataset,id,business,name,website,category,country,languages,email,score,tier,payload,imported_at)
      VALUES('d/a','d','a','UGC','A','','X','BE','["EN"]','a@example.com',80,'Hot','{}','x'),
      ('d/b','d','b','UGC','B','','X','BE','["EN"]','b@example.com',70,'Hot','{}','x')`).run();
    await saveSender(db,{email:'andy@example.com',daily_limit:2,paused:false});
    await fn(db);
  } finally { await dispose(); }
}
const make=(db,items=[item])=>createBatch(db,{day:'2026-11-18',sender:'andy@example.com',items},now);

describe('a reviewable daily batch',()=>{
  it('stores exact content, approves once, and never sends',()=>fixture(async db=>{
    const b=await make(db);expect(b.items[0].body).toBe(item.body);
    const approved=await approveBatch(db,b.id,b.content_hash,'Andy',now);
    expect(approved.status).toBe('approved');expect(approved.approved_by).toBe('Andy');
    await expect(approveBatch(db,b.id,b.content_hash,'Andy',now)).rejects.toThrow(/reviewed/);
    const response=await handleOutreach(new Request(`https://hq.test/api/outreach/batches/${b.id}/send`,{method:'POST'}),{DB:db},new URL(`https://hq.test/api/outreach/batches/${b.id}/send`));
    expect(response.status).toBe(409);
    expect((await db.prepare("SELECT COUNT(*) n FROM lead_events WHERE kind='sent'").first()).n).toBe(0);
  }));
  it('blocks a reply arriving between preparation and approval',()=>fixture(async db=>{
    const b=await make(db);
    await db.prepare("INSERT INTO lead_state(uid,stage,last_reply_at,updated_at) VALUES('d/a','replied',?,'x')").bind(now.toISOString()).run();
    await expect(approveBatch(db,b.id,b.content_hash,'Andy',now)).rejects.toThrow();
    expect((await db.prepare('SELECT COUNT(*) n FROM outreach_reservations').first()).n).toBe(0);
  }));
  it('blocks suppression, stale days and content hash changes',()=>fixture(async db=>{
    const b=await make(db);
    await expect(approveBatch(db,b.id,'wrong','Andy',now)).rejects.toThrow();
    await expect(approveBatch(db,b.id,b.content_hash,'Andy',new Date('2026-11-19T15:00Z'))).rejects.toThrow(/stale/);
    await db.prepare("INSERT INTO email_suppression(email,reason,source,at) VALUES('a@example.com','no','test','x')").run();
    await expect(approveBatch(db,b.id,b.content_hash,'Andy',now)).rejects.toThrow(/suppressed/);
  }));
  it('does not reserve the same inbox twice and frees cancelled capacity',()=>fixture(async db=>{
    const a=await make(db),b=await make(db);
    await approveBatch(db,a.id,a.content_hash,'Andy',now);
    await expect(approveBatch(db,b.id,b.content_hash,'Andy',now)).rejects.toThrow();
    expect((await db.prepare('SELECT status FROM outreach_batches WHERE id=?').bind(b.id).first()).status).toBe('draft');
    await cancelBatch(db,a.id);
    expect((await db.prepare('SELECT COUNT(*) n FROM outreach_reservations').first()).n).toBe(0);
    await approveBatch(db,b.id,b.content_hash,'Andy',now);
  }));
  it('respects lower sender limits including previously logged sends',()=>fixture(async db=>{
    await saveSender(db,{email:'andy@example.com',daily_limit:1,paused:false});
    await logMessage(db,'d/b',{key:'gmail:old',at:now.toISOString(),to:'b@example.com',sender:'andy@example.com'});
    const b=await make(db);
    await expect(approveBatch(db,b.id,b.content_hash,'Andy',now)).rejects.toThrow(/capacity/);
  }));
});

describe('message integrity',()=>{
  it('deduplicates an actual message across callers and maintains cadence',()=>fixture(async db=>{
    const send={key:'gmail:account:message1',at:'2026-11-18T15:00:00Z',to:'a@example.com',subject:'Exact',body:'Original',sender:'andy@example.com'};
    await logMessage(db,'d/a',send);await logMessage(db,'d/a',send);
    expect((await db.prepare("SELECT COUNT(*) n FROM lead_events WHERE kind='sent'").first()).n).toBe(1);
    expect((await db.prepare("SELECT follow_up FROM lead_state WHERE uid='d/a'").first()).follow_up).toBe('2026-11-25');
    await logMessage(db,'d/a',{...send,key:'gmail:account:message2',at:'2026-11-25T15:00:00Z'});
    expect((await db.prepare("SELECT follow_up FROM lead_state WHERE uid='d/a'").first()).follow_up).toBe('2026-12-09');
  }));
  it('rolls the event back when a later statement fails',()=>fixture(async db=>{
    await db.prepare("CREATE TRIGGER fail_state BEFORE INSERT ON lead_state BEGIN SELECT RAISE(ABORT,'test stop'); END").run();
    await expect(logMessage(db,'d/a',{key:'message1',at:now.toISOString()})).rejects.toThrow();
    expect((await db.prepare("SELECT COUNT(*) n FROM lead_events WHERE message_key='message1'").first()).n).toBe(0);
  }));
});

describe('clear commercial facts',()=>{
  it('keeps signed and paid revenue separate and requires evidence',()=>fixture(async db=>{
    const row=await db.prepare("INSERT INTO prospects(name,stage,created_at,updated_at) VALUES('Deal','won','x','x') RETURNING id").first();
    await expect(recordAgreement(db,row.id,{signed_on:'2026-11-18',amount_cents:10000,currency:'EUR',evidence:''})).rejects.toThrow(/evidence/);
    await recordAgreement(db,row.id,{signed_on:'2026-11-18',amount_cents:10000,currency:'EUR',evidence:'Signed agreement reference'});
    const data=await cockpit(db,'America/Lima',now);expect(data.signed[0].cents).toBe(10000);expect(data.paid).toEqual([]);
  }));
  it('excludes weekends from the four business hour target',()=>{
    expect(responseDeadline('2026-11-20T21:00:00Z','America/Lima')).toBe('2026-11-23T17:00:00.000Z');
  });
  it('blocks legal, duplicate and sequence risks',()=>{
    const base={dataset:'d',business:'UGC',email:'a@example.com',country:'CH',languages:['EN']};
    expect(eligibility(base,now).reasons).toContain('personal_review_required');
    expect(eligibility({...base,country:'NL'},now).reasons).toContain('nl_company_unverified');
    expect(eligibility({...base,country:'BE',suppressed:1},now).eligible).toBe(false);
    expect(eligibility({...base,country:'BE',sends:3},now).reasons).toContain('sequence_complete');
  });
});

// The screenshot's "Mark X as passed" proposals are now automatic bookkeeping.
describe('automatic decline handling',()=>{
  it('suppresses, closes the lead and follow-ups without creating a mission',()=>fixture(async db=>{
    const {fileReviewWithProposals}=await import('../src/worker/db-replies.js');
    await db.prepare("INSERT INTO lead_state(uid,stage,follow_up,updated_at) VALUES('d/a','sent','2026-11-20','x')").run();
    const input={message_id:'decline-1',uid:'d/a',from_email:'a@example.com',intent:'not_interested',summary:'No thanks',asks:[],language:'EN',received_at:now.toISOString()};
    const result=await fileReviewWithProposals(db,input,[{title:'Mark A as passed'}]);
    expect(result.proposed).toBe(0);expect(result.review.status).toBe('handled');
    expect((await db.prepare("SELECT stage,follow_up FROM lead_state WHERE uid='d/a'").first())).toEqual({stage:'passed',follow_up:null});
    expect((await db.prepare("SELECT reason FROM email_suppression WHERE email='a@example.com'").first()).reason).toBe('declined outreach');
    expect((await db.prepare("SELECT COUNT(*) n FROM missions WHERE source_review_id=?").bind(result.review.id).first()).n).toBe(0);
    expect((await fileReviewWithProposals(db,input,[])).created).toBe(false);
  }));
  it('never turns an existing client or won lead into a lost client',()=>fixture(async db=>{
    const {fileReviewWithProposals}=await import('../src/worker/db-replies.js');
    await db.prepare("INSERT INTO clients(name,email,created_at) VALUES('Existing client','a@example.com','x')").run();
    await db.prepare("INSERT INTO lead_state(uid,stage,follow_up,updated_at) VALUES('d/a','won','2026-11-20','x')").run();
    await fileReviewWithProposals(db,{message_id:'client-no',uid:'d/a',from_email:'a@example.com',intent:'not_interested',summary:'No',asks:[],language:'EN'},[]);
    expect((await db.prepare("SELECT stage,follow_up FROM lead_state WHERE uid='d/a'").first())).toEqual({stage:'won',follow_up:null});
    expect((await db.prepare('SELECT COUNT(*) n FROM clients').first()).n).toBe(1);
    expect((await db.prepare("SELECT COUNT(*) n FROM email_suppression WHERE email='a@example.com'").first()).n).toBe(1);
  }));
});

describe('statistics remain honest',()=>{
  it('projects insert, correction and undo without rescanning the ledger',()=>fixture(async db=>{
    const saved=await logMessage(db,'d/a',{key:'projection:1',at:now.toISOString(),subject:'Known',body:'Known',sender:'andy@example.com'});
    expect((await cockpit(db,'America/Lima',now)).sent.today).toBe(1);
    expect((await cockpit(db,'America/Lima',now)).coverage.exact_content).toBe(1);
    await db.prepare('UPDATE lead_events SET subject=NULL WHERE id=?').bind(saved.id).run();
    expect((await cockpit(db,'America/Lima',now)).coverage.exact_content).toBe(0);
    await db.prepare('DELETE FROM lead_events WHERE id=?').bind(saved.id).run();
    const totals=await cockpit(db,'America/Lima',now);expect(totals.sent.all).toBe(0);expect(totals.sent.today).toBe(0);
  }));
});
