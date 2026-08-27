export class BusyError extends Error {
  constructor(message = "Server is busy; retry later") {
    super(message);
    this.name = "BusyError";
  }
}

export interface ConcurrencyGateStats {
  active: number;
  queued: number;
  maxConcurrent: number;
  maxQueued: number;
}

interface QueuedOperation<T> {
  operation: () => Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

export class ConcurrencyGate {
  readonly #maxConcurrent: number;
  readonly #maxQueued: number;
  #active = 0;
  readonly #queue: Array<QueuedOperation<unknown>> = [];

  constructor(maxConcurrent: number, maxQueued: number) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("maxConcurrent must be a positive integer");
    }
    if (!Number.isSafeInteger(maxQueued) || maxQueued < 0) {
      throw new Error("maxQueued must be a non-negative integer");
    }
    this.#maxConcurrent = maxConcurrent;
    this.#maxQueued = maxQueued;
  }

  stats(): ConcurrencyGateStats {
    return {
      active: this.#active,
      queued: this.#queue.length,
      maxConcurrent: this.#maxConcurrent,
      maxQueued: this.#maxQueued,
    };
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#active < this.#maxConcurrent) {
      return this.#execute(operation);
    }
    if (this.#queue.length >= this.#maxQueued) {
      throw new BusyError();
    }
    return new Promise<T>((resolve, reject) => {
      this.#queue.push({ operation, resolve, reject } as QueuedOperation<unknown>);
    });
  }

  async #execute<T>(operation: () => Promise<T>): Promise<T> {
    this.#active += 1;
    try {
      return await operation();
    } finally {
      this.#active = Math.max(0, this.#active - 1);
      this.#drain();
    }
  }

  #drain(): void {
    while (this.#active < this.#maxConcurrent && this.#queue.length > 0) {
      const queued = this.#queue.shift();
      if (!queued) {
        return;
      }
      void this.#execute(queued.operation).then(queued.resolve, queued.reject);
    }
  }
}
