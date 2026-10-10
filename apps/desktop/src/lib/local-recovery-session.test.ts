import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startLocalRecoverySession, type LocalRecoverySession } from "./local-recovery-session.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function form(state = { generation: { current: 0 }, session: { current: null as LocalRecoverySession | null } }, lockOnCancel = true) {
  const ipc = deferred<LocalRecoverySession>();
  const ended: { ticket: number; lockOnCancel: boolean }[] = [];
  const readyEvents: boolean[] = [];
  const endsAtClose: number[] = [];
  const view = { secret: "typed password", ready: false, failed: false, closes: 0, erases: 0, starts: 0, hidden: false };
  const lifetime = startLocalRecoverySession(state, {
    begin: () => { view.starts++; return ipc.promise; },
    end: async (ticket, lockOnCancel) => { ended.push({ ticket, lockOnCancel }); },
    hidden: () => view.hidden,
    erase: () => { view.secret = ""; view.erases++; },
    close: () => { view.closes++; endsAtClose.push(ended.length); },
    // The recovery kit displays its supplied secret when the session is ready.
    ready: (value) => { view.ready = value; readyEvents.push(value); if (value) view.secret = "recovery code"; },
    failed: (value) => { view.failed = value; },
  }, lockOnCancel);
  return { state, ipc, ended, readyEvents, endsAtClose, view, lifetime };
}

describe("local recovery form lifetime", () => {
  it("opens a session, displays the code, and erases and locks on cancellation", async () => {
    const f = form();
    assert.equal(f.view.starts, 1);
    f.ipc.resolve({ epoch: 8, ticket: 11 });
    await f.lifetime.settled;
    assert.deepEqual(f.state.session.current, { epoch: 8, ticket: 11 });
    assert.equal(f.view.secret, "recovery code");
    assert.equal(f.view.ready, true);

    f.lifetime.cancel();
    f.lifetime.cancel();
    f.lifetime.dispose();
    assert.equal(f.view.secret, "");
    assert.equal(f.view.ready, false);
    assert.equal(f.state.session.current, null);
    assert.equal(f.view.closes, 1);
    assert.equal(f.view.erases, 1);
    assert.deepEqual(f.endsAtClose, [1]);
    assert.deepEqual(f.ended, [{ ticket: 11, lockOnCancel: true }]);
  });

  for (const action of ["cancel", "dispose"] as const) {
    it(`never restores secrets when session IPC resolves after ${action}`, async () => {
      const f = form();
      assert.equal(f.view.starts, 1);
      assert.equal(f.view.secret, "typed password");
      f.lifetime[action]();
      const generation = f.state.generation.current;
      assert.equal(f.view.secret, "");
      f.ipc.resolve({ epoch: 8, ticket: 12 });
      await f.lifetime.settled;

      assert.deepEqual(f.readyEvents, [false, false]);
      assert.equal(f.view.secret, "");
      assert.equal(f.state.session.current, null);
      assert.equal(f.state.generation.current, generation);
      assert.equal(f.view.closes, action === "cancel" ? 1 : 0);
      assert.deepEqual(f.ended, [{ ticket: 12, lockOnCancel: true }]);
    });
  }

  it("successful recovery erases on unmount without locking the recovered box", async () => {
    const f = form();
    f.ipc.resolve({ epoch: 8, ticket: 13 });
    await f.lifetime.settled;
    assert.equal(f.view.ready, true);
    assert.equal(f.view.secret, "recovery code");
    f.lifetime.complete();
    f.lifetime.dispose();
    assert.equal(f.view.secret, "");
    assert.equal(f.state.session.current, null);
    assert.equal(f.view.erases, 1);
    assert.equal(f.view.closes, 0);
    assert.deepEqual(f.ended, [{ ticket: 13, lockOnCancel: false }]);
  });

  it("a late old IPC reply ends only its ticket while the replacement form remains usable", async () => {
    const old = form();
    old.lifetime.dispose();
    const next = form(old.state);
    next.ipc.resolve({ epoch: 8, ticket: 15 });
    await next.lifetime.settled;
    assert.equal(next.view.secret, "recovery code");
    const generation = next.state.generation.current;

    old.ipc.resolve({ epoch: 8, ticket: 14 });
    await old.lifetime.settled;
    old.lifetime.dispose();
    assert.deepEqual(old.ended, [{ ticket: 14, lockOnCancel: true }]);
    assert.equal(next.state.generation.current, generation);
    assert.deepEqual(next.state.session.current, { epoch: 8, ticket: 15 });
    assert.equal(next.view.ready, true);
    assert.equal(next.view.secret, "recovery code");

    // Positive control: cancelling this form must actually release its ticket.
    next.lifetime.cancel();
    assert.deepEqual(next.ended, [{ ticket: 15, lockOnCancel: true }]);
    assert.equal(next.view.secret, "");
  });

  it("old cleanup preserves a new form's session, generation and completion policy", async () => {
    const old = form();
    old.ipc.resolve({ epoch: 8, ticket: 16 });
    await old.lifetime.settled;
    old.lifetime.complete();
    const next = form(old.state);
    next.ipc.resolve({ epoch: 9, ticket: 17 });
    await next.lifetime.settled;
    const generation = next.state.generation.current;

    old.lifetime.dispose();
    assert.deepEqual(old.ended, [{ ticket: 16, lockOnCancel: false }]);
    assert.equal(next.state.generation.current, generation);
    assert.deepEqual(next.state.session.current, { epoch: 9, ticket: 17 });
    assert.equal(next.view.ready, true);
    assert.equal(next.view.secret, "recovery code");
    assert.equal(next.view.erases, 0);

    next.lifetime.cancel();
    assert.equal(next.view.erases, 1);
    assert.deepEqual(next.ended, [{ ticket: 17, lockOnCancel: true }]);
  });

  it("closes and erases if the IPC reply arrives while the document is hidden", async () => {
    const f = form();
    f.view.hidden = true;
    f.ipc.resolve({ epoch: 8, ticket: 18 });
    await f.lifetime.settled;
    assert.equal(f.view.secret, "");
    assert.equal(f.view.closes, 1);
    assert.deepEqual(f.readyEvents, [false, false]);
    assert.deepEqual(f.ended, [{ ticket: 18, lockOnCancel: true }]);
  });

  it("reports a start failure only to the current form", async () => {
    const old = form();
    old.lifetime.cancel();
    const next = form(old.state);
    next.ipc.resolve({ epoch: 8, ticket: 19 });
    await next.lifetime.settled;
    old.ipc.reject(new Error("backgrounded"));
    await old.lifetime.settled;
    assert.equal(old.view.failed, false);
    assert.equal(next.view.ready, true);
    assert.equal(next.view.secret, "recovery code");

    next.lifetime.dispose();
    const failed = form(next.state);
    failed.ipc.reject(new Error("backgrounded"));
    await failed.lifetime.settled;
    assert.equal(failed.view.failed, true);
    assert.equal(failed.view.ready, false);
    assert.equal(failed.state.session.current, null);
    failed.lifetime.dispose();
  });

  it("closing the enable form releases its ticket without locking", async () => {
    const f = form(undefined, false);
    f.ipc.resolve({ epoch: 8, ticket: 20 });
    await f.lifetime.settled;
    assert.equal(f.view.secret, "recovery code");
    f.lifetime.cancel();
    assert.equal(f.view.secret, "");
    assert.equal(f.view.closes, 1);
    assert.deepEqual(f.ended, [{ ticket: 20, lockOnCancel: false }]);
  });
});
