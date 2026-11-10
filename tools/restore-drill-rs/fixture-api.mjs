// Verification-image launcher only. Not copied into the production API image.
import {existsSync} from 'node:fs';
let db;try{db=new URL(process.env.DATABASE_URL??'')}catch{throw Error('Synthetic verification database required')}
if(!existsSync('/.dockerenv')||process.env.PASSSHARE_RESTORE_DRILL!=='synthetic-container-v1'||db.hostname!=='postgres'||!['/drill_source','/drill_restored'].includes(db.pathname))throw Error('Synthetic verification container required');
const {createApp}=await import('./src/app.js');
const {refundProviderFixture}=await import('./test/helpers/refund-provider-fixture.js');
// Fake test credential and private loopback transport. Provider current state is
// seeded separately from webhook delivery; it is not a real Stripe observation.
const provider=await refundProviderFixture('acct_restorefixture','connect',{port:8999,stateControl:true});
const {app}=await createApp({testRefundLookup:provider.lookup});
app.listen(Number(process.env.PORT??8080));
