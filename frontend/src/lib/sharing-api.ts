import { createSharingApi } from '@shared/cloud/sharing-api';
import { authFetch } from './auth-api';
export * from '@shared/cloud/sharing-api';
export const webSharingApi = createSharingApi(authFetch);
export const { publicText, getIdentity, createIdentity, getMemberIdentity, getSnapshot, getSnapshotMembers, putGrant, getSelfGrant, readOwnPin, savePreparedOwnPin, readPeerPin, savePeerPin, readPendingIdentity, savePendingIdentity, clearPendingIdentity } = webSharingApi;
