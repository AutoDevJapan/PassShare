import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export type LocalRecoverySession = { epoch: number; ticket: number };

// Only native Rust decides whether a recovery operation may publish. This
// generation prevents a disposed form from displaying an older IPC response.
export function useLocalRecoverySession(erase: () => void, close: () => void, lockOnCancel = false) {
  const callbacks = useRef({ erase, close });
  callbacks.current = { erase, close };
  const generation = useRef(0);
  const session = useRef<LocalRecoverySession | null>(null);
  const completed = useRef(false);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    completed.current = false;
    const current = ++generation.current;
    const end = (ticket: number | undefined) => {
      if (ticket === undefined) return;
      void invoke("local_recovery_session", { active: false, ticket, lockOnCancel: lockOnCancel && !completed.current }).catch(() => {});
    };
    void invoke<LocalRecoverySession>("local_recovery_session", { active: true, ticket: null, lockOnCancel: false }).then((value) => {
      if (current !== generation.current || document.hidden) { end(value.ticket); return; }
      session.current = value;
      setReady(true);
    }).catch(() => {
      if (current === generation.current) setFailed(true);
    });
    const cancel = () => {
      generation.current++;
      end(session.current?.ticket);
      session.current = null;
      callbacks.current.erase();
      setReady(false);
      callbacks.current.close();
    };
    const visibility = () => { if (document.hidden) cancel(); };
    window.addEventListener("blur", cancel);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      generation.current++;
      end(session.current?.ticket);
      session.current = null;
      callbacks.current.erase();
      window.removeEventListener("blur", cancel);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [lockOnCancel]);

  return { ready, failed, session, generation, complete: () => { completed.current = true; } };
}
