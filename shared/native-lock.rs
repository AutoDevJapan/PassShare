//! Monotonic idle session policy for the native desktop shell.
//! Reading data does not extend the session. Only foreground user input does.

use std::time::{Duration, Instant};

pub const IDLE_TIMEOUT: Duration = Duration::from_secs(5 * 60);

#[derive(Default)]
pub struct NativeLock {
    unlocked_at: Option<Instant>,
    epoch: u64,
}

impl NativeLock {
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn begin_unlock(&self) -> u64 {
        self.epoch
    }

    pub fn unlock(&mut self, epoch: u64, now: Instant) -> bool {
        if epoch != self.epoch {
            return false;
        }
        self.unlocked_at = Some(now);
        self.epoch = self.epoch.wrapping_add(1);
        true
    }

    pub fn lock(&mut self) -> bool {
        self.epoch = self.epoch.wrapping_add(1);
        self.unlocked_at.take().is_some()
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
        self.unlocked_at.is_some()
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
        assert!(lock.unlock(lock.begin_unlock(), start));
        assert!(lock.is_unlocked(start + IDLE_TIMEOUT - Duration::from_nanos(1)));
        assert!(!lock.is_unlocked(start + IDLE_TIMEOUT));
        assert!(!lock.activity(start + IDLE_TIMEOUT));
    }

    #[test]
    fn foreground_input_extends_only_live_sessions() {
        let mut lock = NativeLock::default();
        let start = Instant::now();
        assert!(lock.unlock(lock.begin_unlock(), start));
        assert!(lock.activity(start + Duration::from_secs(299)));
        assert!(lock.is_unlocked(start + Duration::from_secs(300)));
        assert!(!lock.is_unlocked(start + Duration::from_secs(599)));
    }

    #[test]
    fn manual_lock_invalidates_inflight_unlock() {
        let mut lock = NativeLock::default();
        let start = Instant::now();
        let epoch = lock.begin_unlock();
        lock.lock();
        assert!(!lock.unlock(epoch, start));
        let fresh = lock.begin_unlock();
        assert!(lock.unlock(fresh, start));
        assert!(lock.lock());
        assert!(!lock.activity(start));
        assert!(!lock.is_unlocked(start));
    }
}
