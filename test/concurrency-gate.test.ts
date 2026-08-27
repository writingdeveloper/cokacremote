import { describe, expect, it } from "vitest";

import { BusyError, ConcurrencyGate } from "../src/concurrency-gate.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("ConcurrencyGate", () => {
  it("executes immediately while capacity is available", async () => {
    const gate = new ConcurrencyGate(2, 2);
    const result = await gate.run(async () => 42);
    expect(result).toBe(42);
    expect(gate.stats()).toEqual({ active: 0, queued: 0, maxConcurrent: 2, maxQueued: 2 });
  });

  it("queues work in FIFO order and drains it after active work finishes", async () => {
    const gate = new ConcurrencyGate(1, 2);
    const hold = deferred<void>();
    const order: string[] = [];
    const first = gate.run(async () => { order.push("first-start"); await hold.promise; order.push("first-end"); });
    const second = gate.run(async () => { order.push("second"); });
    const third = gate.run(async () => { order.push("third"); });

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(gate.stats()).toMatchObject({ active: 1, queued: 2 });
    hold.resolve();
    await Promise.all([first, second, third]);
    expect(order).toEqual(["first-start", "first-end", "second", "third"]);
    expect(gate.stats()).toMatchObject({ active: 0, queued: 0 });
  });

  it("rejects new work once the queue is saturated without cancelling active work", async () => {
    const gate = new ConcurrencyGate(1, 1);
    const hold = deferred<void>();
    let activeFinished = false;
    const first = gate.run(async () => { await hold.promise; activeFinished = true; });
    const queued = gate.run(async () => undefined);

    await expect(gate.run(async () => undefined)).rejects.toBeInstanceOf(BusyError);
    expect(activeFinished).toBe(false);
    expect(gate.stats()).toMatchObject({ active: 1, queued: 1 });
    hold.resolve();
    await Promise.all([first, queued]);
    expect(activeFinished).toBe(true);
  });
});
