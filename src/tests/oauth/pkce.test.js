import test from 'ava'
import { createHash, randomBytes } from 'node:crypto'
import { verifyPkce } from '../../services/oauth/pkce.js'

function challengeFromVerifier (verifier) {
  return createHash('sha256').update(verifier).digest('base64url')
}

{ // verifyPkce
  test('verifyPkce > accepts a correct S256 verifier', t => {
    const verifier = randomBytes(32).toString('base64url')
    const challenge = challengeFromVerifier(verifier)
    t.is(verifyPkce(verifier, challenge, 'S256'), true)
  })

  test('verifyPkce > rejects a wrong verifier', t => {
    const verifier = 'a'.repeat(64)
    const challenge = challengeFromVerifier('b'.repeat(64))
    t.is(verifyPkce(verifier, challenge, 'S256'), false)
  })

  test('verifyPkce > rejects an unsupported method (plain)', t => {
    t.is(verifyPkce('a'.repeat(64), 'a'.repeat(64), 'plain'), false)
  })

  test('verifyPkce > rejects too-short verifier (< 43 chars per RFC)', t => {
    t.is(verifyPkce('short', 'anything', 'S256'), false)
  })

  test('verifyPkce > rejects too-long verifier (> 128 chars per RFC)', t => {
    t.is(verifyPkce('a'.repeat(129), 'anything', 'S256'), false)
  })
}
