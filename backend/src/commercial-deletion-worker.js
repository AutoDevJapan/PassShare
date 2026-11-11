import {runDueDeletions} from './commercial-data-deletion.js';

// One bounded flight per backend process. Row locks make duplicate processes
// safe; a cursor also advances past retained requests instead of starving later
// consented targets. No ad-hoc discovery of boxes or billing-derived ownership.
export function startDueDeletionWorker(pool,{intervalMs=60000,run=runDueDeletions}={}){
 if(!pool)return{stop:async()=>{}};
 if(!Number.isInteger(intervalMs)||intervalMs<10)throw Error('Invalid worker interval');
 let stopped=false,timer,flight,after=null;
 const tick=()=>{
  if(stopped)return;
  flight=(async()=>{try{const result=await run(pool,{limit:20,after});after=result.nextAfter;}catch(error){if(typeof error?.deletionNextAfter==='string'&&/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(error.deletionNextAfter))after=error.deletionNextAfter;console.error('Scheduled deletion batch stopped at a failed request; earlier committed requests remain completed');}finally{if(!stopped){timer=setTimeout(tick,intervalMs);timer.unref();}}})();
 };
 timer=setTimeout(tick,0);timer.unref();
 return{async stop(){stopped=true;clearTimeout(timer);await flight;}};
}
