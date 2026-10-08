//! Mobile lifecycle policy layered on the shared monotonic idle lock.
//! Background, account change and manual lock always close the session and bump
//! the epoch, so any in-flight unlock started before them is rejected. Only
//! foreground input extends the idle deadline.

use std::time::Instant;

use crate::native_lock::NativeLock;

pub struct MobileLock {
    idle: NativeLock,
    account: Option<String>,
    foreground: bool,
}
impl Default for MobileLock {
    fn default() -> Self {
        Self {
            idle: NativeLock::default(),
            account: None,
            foreground: true,
        }
    }
}

impl MobileLock {
    pub fn epoch(&self) -> u64 {
        self.idle.epoch()
    }

    pub fn begin_unlock(&self) -> u64 {
        self.idle.begin_unlock()
    }

    /// Fails closed: no signed-in account means nothing to unlock.
    pub fn unlock(&mut self, epoch: u64, now: Instant) -> bool {
        self.foreground
            && self.account.is_some()
            && !self.idle.is_unlocked(now)
            && self.idle.unlock(epoch, now)
    }

    pub fn is_unlocked(&mut self, now: Instant) -> bool {
        self.foreground && self.idle.is_unlocked(now)
    }

    pub fn activity(&mut self, now: Instant) -> bool {
        self.foreground && self.idle.activity(now)
    }

    /// Returns true when the idle deadline just closed an open session.
    pub fn expire(&mut self, now: Instant) -> bool {
        self.idle.expire(now)
    }

    /// The app left the foreground (not a biometric dialog focus change).
    pub fn background(&mut self) {
        self.foreground = false;
        self.idle.lock();
    }

    /// Resume never restores an old open state or an in-flight proof.
    pub fn resume(&mut self) {
        self.foreground = true;
        self.idle.lock();
    }

    pub fn lock(&mut self) {
        self.idle.lock();
    }

    pub fn logout(&mut self) {
        self.account = None;
        self.idle.lock();
    }

    /// Returns true when the account changed (and the session was closed).
    pub fn set_account(&mut self, id: Option<&str>) -> bool {
        if self.account.as_deref() == id {
            return false;
        }
        self.account = id.map(str::to_owned);
        self.idle.lock();
        true
    }

    /// Compare and apply under the caller's single native state lock.
    pub fn adopt_account(&mut self, expected: u64, id: Option<&str>, now: Instant) -> bool {
        self.idle.expire(now);
        if expected != self.epoch() || (id.is_some() && !self.foreground) {
            return false;
        }
        self.set_account(id);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_lock::IDLE_TIMEOUT;
    use std::time::Duration;

    fn signed_in() -> (MobileLock, Instant) {
        let mut lock = MobileLock::default();
        lock.set_account(Some("user-a"));
        (lock, Instant::now())
    }

    #[test]
    fn unlock_requires_an_account() {
        let mut lock = MobileLock::default();
        assert!(!lock.unlock(lock.begin_unlock(), Instant::now()));
        lock.set_account(Some("user-a"));
        assert!(lock.unlock(lock.begin_unlock(), Instant::now()));
    }

    #[test]
    fn background_closes_and_rejects_inflight_unlock() {
        let (mut lock, start) = signed_in();
        let inflight = lock.begin_unlock();
        lock.background();
        assert!(!lock.unlock(inflight, start));
        assert!(!lock.is_unlocked(start));
        let fresh = lock.begin_unlock();
        assert!(!lock.unlock(fresh, start));
        lock.resume();
        let fresh = lock.begin_unlock();
        assert!(lock.unlock(fresh, start));
        lock.background();
        assert!(!lock.is_unlocked(start));
        assert!(!lock.activity(start));
    }

    #[test]
    fn background_while_locked_still_invalidates_inflight_unlock() {
        let (mut lock, start) = signed_in();
        let inflight = lock.begin_unlock();
        let before = lock.epoch();
        lock.background();
        assert!(lock.epoch() > before);
        assert!(!lock.unlock(inflight, start));
    }

    #[test]
    fn idle_deadline_is_300_seconds_and_input_only_extends_open_sessions() {
        assert_eq!(IDLE_TIMEOUT, Duration::from_secs(300));
        let (mut lock, start) = signed_in();
        assert!(lock.unlock(lock.begin_unlock(), start));
        assert!(lock.activity(start + Duration::from_secs(299)));
        assert!(lock.is_unlocked(start + Duration::from_secs(598)));
        assert!(lock.expire(start + Duration::from_secs(599)));
        assert!(!lock.activity(start + Duration::from_secs(599)));
        assert!(!lock.expire(start + Duration::from_secs(900)));
    }

    #[test]
    fn account_change_locks_and_invalidates_but_same_account_does_not() {
        let (mut lock, start) = signed_in();
        assert!(lock.unlock(lock.begin_unlock(), start));
        let epoch = lock.epoch();
        assert!(!lock.set_account(Some("user-a")));
        assert_eq!(lock.epoch(), epoch);
        assert!(lock.is_unlocked(start));

        let inflight = lock.begin_unlock();
        assert!(lock.set_account(Some("user-b")));
        assert!(!lock.is_unlocked(start));
        assert!(!lock.unlock(inflight, start));
        assert!(lock.unlock(lock.begin_unlock(), start));
    }

    #[test]
    fn logout_locks_and_blocks_unlock_until_next_sign_in() {
        let (mut lock, start) = signed_in();
        assert!(lock.unlock(lock.begin_unlock(), start));
        assert!(lock.set_account(None));
        assert!(!lock.is_unlocked(start));
        assert!(!lock.unlock(lock.begin_unlock(), start));
        assert!(lock.set_account(Some("user-a")));
        assert!(lock.unlock(lock.begin_unlock(), start));
    }

    #[test]
    fn manual_lock_closes_open_session() {
        let (mut lock, start) = signed_in();
        assert!(lock.unlock(lock.begin_unlock(), start));
        lock.lock();
        assert!(!lock.is_unlocked(start));
    }

    #[test]
    fn stale_account_update_cannot_replace_or_restore_a_session() {
        let (mut lock, now) = signed_in();
        let old = lock.epoch();
        assert!(lock.adopt_account(old, Some("user-b"), now));
        assert!(!lock.adopt_account(old, Some("user-a"), now));
        assert!(!lock.adopt_account(old, None, now));
        assert_eq!(lock.account.as_deref(), Some("user-b"));
        let old = lock.epoch();
        lock.background();
        assert!(!lock.adopt_account(old, Some("user-a"), now));
        assert!(!lock.adopt_account(lock.epoch(), Some("user-a"), now));
        assert!(lock.adopt_account(lock.epoch(), None, now));
        assert!(lock.account.is_none());
    }

    #[test]
    fn logout_closes_account_in_background_and_invalidates_old_adoptions() {
        let (mut lock, now) = signed_in();
        let old = lock.epoch();
        lock.background();
        lock.logout();
        assert!(lock.account.is_none());
        assert!(!lock.adopt_account(old, Some("user-a"), now));
        lock.resume();
        assert!(!lock.unlock(lock.begin_unlock(), now));
    }

    #[test]
    fn repeated_unlock_does_not_extend_an_open_session() {
        let (mut lock, now) = signed_in();
        assert!(lock.unlock(lock.begin_unlock(), now));
        assert!(!lock.unlock(lock.begin_unlock(), now + Duration::from_secs(299)));
        assert!(!lock.is_unlocked(now + Duration::from_secs(300)));
        assert!(lock.unlock(lock.begin_unlock(), now + Duration::from_secs(301)));
    }
}
