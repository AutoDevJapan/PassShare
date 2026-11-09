import {nativeMutation} from './lib/native-mutations.js';

// Only provider-verified live payment evidence may ever grant access. The sandbox
// ledger (provider_test_sandbox) is test evidence and never becomes an entitlement.
export const EFFECTIVE_EVIDENCE=new Set(['provider_live']);
const JST_MS=9*3600*1000;
export const jstDate=ms=>new Date(ms+JST_MS).toISOString().slice(0,10);
const day=s=>Date.parse(s+'T00:00:00Z')/86400000;

// Periods are half-open calendar dates [periodStart, periodEnd) in JST. Dates are
// derived by the server from stored rows and its own clock, never from a client.
export function entitlementState({periods,cancelAtPeriodEnd=false,nowMs}){
 const today=jstDate(nowMs),sorted=[...periods].sort((a,b)=>a.periodStart<b.periodStart?-1:1);
 const live=sorted.filter(p=>EFFECTIVE_EVIDENCE.has(p.evidence));
 const base={today,effective:false,paidThrough:null,cancelScheduled:false,exportWindow:null};
 if(!live.length)return {...base,state:sorted.length?'test_evidence_only':'none'};
 const current=live.find(p=>p.periodStart<=today&&today<p.periodEnd);
 if(current)return {...base,state:cancelAtPeriodEnd?'active_cancel_scheduled':'active',effective:true,paidThrough:current.periodEnd,cancelScheduled:cancelAtPeriodEnd};
 const last=live.at(-1);
 if(today<last.periodStart)return {...base,state:'not_started'};
 const end=last.periodEnd,until=new Date((day(end)+30)*86400000).toISOString().slice(0,10);
 const open=end<=today&&today<until;
 return {...base,state:open?'export_window':'closed',paidThrough:end,exportWindow:{startInclusive:end,endExclusive:until,open}};
}

// Export is a proposal only: current identity, membership and key scope are still required.
export async function exportDecision({entitlement,actor}){
 if(!entitlement.exportWindow?.open)return {allowed:false,reason:'outside_export_window'};
 const body=await nativeMutation({command:'commercial-lifecycle-decision',operation:'post-end-export',contractEnd:entitlement.paidThrough,requestDate:entitlement.today,actor});
 return {allowed:true,exportWindowEndExclusive:body.exportWindowEndExclusive,restoresIdentityMembershipOrKeys:false};
}