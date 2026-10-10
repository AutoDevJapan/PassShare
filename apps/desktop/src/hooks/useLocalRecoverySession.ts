import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { startLocalRecoverySession } from "../lib/local-recovery-session";
import type { LocalRecoverySession } from "../lib/local-recovery-session";

// Only native Rust decides whether a recovery operation may publish. This
// generation prevents a disposed form from displaying an older IPC response.
export function useLocalRecoverySession(erase: () => void, close: () => void, lockOnCancel = false) {
  const callbacks = useRef({ erase, close });
  callbacks.current = { erase, close };
  const generation = useRef(0);
  const session = useRef<LocalRecoverySession | null>(null);
  const lifetime = useRef<ReturnType<typeof startLocalRecoverySession> | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const active = startLocalRecoverySession({ generation, session }, {
      begin: () => invoke<LocalRecoverySession>("local_recovery_session", { active: true, ticket: null, lockOnCancel: false }),
      end: (ticket, lockOnCancel) => invoke("local_recovery_session", { active: false, ticket, lockOnCancel }),
      hidden: () => document.hidden,
      erase: () => callbacks.current.erase(),
      close: () => callbacks.current.close(),
      ready: setReady,
      failed: setFailed,
    }, lockOnCancel);
    lifetime.current = active;
    const cancel = active.cancel;
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      active.dispose();
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [lockOnCancel]);

  return { ready, failed, session, generation, cancel: () => lifetime.current?.cancel(), complete: () => lifetime.current?.complete() };
}
