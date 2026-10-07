// Thin event/IPC binding; idle policy and transition generations live in Rust.
export type NativeStatus = { epoch: number; unlocked: boolean };
type NativeBridge = {
  invoke: <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
  listen: (event: string, handler: (event: { payload: NativeStatus }) => void) => Promise<() => void>;
};

export function bindNativeLock(bridge: NativeBridge | null, onLocked: () => void) {
  let disposed = false;
  let lastInput = -Infinity;
  let latestEpoch = -1;
  let lastLockedEpoch = -1;
  let unlisten: (() => void) | undefined;
  const accept = (status: NativeStatus) => {
    if (disposed || status.epoch < latestEpoch) return;
    if (latestEpoch === -1 && status.epoch === 0 && !status.unlocked) {
      latestEpoch = 0;
      lastLockedEpoch = 0;
      return;
    }
    latestEpoch = status.epoch;
    if (!status.unlocked && status.epoch > lastLockedEpoch) {
      lastLockedEpoch = status.epoch;
      onLocked();
    }
  };
  if (!bridge) return { accept, dispose: () => { disposed = true; } };
  const { invoke, listen } = bridge;
  const failure = () => { if (!disposed) onLocked(); };
  void listen("passshare-locked", (event) => accept(event.payload)).then((stop) => {
    if (disposed) stop(); else unlisten = stop;
  }).catch(failure);
  const activity = (event: Event) => {
    if (!event.isTrusted || document.hidden || !document.hasFocus() || performance.now() - lastInput < 1000) return;
    lastInput = performance.now();
    const epoch = latestEpoch;
    void invoke<boolean>("native_activity").then(() => invoke<NativeStatus>("native_session_status")).then(accept).catch(() => {
      if (epoch === latestEpoch) failure();
    });
  };
  for (const name of ["pointerdown", "keydown", "wheel"]) document.addEventListener(name, activity, { passive: true });
  // Epoch ordering rejects late poll results from a previous authentication.
  const poll = window.setInterval(() => {
    const epoch = latestEpoch;
    void invoke<NativeStatus>("native_session_status").then(accept).catch(() => {
      if (epoch === latestEpoch) failure();
    });
  }, 1000);
  return { accept, dispose: () => {
    disposed = true;
    unlisten?.();
    window.clearInterval(poll);
    for (const name of ["pointerdown", "keydown", "wheel"]) document.removeEventListener(name, activity);
  } };
}