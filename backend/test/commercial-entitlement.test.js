import assert from 'node:assert/strict';import {test} from 'node:test';
import {entitlementState,exportDecision,jstDate} from '../src/commercial-entitlement.js';
const at=s=>Date.parse(s+'T03:00:00Z');const live={periodStart:'2026-01-31',periodEnd:'2026-02-28',evidence:'provider_live'};
const actor={sessionValid:true,accountRemoved:false,identityConfirmed:true,billingAdministrator:true,membershipActive:true,hasExportScope:true};
test('sandbox evidence never becomes an effective entitlement',()=>{
 const sandbox={...live,evidence:'provider_test_sandbox'};
 for(const d of ['2026-01-31','2026-02-10','2026-03-05']){const s=entitlementState({periods:[sandbox],nowMs:at(d)});assert.equal(s.effective,false);assert.equal(s.state,'test_evidence_only');assert.equal(s.exportWindow,null);}
 assert.equal(entitlementState({periods:[],nowMs:at('2026-02-10')}).state,'none');
});
test('live period is active through the day before renewal and cancel keeps access to paid end',()=>{
 assert.equal(entitlementState({periods:[live],nowMs:at('2026-01-30')}).state,'not_started');
 for(const d of ['2026-01-31','2026-02-27']){const s=entitlementState({periods:[live],nowMs:at(d)});assert.deepEqual([s.state,s.effective,s.paidThrough],['active',true,'2026-02-28']);}
 const c=entitlementState({periods:[live],cancelAtPeriodEnd:true,nowMs:at('2026-02-27')});assert.deepEqual([c.state,c.effective,c.cancelScheduled],['active_cancel_scheduled',true,true]);
 const end=entitlementState({periods:[live],cancelAtPeriodEnd:true,nowMs:at('2026-02-28')});assert.equal(end.effective,false);assert.equal(end.state,'export_window');
});
test('30 calendar day export window starts at paid end and closes exclusive',async()=>{
 for(const [d,open] of [['2026-02-28',true],['2026-03-29',true],['2026-03-30',false]]){
  const s=entitlementState({periods:[live],nowMs:at(d)});assert.equal(s.effective,false);assert.equal(s.exportWindow.open,open);assert.equal(s.exportWindow.endExclusive,'2026-03-30');
  const decision=await exportDecision({entitlement:s,actor});assert.equal(decision.allowed,open);if(open){assert.equal(decision.restoresIdentityMembershipOrKeys,false);assert.equal(decision.exportWindowEndExclusive,'2026-03-30');}
 }
 assert.equal(entitlementState({periods:[live],nowMs:at('2026-03-30')}).state,'closed');
});
test('JST day boundary uses server clock',()=>{assert.equal(jstDate(Date.parse('2026-01-30T15:00:00Z')),'2026-01-31');assert.equal(jstDate(Date.parse('2026-01-30T14:59:59Z')),'2026-01-30');});
test('export without a valid actor claim is rejected by the native decision',async()=>{
 const s=entitlementState({periods:[live],nowMs:at('2026-03-01')});
 await assert.rejects(exportDecision({entitlement:s,actor:{...actor,hasExportScope:false}}));
});