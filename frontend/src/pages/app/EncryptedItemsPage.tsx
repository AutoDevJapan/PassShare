import { EncryptedItems } from "@shared/cloud/EncryptedItems";
import { useAuthSession } from "../../hooks/useAuthSession";
import { webCloudApi } from "../../lib/cloud-api";
import type { CloudWorker, OwnerContext } from "../../lib/cloud-worker";
export function EncryptedItemsPage(props: { worker: CloudWorker; scope: OwnerContext; onLock: () => void }) {
  const { user } = useAuthSession();
  return <EncryptedItems {...props} userId={user?.id ?? ""} api={webCloudApi} />;
}