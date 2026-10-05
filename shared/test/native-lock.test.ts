import assert from "node:assert/strict";
import { test } from "node:test";
import { bindNativeLock } from "../lib/native-lock.ts";

test("each new native lock epoch clears once without polling; late results cannot reopen", () => {
  let cleared = 0;
  const binding = bindNativeLock(null, () => { cleared += 1; });
  binding.accept({ epoch: 0, unlocked: false });
  assert.equal(cleared, 0, "initial locked polling must preserve setup input");
  binding.accept({ epoch: 1, unlocked: true });
  binding.accept({ epoch: 2, unlocked: false });
  assert.equal(cleared, 1);
  binding.accept({ epoch: 3, unlocked: true });
  binding.accept({ epoch: 2, unlocked: false });
  assert.equal(cleared, 1, "late previous lock must preserve fresh authentication input");
  binding.accept({ epoch: 4, unlocked: false });
  binding.accept({ epoch: 4, unlocked: false });
  assert.equal(cleared, 2, "event and poll for one transition must not clear twice");
  binding.accept({ epoch: 5, unlocked: true });
  binding.accept({ epoch: 6, unlocked: false });
  assert.equal(cleared, 3);
  binding.dispose();
  binding.accept({ epoch: 7, unlocked: false });
  assert.equal(cleared, 3, "disposed screen must ignore late results");
});
