import {createSupportReceiptApi} from '@shared/cloud/support-receipts-api';
import {authFetch} from './auth-api';

// Web cookies and CSRF stay in the existing auth transport. No session token
// is projected into the shared receipt client or a native bearer connection.
export const webSupportReceiptApi = createSupportReceiptApi(authFetch);
