//! Monotonic native session policy shared by the desktop and mobile shells.
//! Reading data does not extend the session. Only foreground user input does.

use std::time::{Duration, Instant};

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

pub struct NativeLock {
    foreground: bool,
    unlocked_at: Option<Instant>,
    epoch: u64,
}

impl Default for NativeLock {
    fn default() -> Self {
        Self {
            foreground: true,
            unlocked_at: None,
            epoch: 0,
        }
    }
}

impl NativeLock {
    pub fn begin_unlock(&self) -> Option<u64> {
        self.foreground.then_some(self.epoch)
    }

    pub fn unlock(&mut self, epoch: u64, now: Instant) -> bool {
        if !self.foreground || epoch != self.epoch {
            return false;
        }
        self.unlocked_at = Some(now);
        true
    }

    pub fn lock(&mut self) -> bool {
        self.epoch = self.epoch.wrapping_add(1);
        self.unlocked_at.take().is_some()
    }

    pub fn focus(&mut self, foreground: bool) -> bool {
        self.foreground = foreground;
        if foreground {
            false
        } else {
            self.lock()
        }
    }

    pub fn expire(&mut self, now: Instant) -> bool {
        if self
            .unlocked_at
            .is_some_and(|last| now.saturating_duration_since(last) >= IDLE_TIMEOUT)
        {
            return self.lock();
        }
        false
    }

    pub fn is_unlocked(&mut self, now: Instant) -> bool {
        self.expire(now);
        self.foreground && self.unlocked_at.is_some()
    }

    pub fn activity(&mut self, now: Instant) -> bool {
        if !self.is_unlocked(now) {
            return false;
        }
        self.unlocked_at = Some(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_locked_and_reads_do_not_extend_deadline() {
        let mut lock = NativeLock::default();
        let start = Instant::now();
        assert!(!lock.is_unlocked(start));
        assert!(lock.unlock(lock.begin_unlock().unwrap(), start));
        assert!(lock.is_unlocked(start + IDLE_TIMEOUT - Duration::from_nanos(1)));
        assert!(!lock.is_unlocked(start + IDLE_TIMEOUT));
        assert!(!lock.activity(start + IDLE_TIMEOUT));
    }

    #[test]
    fn foreground_input_extends_only_live_sessions() {
        let mut lock = NativeLock::default();
        let start = Instant::now();
        assert!(lock.unlock(lock.begin_unlock().unwrap(), start));
        assert!(lock.activity(start + Duration::from_secs(299)));
        assert!(lock.is_unlocked(start + Duration::from_secs(300)));
        assert!(!lock.is_unlocked(start + Duration::from_secs(599)));
    }

    #[test]
    fn background_and_manual_lock_invalidate_inflight_unlock() {
        let mut lock = NativeLock::default();
        let start = Instant::now();
        let epoch = lock.begin_unlock().unwrap();
        lock.focus(false);
        assert!(lock.begin_unlock().is_none());
        assert!(!lock.unlock(epoch, start));
        lock.focus(true);
        assert!(!lock.unlock(epoch, start));
        let fresh = lock.begin_unlock().unwrap();
        assert!(lock.unlock(fresh, start));
        assert!(lock.focus(false));
        assert!(!lock.activity(start));
        lock.focus(true);
        assert!(!lock.is_unlocked(start));
        let fresh = lock.begin_unlock().unwrap();
        lock.lock();
        assert!(!lock.unlock(fresh, start));
    }
}
