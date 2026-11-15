/**
 * Cordis service probes that never take the Host down.
 *
 * A Cordis context answers `undefined` for an absent service — but NOT always:
 * reading an undeclared service as a property THROWS
 * (`cannot get property "x" without inject`), and a provider whose construction
 * failed can make `ctx.get(name)` throw too. One unguarded probe on a `/state`
 * path already killed the Host once, while the plugin was live in an operator's
 * session (the load model's `tokenMeter` read).
 *
 * Every optional capability therefore goes through `optionalServiceOf`: it
 * answers `null` for "not available" and reports the failure instead of
 * propagating it. A caller that cannot do without a service must say so with its
 * own refusal, not with an exception.
 */

/**
 * @param {unknown} ctx a Cordis context (or anything with a `get` method)
 * @param {string} name exact service name
 * @param {(error: unknown) => void} [onError] reporter for a THROWING probe
 * @returns {any|null} the service, or `null` when it is absent or unreadable
 */
export function optionalServiceOf(ctx, name, onError = null) {
  if (ctx === null || ctx === undefined) return null
  try {
    if (typeof ctx.get === 'function') return ctx.get(name) ?? null
  } catch (error) {
    if (typeof onError === 'function') onError(error)
    return null
  }
  return null
}
