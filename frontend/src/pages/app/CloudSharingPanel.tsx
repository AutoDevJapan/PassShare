import { SharedCloudSharingPanel } from "@shared/cloud/CloudSharingPanel";
import { webCloudApi } from "../../lib/cloud-api";
import { webSharingApi } from "../../lib/sharing-api";
import { listVaultMembers } from "../../lib/auth-api";
import type { CloudWorker, OwnerContext } from "../../lib/cloud-worker";
export function CloudSharingPanel(props: { worker: CloudWorker; scope: OwnerContext; recipient?: boolean; onReceive?: () => void; onLock: () => void }) {
  return <SharedCloudSharingPanel {...props} api={webCloudApi} sharing={webSharingApi} listVaultMembers={listVaultMembers} />;
}