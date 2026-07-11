import { useEffect, useRef, useState } from "react";
import {
  AUTO_LOCK_CHANGED_EVENT,
  AutoLockController,
  DEFAULT_BACKGROUND_GRACE_MS,
  getAutoLockIdleMs,
} from "../lib/auto-lock";

// Activity signals that reset the idle countdown. Kept intentionally narrow
// (discrete interactions rather than pointermove/scroll) so a phone in a pocket
// is not treated as "in use".
const ACTIVITY_EVENTS = ["pointerdown", "keydown", "touchstart"] as const;

/**
 * Re-locks the app on background transition or idle timeout while `enabled`.
 * `onLock` is invoked from a lifecycle/idle trigger to reset the unlocked state.
 */
export function useAutoLock(enabled: boolean, onLock: () => void): void {
  const onLockRef = useRef(onLock);
  onLockRef.current = onLock;

  // Track the configured idle timeout so a change in Settings takes effect on
  // the live session (via the AUTO_LOCK_CHANGED_EVENT) without a reload.
  const [idleMs, setIdleMs] = useState(getAutoLockIdleMs);

  useEffect(() => {
    const sync = () => setIdleMs(getAutoLockIdleMs());
    window.addEventListener(AUTO_LOCK_CHANGED_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(AUTO_LOCK_CHANGED_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const controller = new AutoLockController(
      { idleTimeoutMs: idleMs, backgroundGraceMs: DEFAULT_BACKGROUND_GRACE_MS },
      () => onLockRef.current(),
    );
    controller.start();

    const onVisibility = () => controller.notifyVisibility(document.hidden);
    const onHide = () => controller.notifyVisibility(true);
    const onActivity = () => controller.notifyActivity();

    document.addEventListener("visibilitychange", onVisibility);
    // `pagehide` covers WebView teardown/backgrounding where visibilitychange is
    // not always delivered on mobile.
    window.addEventListener("pagehide", onHide);
    for (const event of ACTIVITY_EVENTS) {
      window.addEventListener(event, onActivity, { passive: true });
    }

    return () => {
      controller.stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", onHide);
      for (const event of ACTIVITY_EVENTS) {
        window.removeEventListener(event, onActivity);
      }
    };
  }, [enabled, idleMs]);
}
