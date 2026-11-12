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
  async function request(path: string, init: RequestInit, expectedStatus: number): Promise<SupportReceipt> {
    try {
      init.signal?.throwIfAborted();
      const response = await transport(path,{cache:'no-store',redirect:'error',...init});
      if(response.status !== expectedStatus) {await response.body?.cancel().catch(()=>{});throw new SupportReceiptError(response.status);}
      const reader = response.body?.getReader();
      if(!reader) throw new SupportReceiptError(502);
      let text = ''; let size = 0; const decoder = new TextDecoder('utf-8',{fatal:true});
      try {for(;;){init.signal?.throwIfAborted();const part=await reader.read();init.signal?.throwIfAborted();if(part.done)break;size+=part.value.byteLength;if(size>65536)throw new SupportReceiptError(502);text+=decoder.decode(part.value,{stream:true});}text+=decoder.decode();}
      finally {await reader.cancel().catch(()=>{});reader.releaseLock();}
      const value: unknown=JSON.parse(text);
      if(!fields(value,['id','status','revision','history','createdAt','request','meaning']) || !uuid(value.id) ||
        !['received','in_progress','resolved'].includes(value.status) || !Number.isSafeInteger(value.revision) || value.revision<0 ||
        !Array.isArray(value.history) || !value.history.every(h=>fields(h,['status','at'])&&['received','in_progress','resolved'].includes(h.status)&&typeof h.at==='string'&&Number.isFinite(Date.parse(h.at))) ||
        typeof value.createdAt!=='string'||!Number.isFinite(Date.parse(value.createdAt))||!validRequest(value.request)||
        value.meaning!=='request_received_not_contract_or_payment_confirmation')throw new SupportReceiptError(502);
      return value as SupportReceipt;
    }catch(e){if(e instanceof SupportReceiptError)throw e;throw new SupportReceiptError(0);}
  }
  return Object.freeze({
    async create(input: SupportReceiptRequest, signal: AbortSignal) {
      if(!validRequest(input))throw new SupportReceiptError(400);
      const expected={...input,requestId:input.requestId.toLowerCase()};
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
