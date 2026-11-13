import type {CloudFetch} from './session-transport';

export type SupportReceiptRequest = {
  requestId: string;
  kind: 'technical' | 'export' | 'cancellation' | 'refund';
  version: string;
  platform: 'web' | 'windows' | 'android' | 'ios' | 'extension';
  errorCode: string;
};
export type SupportReceipt = {
  id: string; status: 'received' | 'in_progress' | 'resolved'; revision: number;
  history: {status: string; at: string}[]; createdAt: string;
  request: SupportReceiptRequest; meaning: 'request_received_not_contract_or_payment_confirmation';
};
export type SupportReceiptAuthorization = {operatorId:string;status:'in_progress'|'resolved';revision:number};
export type SupportReceiptConsent = {receiptId:string;status:'in_progress'|'resolved';revision:number;expiresAt:string;confirmation:string};
export type SupportReceiptStatus = {id:string;status:'in_progress'|'resolved';revision:number};
export class SupportReceiptError extends Error {
  constructor(readonly status: number) {super('Support receipt request failed');}
}
const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(v);
const fields = (v: unknown, keys: string[]): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
function validRequest(v: unknown): v is SupportReceiptRequest {
  return fields(v,['requestId','kind','version','platform','errorCode']) && uuid(v.requestId) &&
    ['technical','export','cancellation','refund'].includes(v.kind) &&
    ['web','windows','android','ios','extension'].includes(v.platform) &&
    typeof v.version === 'string' && v.version.length > 0 && v.version.length <= 32 && /^[0-9.-]+$/.test(v.version) &&
    typeof v.errorCode === 'string' && /^(?:PS[0-9]{3})?$/.test(v.errorCode);
}
export function createSupportReceiptApi(transport: CloudFetch) {
  async function request<T=SupportReceipt>(path: string, init: RequestInit, expectedStatus: number, validate: (value:unknown)=>boolean = validReceipt): Promise<T> {
    try {
      init.signal?.throwIfAborted();
      const response = await transport(path,{cache:'no-store',redirect:'error',...init});
      if(response.status !== expectedStatus) {await response.body?.cancel().catch(()=>{});throw new SupportReceiptError(response.status);}
      const reader = response.body?.getReader();
      if(!reader) throw new SupportReceiptError(502);
      let text = ''; let size = 0; const decoder = new TextDecoder('utf-8',{fatal:true});
      try {for(;;){init.signal?.throwIfAborted();const part=await reader.read();init.signal?.throwIfAborted();if(part.done)break;size+=part.value.byteLength;if(size>65536)throw new SupportReceiptError(502);try{text+=decoder.decode(part.value,{stream:true});}catch{throw new SupportReceiptError(502);}}try{text+=decoder.decode();}catch{throw new SupportReceiptError(502);}}
      finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      let value: unknown;try{value=JSON.parse(text);}catch{throw new SupportReceiptError(502);}
      if(!validate(value))throw new SupportReceiptError(502);
      return value as T;
    }catch(e){if(e instanceof SupportReceiptError)throw e;throw new SupportReceiptError(0);}
  }
  function validReceipt(value:unknown) {
      return !(!fields(value,['id','status','revision','history','createdAt','request','meaning']) || !uuid(value.id) ||
        !['received','in_progress','resolved'].includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision<0 ||
        !Array.isArray(value.history) || !value.history.every(h=>fields(h,['status','at'])&&['received','in_progress','resolved'].includes(h.status)&&typeof h.at==='string'&&Number.isFinite(Date.parse(h.at))) ||
        typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||!validRequest(value.request)||
        value.meaning!=='request_received_not_contract_or_payment_confirmation');
  }
  return Object.freeze({
    async authorize(id:string,input:SupportReceiptAuthorization,signal:AbortSignal):Promise<SupportReceiptConsent> {
      let snapshot:SupportReceiptAuthorization;
      try{if(!uuid(id)||!fields(input,['operatorId','status','revision']))throw new Error();snapshot={operatorId:input.operatorId,status:input.status,revision:input.revision};}catch{throw new SupportReceiptError(400);}
      if(!uuid(snapshot.operatorId)||!['in_progress','resolved'].includes(snapshot.status)||!Number.isSafeInteger(snapshot.revision)||snapshot.revision<0)throw new SupportReceiptError(400);
      return request<SupportReceiptConsent>(`/api/support-receipts/${id.toLowerCase()}/authorization`,{method:'POST',body:JSON.stringify({...snapshot,operatorId:snapshot.operatorId.toLowerCase()}),signal},201,value=>
        fields(value,['receiptId','status','revision','expiresAt','confirmation'])&&value.receiptId===id.toLowerCase()&&value.status===snapshot.status&&value.revision===snapshot.revision+1&&
        typeof value.expiresAt==='string'&&Number.isFinite(Date.parse(value.expiresAt))&&typeof value.confirmation==='string'&&/^[A-Za-z0-9_-]{43}$/.test(value.confirmation));
    },
    async applyStatus(id:string,input:{confirmation:string},signal:AbortSignal):Promise<SupportReceiptStatus> {
      let confirmation:string;try{if(!uuid(id)||!fields(input,['confirmation']))throw new Error();confirmation=input.confirmation;}catch{throw new SupportReceiptError(400);}
      if(typeof confirmation!=='string'||!/^[A-Za-z0-9_-]{43}$/.test(confirmation))throw new SupportReceiptError(400);
      return request<SupportReceiptStatus>(`/api/support-receipts/${id.toLowerCase()}/operator-status`,{method:'POST',body:JSON.stringify({confirmation}),signal},200,value=>
        fields(value,['id','status','revision'])&&value.id===id.toLowerCase()&&['in_progress','resolved'].includes(value.status)&&Number.isSafeInteger(value.revision)&&value.revision>0);
    },
    async create(input: SupportReceiptRequest, signal: AbortSignal) {
      if(!fields(input,['requestId','kind','version','platform','errorCode']))throw new SupportReceiptError(400);
      let snapshot: SupportReceiptRequest;
      try{snapshot={requestId:input.requestId,kind:input.kind,version:input.version,platform:input.platform,errorCode:input.errorCode};}catch{throw new SupportReceiptError(400);}
      if(!validRequest(snapshot))throw new SupportReceiptError(400);
      const expected={...snapshot,requestId:snapshot.requestId.toLowerCase()};
      const receipt=await request('/api/support-receipts',{method:'POST',body:JSON.stringify(expected),signal},201);
      if(Object.keys(expected).some(k=>receipt.request[k as keyof SupportReceiptRequest]!==expected[k as keyof SupportReceiptRequest]))throw new SupportReceiptError(502);
      return receipt;
    },
    async get(id: string, signal: AbortSignal) {
      if(!uuid(id))throw new SupportReceiptError(400);
      const receipt=await request(`/api/support-receipts/${id.toLowerCase()}`,{signal},200);
      if(receipt.id!==id.toLowerCase())throw new SupportReceiptError(502);
      return receipt;
    },
  });
}
