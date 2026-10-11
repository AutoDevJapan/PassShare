import { createCloudApi } from '@shared/cloud/cloud-api';
import { authFetch } from './auth-api';
export * from '@shared/cloud/cloud-api';
export const webCloudApi = createCloudApi(authFetch);
export const { getBoxState, getAttachmentState, getOwnerBundle, putOwnerBundle, setupBox, bundleText, sameBundle, readPendingBundle, savePendingBundle, clearPendingBundle, validateItemContext, publicOwnerBundle, readItemEnvelope, listEncryptedItems, getEncryptedItem, putEncryptedItem, deleteEncryptedItem, getAttachmentItemSnapshot, getEncryptedAttachment, writeEncryptedAttachment } = webCloudApi;
