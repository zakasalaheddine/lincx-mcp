/**
 * tests/helpers/mockWorkApi.js
 *
 * esmock mock factories for the Work API and session layers.
 *
 * No module-global state: each call builds a fresh mock, so ava's in-file
 * concurrency is safe. Pass the results as esmock's child-mock argument.
 *
 *   import esmock from 'esmock'
 *   import { workApiMock, sessionMock } from './helpers/mockWorkApi.js'
 *
 *   const mod = await esmock('../tools/templateTools.js', {
 *     '../services/workApi.js': workApiMock([
 *       ['GET', /\/templates\/123$/, () => ({ id: '123', name: 'My Template' })]
 *     ]),
 *     '../services/sessionManager.js': sessionMock()
 *   })
 *
 * The mock KEYS are the specifiers as written in the TARGET module, not paths
 * relative to the test file.
 */

export function workApiMock (routes = []) {
  return {
    workApiRequest: async (_session, method, path, opts) => {
      const match = routes.find(([m, re]) => m === method && re.test(path))
      if (!match) throw new Error(`workApiMock: unmatched ${method} ${path}`)
      return match[2](opts?.params)
    },
    handleWorkApiError: (err) => `Error: ${err.message}`,
    truncateIfNeeded: (s) => s,
    stripListItems: (d) => d
  }
}

export function sessionMock (overrides = {}) {
  return {
    resolveLincxSession: async () => 'test-session',
    validateSession: async () => ({ valid: true, session: { token: 't' } }),
    ...overrides
  }
}
