import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { randomUUID, createHash } from "node:crypto";
import { requireSession } from "./auth/session.js";
import { requireCsrf } from "./auth/csrf.js";
import { nativeMutation } from "./lib/native-mutations.js";
import { authHttpError, sendAuthError } from "./auth/errors.js";
import { applySchemaWithAdvisoryLock } from "./db/migration-lock.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS support_receipts (
 id UUID PRIMARY KEY, user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 request_id UUID NOT NULL, fingerprint TEXT NOT NULL, metadata JSONB NOT NULL,
 status TEXT NOT NULL DEFAULT 'received' CHECK(status IN ('received','in_progress','resolved')),
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), UNIQUE(user_id,request_id));`;
export async function createSupportReceiptRouter({pool,authStore}) {
 if(pool) await applySchemaWithAdvisoryLock(pool,4820127,SCHEMA);
 const memory=new Map();
 const router=Router();router.use(rateLimit({windowMs:60000,limit:30,standardHeaders:"draft-6",legacyHeaders:false}));router.use(requireSession(authStore));
 router.use((_req,res,next)=>{res.set('Cache-Control','no-store');next();});
 const publicRow=r=>({id:r.id,status:r.status,createdAt:r.created_at,request:r.metadata,meaning:'request_received_not_contract_or_payment_confirmation'});
 router.post('/',requireCsrf,async(req,res)=>{
  try {
   const metadata=await nativeMutation({command:'support-receipt-validate',request:req.body});
   const fingerprint=createHash('sha256').update(JSON.stringify(metadata)).digest('hex');
   const user=req.auth.userId,requestId=metadata.requestId;
   let row;
   if(pool){
    const result=await pool.query(`WITH active AS (SELECT u.id FROM users u JOIN sessions s ON s.user_id=u.id WHERE u.id=$1 AND s.id=$2 AND s.expires_at>NOW() FOR SHARE OF u,s)
     INSERT INTO support_receipts(id,user_id,request_id,fingerprint,metadata) SELECT $3,active.id,$4,$5,$6::jsonb FROM active
     ON CONFLICT(user_id,request_id) DO UPDATE SET request_id=EXCLUDED.request_id
     RETURNING *`,[user,req.auth.sessionId,randomUUID(),requestId,fingerprint,JSON.stringify(metadata)]);
    row=result.rows[0];if(!row)throw authHttpError(401,'PS024','Session expired');
   } else {
    const key=user+':'+requestId;row=memory.get(key);
    if(!row){row={userId:user,id:randomUUID(),status:'received',created_at:new Date().toISOString(),metadata,fingerprint};memory.set(key,row);}
   }
   if(row.fingerprint!==fingerprint)throw authHttpError(409,'PS015','Receipt request changed');
   res.status(201).json(publicRow(row));
  }catch(e){sendAuthError(res,e);}
 });
 router.get('/:id',async(req,res)=>{
  try {
   if(!/^[a-f0-9-]{36}$/i.test(req.params.id))throw authHttpError(404,'PS022','Receipt not found');
   const row=pool?(await pool.query('SELECT r.* FROM support_receipts r JOIN sessions s ON s.user_id=r.user_id WHERE r.id=$1 AND r.user_id=$2 AND s.id=$3 AND s.expires_at>NOW()',[req.params.id,req.auth.userId,req.auth.sessionId])).rows[0]:[...memory.values()].find(r=>r.id===req.params.id&&r.userId===req.auth.userId);
   if(!row)throw authHttpError(404,'PS022','Receipt not found');res.json(publicRow(row));
  }catch(e){sendAuthError(res,e);}
 });
 return router;
}
