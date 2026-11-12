import {createSupportReceiptApi} from '@shared/cloud/support-receipts-api';
import {authFetch} from './auth-api';

// Web cookies and CSRF stay in the existing auth transport. No session token
// is projected into the shared receipt client or a native bearer connection.
export function createWebSupportReceiptApi(ownerId: string, isCurrent: () => boolean) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ownerId)) throw new Error('Invalid receipt owner');
  let alive = true;
  const active = new Set<AbortController>();
  const api = createSupportReceiptApi(async (path, init = {}) => {
    if (!alive || !isCurrent()) throw new Error('Inactive receipt session');
    const controller = new AbortController();
    const abort = () => controller.abort();
    init.signal?.throwIfAborted();
    init.signal?.addEventListener('abort', abort, {once: true});
    active.add(controller);
    const headers = new Headers(init.headers);
    // This is an equality precondition, never an authorization claim. The
    // server compares it with the user authenticated by the actual cookie.
    headers.set('X-PassShare-Receipt-Owner', ownerId.toLowerCase());
    try {
      const response = await authFetch(path, {...init, headers, signal: controller.signal});
      if (!alive || !isCurrent()) { await response.body?.cancel(); throw new Error('Inactive receipt session'); }
      // Retain cancellation through body consumption, not only response headers.
      const reader = response.body?.getReader();
      if (!reader) { active.delete(controller); init.signal?.removeEventListener('abort',abort); return response; }
      let finished = false;
      const cleanup = () => { active.delete(controller); init.signal?.removeEventListener('abort', abort); };
      const stop = () => { void reader.cancel().catch(()=>{}); };
      controller.signal.addEventListener('abort', stop, {once:true});
      const finish = () => { if(finished)return; finished=true; cleanup(); controller.signal.removeEventListener('abort',stop); reader.releaseLock(); };
      const body = new ReadableStream<Uint8Array>({
        async pull(destination) {
          try {
            if (!alive || !isCurrent() || controller.signal.aborted) throw new Error('Inactive receipt session');
            const part = await reader.read();
            if (!alive || !isCurrent() || controller.signal.aborted) throw new Error('Inactive receipt session');
            if (part.done) { destination.close(); finish(); } else destination.enqueue(part.value);
          } catch (error) { await reader.cancel().catch(()=>{}); destination.error(error); finish(); }
        },
        async cancel() { try { await reader.cancel(); } finally { finish(); } },
      });
      return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
    } catch (error) {
      active.delete(controller); init.signal?.removeEventListener('abort',abort); throw error;
    }
  });
  return Object.freeze({...api,dispose() { alive=false; for(const request of active)request.abort(); active.clear(); }});
}
