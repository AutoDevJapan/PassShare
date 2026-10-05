// Thin event/IPC binding; the deadline and unlock generation live in Rust.
type NativeBridge = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: (event: string, handler: () => void) => Promise<() => void>;
};

export function bindNativeLock(bridge: NativeBridge | null, onLocked: () => void): () => void {
  if (!bridge) return () => {};
  const { invoke, listen } = bridge;
  let disposed = false;
  let lastInput = 0;
  let wasUnlocked = false;
  let notified = false;
  let unlisten: (() => void) | undefined;
  const lock = () => {
    wasUnlocked = false;
    if (!disposed && !notified) {
      notified = true;
      onLocked();
    }
  };
  void listen("passshare-locked", lock).then((stop) => {
    if (disposed) stop(); else unlisten = stop;
  }).catch(lock);
  const activity = (event: Event) => {
    if (!event.isTrusted || document.hidden || performance.now() - lastInput < 1000) return;
    lastInput = performance.now();
    void invoke<boolean>("native_activity").then((open) => {
      if (!open && wasUnlocked) lock();
    }).catch(lock);
  };
  const focus = () => {
    void invoke("native_focus", { foreground: !document.hidden }).catch(lock);
  };
  const blur = () => {
    lock();
    void invoke("native_focus", { foreground: false }).catch(lock);
  };
  const visibility = () => { if (document.hidden) blur(); else focus(); };
  document.addEventListener("visibilitychange", visibility);
  window.addEventListener("blur", blur);
  window.addEventListener("focus", focus);
  for (const name of ["pointerdown", "keydown", "wheel"]) document.addEventListener(name, activity, { passive: true });
  // Recover the UI even if a lock event was emitted before the listener existed.
  const poll = window.setInterval(() => {
    void invoke<boolean>("native_is_unlocked").then((open) => {
      if (!open && wasUnlocked) lock();
      if (open) notified = false;
      wasUnlocked = open;
    }).catch(lock);
  }, 1000);
  return () => {
    disposed = true;
    unlisten?.();
    window.clearInterval(poll);
    document.removeEventListener("visibilitychange", visibility);
    window.removeEventListener("blur", blur);
    window.removeEventListener("focus", focus);
    for (const name of ["pointerdown", "keydown", "wheel"]) document.removeEventListener(name, activity);
  };
}
