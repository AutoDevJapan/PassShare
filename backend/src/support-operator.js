import { createHash, randomBytes } from 'node:crypto';
import { requireCsrf } from './auth/csrf.js';
import { authHttpError, sendAuthError } from './auth/errors.js';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const denied = () => authHttpError(403,'PS024','Receipt operation is not authorized');
const hash = value => createHash('sha256').update(value).digest('hex');
const exact = (body,fields) => body && !Array.isArray(body) && Object.keys(body).length===fields.length && fields.every(k=>Object.hasOwn(body,k));

// These IDs are explicit deployment configuration, never email addresses or
// caller-supplied claims. No HTTP route can enroll an operator.
export function installSupportOperatorRoutes(router,{pool,operatorIds=[]}) {
 const operators = new Set(operatorIds.filter(uuid).map(id=>id.toLowerCase()));
 const transaction=async callback=>{
  if(!pool)throw authHttpError(503,'PS019','Persistent receipt operations unavailable');
  const c=await pool.connect();
  try{await c.query('BEGIN');const result=await callback(c);await c.query('COMMIT');return result;}
  catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 };
 // Lock identities first in a stable order, then sessions, then receipt. This
 // serializes logout/retirement with both consent and operator consumption.
 const lockActors=async(c,pairs)=>{
  const ids=[...new Set(pairs.map(p=>p.user))].sort();
  const users=await c.query('SELECT id FROM users WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[ids]);
  if(users.rowCount!==ids.length)throw denied();
  const sessions=await c.query('SELECT id,user_id,expires_at FROM sessions WHERE id=ANY($1::uuid[]) ORDER BY id FOR SHARE',[pairs.map(p=>p.session)]);
  if(pairs.some(p=>!sessions.rows.some(s=>s.id===p.session&&s.user_id===p.user)))throw denied();
  return sessions.rows;
 };
 const assertUnexpired=async(c,sessions)=>{
  const now=(await c.query('SELECT clock_timestamp() AS now')).rows[0].now;
  if(sessions.some(s=>s.expires_at<=now))throw denied();
  return now;
 };
 router.post('/:id/authorization',requireCsrf,async(req,res)=>{
  try{
   const b=req.body;
   if(!uuid(req.params.id)||!exact(b,['operatorId','status','revision'])||!uuid(b.operatorId)||!['in_progress','resolved'].includes(b.status)||!Number.isSafeInteger(b.revision)||b.revision<0)throw authHttpError(400,'PS018','Invalid receipt authorization');
   const operator=b.operatorId.toLowerCase();if(!operators.has(operator))throw denied();
   const token=randomBytes(32).toString('base64url');
   const result=await transaction(async c=>{
    // Establish ordering on the database clock before waiting for actor/receipt
    // locks. A request admitted earlier must not replace a newer grant.
    const admitted=(await c.query("SELECT clock_timestamp()::text AS admitted")).rows[0].admitted;
    const sessions=await lockActors(c,[{user:req.auth.userId,session:req.auth.sessionId}]);
    const r=(await c.query('SELECT * FROM support_receipts WHERE id=$1 AND user_id=$2 FOR UPDATE',[req.params.id,req.auth.userId])).rows[0];
    await assertUnexpired(c,sessions);
    if(!r)throw denied();
    if(r.revision!==b.revision||!((r.status==='received'&&b.status==='in_progress')||(r.status==='in_progress'&&b.status==='resolved')))throw authHttpError(409,'PS015','Receipt state changed');
    const value=await c.query(`UPDATE support_receipts SET operator_consent=jsonb_build_object('hash',$2::text,'operator',$3::text,'session',$4::text,'status',$5::text,'revision',$6::int,'issuedAt',clock_timestamp(),'expiresAt',clock_timestamp()+interval '10 minutes') WHERE id=$1 AND (operator_consent->>'issuedAt' IS NULL OR (operator_consent->>'issuedAt')::timestamptz < $7::timestamptz) RETURNING operator_consent->>'expiresAt' AS expires`,[r.id,hash(token),operator,req.auth.sessionId,b.status,r.revision,admitted]);
    if(value.rowCount!==1)throw authHttpError(409,'PS015','Receipt authorization superseded');
    return {receiptId:r.id,status:b.status,revision:r.revision,expiresAt:value.rows[0].expires};
   });res.status(201).json({...result,confirmation:token});
  }catch(e){sendAuthError(res,e);}
 });
 router.post('/:id/operator-status',requireCsrf,async(req,res)=>{
  try{
   const b=req.body;if(!uuid(req.params.id)||!exact(b,['confirmation'])||typeof b.confirmation!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(b.confirmation))throw authHttpError(400,'PS018','Invalid receipt confirmation');
   if(!operators.has(req.auth.userId))throw denied();
   const result=await transaction(async c=>{
    const preliminary=(await c.query('SELECT user_id,operator_consent FROM support_receipts WHERE id=$1',[req.params.id])).rows[0];
    const a=preliminary?.operator_consent;if(!a||!uuid(a.session)||a.operator!==req.auth.userId||a.hash!==hash(b.confirmation))throw denied();
    const sessions=await lockActors(c,[{user:preliminary.user_id,session:a.session},{user:req.auth.userId,session:req.auth.sessionId}]);
    const r=(await c.query('SELECT * FROM support_receipts WHERE id=$1 FOR UPDATE',[req.params.id])).rows[0];
    const current=r?.operator_consent;
    const now=await assertUnexpired(c,sessions);
    if(!current||current.hash!==hash(b.confirmation)||current.operator!==req.auth.userId||current.session!==a.session||new Date(current.expiresAt)<=now||current.revision!==r.revision)throw denied();
    if(!((r.status==='received'&&current.status==='in_progress')||(r.status==='in_progress'&&current.status==='resolved')))throw denied();
    const changed=(await c.query(`UPDATE support_receipts SET status=$2,revision=revision+1,operator_consent=NULL,history=history||jsonb_build_array(jsonb_build_object('status',$2::text,'at',clock_timestamp(),'operatorId',$3::text)) WHERE id=$1 RETURNING id,status,revision`,[r.id,current.status,req.auth.userId])).rows[0];return changed;
   });res.json(result);
  }catch(e){sendAuthError(res,e);}
 });
}
