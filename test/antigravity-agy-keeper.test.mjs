import assert from "node:assert/strict";
import test from "node:test";

import { startAgySessionKeeper } from "../src/antigravity-agy-keeper.mjs";

test("agy session keeper is a no-op when ANTIGRAVITY_SESSION_SOURCE is not agy", () => {
  const previous = process.env.ANTIGRAVITY_SESSION_SOURCE;
  try {
    delete process.env.ANTIGRAVITY_SESSION_SOURCE;
    let logged = false;
    const keeper = startAgySessionKeeper({ log: () => { logged = true; } });
    assert.equal(logged, false);
    assert.doesNotThrow(() => keeper.stop());
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_SESSION_SOURCE;
    else process.env.ANTIGRAVITY_SESSION_SOURCE = previous;
  }
});

test("agy session keeper activates and stops cleanly when ANTIGRAVITY_SESSION_SOURCE is agy", () => {
  const previous = process.env.ANTIGRAVITY_SESSION_SOURCE;
  try {
    process.env.ANTIGRAVITY_SESSION_SOURCE = "agy";
    const keeper = startAgySessionKeeper({ log: () => {} });
    assert.doesNotThrow(() => keeper.stop());
  } finally {
    if (previous === undefined) delete process.env.ANTIGRAVITY_SESSION_SOURCE;
    else process.env.ANTIGRAVITY_SESSION_SOURCE = previous;
  }
});
