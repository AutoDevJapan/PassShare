import {jstDate} from './commercial-entitlement.js';

export const planInput=p=>p.type==='personal'?{type:p.type,users:p.users}:{type:p.type,administrators:p.administrators,members:p.members};

// A paid cycle and its separately paid in-cycle additions are canonical.
// The old current_plan column remains the requested renewal plan and fallback
// for legacy periods; it must not overwrite a prepaid cycle's funded plan.
export async function currentBillingPlan(c,r,nowMs=Date.now()){
 const day=jstDate(nowMs);
 const p=(await c.query("SELECT cycle,billing_plan FROM commercial_live_periods WHERE contract_id=$1 AND disposition='effective' AND period_start<=$2::date ORDER BY cycle DESC LIMIT 1",[r.id,day])).rows[0];
 if(!p?.billing_plan)return r.current_plan??r.quote.plan;
 const addition=(await c.query("SELECT quote->'requestedPlan' plan FROM commercial_seat_changes WHERE contract_id=$1 AND state='applied' AND (quote->>'billingCycle')::integer=$2 ORDER BY applied_at DESC,id DESC LIMIT 1",[r.id,p.cycle])).rows[0];
 return addition?.plan??p.billing_plan;
}

export async function renewalBillingPlan(c,r,cycle){
 const funded=(await c.query("SELECT quote->'requestedPlan' plan FROM commercial_seat_decreases WHERE contract_id=$1 AND state IN ('funded','settlement_review') AND target_cycle<=$2 AND base_revision=$3 ORDER BY target_cycle DESC,id DESC LIMIT 1",[r.id,cycle,r.seat_revision])).rows[0];
 return funded?.plan??r.current_plan??r.quote.plan;
}

// Legacy invoices lack a separate plan-agreement selector. An exact earlier
// cycle/addition price is still paid evidence, with adjustment review instead
// of silently shortening a valid paid period after a newer owner request.
export async function earlierRenewalPlan(c,r,cycle,amount){
 const previous=(await c.query('SELECT billing_plan plan FROM commercial_live_periods WHERE contract_id=$1 AND cycle<$2 AND billing_plan IS NOT NULL ORDER BY cycle DESC',[r.id,cycle])).rows;
 const additions=(await c.query("SELECT quote->'requestedPlan' plan,quote->'currentPlan' before_plan FROM commercial_seat_changes WHERE contract_id=$1 AND state='applied' AND (quote->>'billingCycle')::integer<$2 ORDER BY applied_at DESC,id DESC",[r.id,cycle])).rows;
 const basis=r.quote.plan,maintenance=BigInt(r.quote.monthlyMaintenanceJpy??0);
 const price=p=>{try{if(!p||p.type!==basis.type)return null;return maintenance+(p.type==='personal'?BigInt(p.users)*BigInt(basis.unitMonthlyJpy):BigInt(p.administrators)*BigInt(basis.administratorUnitMonthlyJpy)+BigInt(p.members)*BigInt(basis.memberUnitMonthlyJpy));}catch{return null;}};
 const matching=[...additions.flatMap(x=>[x.plan,x.before_plan]),...previous.map(x=>x.plan),basis].filter(p=>price(p)===BigInt(amount));
 const unique=new Map(matching.map(p=>[JSON.stringify(planInput(p)),p]));
 return unique.size===1?[...unique.values()][0]:null;
}
