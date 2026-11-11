// Verification-image launcher only. Not copied into the production API image.
import {existsSync} from 'node:fs';
let db;try{db=new URL(process.env.DATABASE_URL??'')}catch{throw Error('Synthetic verification database required')}
if(!existsSync('/.dockerenv')||process.env.PASSSHARE_RESTORE_DRILL!=='synthetic-container-v1'||db.hostname!=='postgres'||!['/drill_source','/drill_restored'].includes(db.pathname))throw Error('Synthetic verification container required');
const {createApp}=await import('./src/app.js');
const {refundProviderFixture,liveRefundProviderFixture}=await import('./test/helpers/refund-provider-fixture.js');
// Fake test credential and private loopback transport. Provider current state is
// seeded separately from webhook delivery; it is not a real Stripe observation.
const provider=await refundProviderFixture('acct_restorefixture','connect',{port:8999,stateControl:true});
const liveProvider=await liveRefundProviderFixture('acct_restorelive','connect',{port:8998,stateControl:true});
const {app}=await createApp({testRefundLookup:provider.lookup,liveRefundLookup:liveProvider.lookup});
if(db.pathname==='/drill_restored'&&existsSync('/tmp/passshare-drill-current-qualified')){
 const {Pool}=await import('pg'),pool=new Pool({connectionString:process.env.DATABASE_URL}),{runDueDeletions}=await import('./src/commercial-data-deletion.js');
 try{const result=await runDueDeletions(pool,{limit:100});if(result.completed!==0)throw Error('Old restored automatic deletion consent must not run before current reapproval');}finally{await pool.end();}
}
app.listen(Number(process.env.PORT??8080));
