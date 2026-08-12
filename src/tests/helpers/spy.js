/** Minimal vi.fn() replacement: records call arguments, optionally delegates. */
export function spy (impl = () => undefined) {
  const fn = (...args) => { fn.calls.push(args); return impl(...args) }
  fn.calls = []
  Object.defineProperty(fn, 'callCount', { get: () => fn.calls.length })
  fn.reset = () => { fn.calls.length = 0 }
  return fn
}
