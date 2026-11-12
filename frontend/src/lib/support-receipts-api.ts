import {createSupportReceiptApi} from '@shared/cloud/support-receipts-api';
import {authFetch} from './auth-api';

// Web cookies and CSRF stay in the existing auth transport. No session token
// is projected into the shared receipt client or a native bearer connection.
export function createWebSupportReceiptApi(ownerId: string) {
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(ownerId)) throw new Error('Invalid receipt owner');
  return createSupportReceiptApi((path, init = {}) => {
    const headers = new Headers(init.headers);
    // This is an equality precondition, never an authorization claim. The
    // server compares it with the user authenticated by the actual cookie.
    headers.set('X-PassShare-Receipt-Owner', ownerId.toLowerCase());
    return authFetch(path, {...init, headers});
  });
}
