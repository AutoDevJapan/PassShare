export type LocalRecoverySession = { epoch: number; ticket: number };

type SessionState = {
  generation: { current: number };
  session: { current: LocalRecoverySession | null };
};

type SessionEffects = {
  begin: () => Promise<LocalRecoverySession>;
  end: (ticket: number, lockOnCancel: boolean) => Promise<unknown>;
  hidden: () => boolean;
  erase: () => void;
  close: () => void;
  ready: (value: boolean) => void;
  failed: (value: boolean) => void;
};

// Each effect lifetime owns its ticket and completion flag. Native Rust remains
// responsible for rejecting cleanup of a ticket superseded by another form.
export function startLocalRecoverySession(state: SessionState, effects: SessionEffects, lockOnCancel: boolean) {
  const current = ++state.generation.current;
  let ticket: number | undefined;
  let disposed = false;
  let completed = false;
  let ended = false;
  state.session.current = null;
  effects.ready(false);
  effects.failed(false);

  function end() {
    if (ticket === undefined || ended) return;
    ended = true;
    void effects.end(ticket, lockOnCancel && !completed).catch(() => {});
  }

  function finish(close: boolean) {
    if (disposed) return;
    disposed = true;
    if (current === state.generation.current) {
      state.generation.current++;
      state.session.current = null;
      end();
      effects.erase();
      effects.ready(false);
      if (close) effects.close();
    }
    end();
  }

  const settled = effects.begin().then((value) => {
    ticket = value.ticket;
    if (disposed || current !== state.generation.current) { end(); return; }
    if (effects.hidden()) { finish(true); return; }
    state.session.current = value;
    effects.ready(true);
  }).catch(() => {
    if (!disposed && current === state.generation.current) effects.failed(true);
  });

  return {
    settled,
    cancel: () => finish(true),
    dispose: () => finish(false),
    complete: () => { if (!disposed) completed = true; },
  };
}
