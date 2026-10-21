const tails = new Map<string, Promise<unknown>>();

/** Runs `fn` after every earlier call for the same device has settled, so adb commands never interleave. */
export function withDevice<T>(serial: string, fn: () => Promise<T>): Promise<T> {
  const previous = tails.get(serial) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  tails.set(serial, next);
  return next;
}
