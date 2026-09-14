const test = require('node:test');
const assert = require('node:assert/strict');
const bs58Import = require('bs58');
const bs58 = bs58Import.default ?? bs58Import;

const { sendConfirm } = require('../sendtx.cjs');

test('sendConfirm journals the deterministic signature before broadcasting', async () => {
  const events = [];
  const signature = Buffer.alloc(64, 7);
  const tx = {
    signatures: [],
    signature: null,
    sign() { this.signature = signature; },
    serialize() { return Buffer.from('signed'); },
  };
  const signer = { publicKey: 'OWNER' };
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: 'BH', lastValidBlockHeight: 12 }),
    sendRawTransaction: async () => { events.push('broadcast'); return bs58.encode(signature); },
    getSignatureStatuses: async () => ({ value: [{ confirmationStatus: 'confirmed', err: null }] }),
  };
  const returned = await sendConfirm(conn, tx, [signer], 'test', {
    beforeSend: async ({ signature: sig }) => { events.push(`journal:${sig}`); },
  });
  assert.equal(returned, bs58.encode(signature));
  assert.deepEqual(events, [`journal:${bs58.encode(signature)}`, 'broadcast']);
});

test('hybrid caller can disable in-process expiry retry and preserve submitted signature', async () => {
  let broadcasts = 0;
  const signature = Buffer.alloc(64, 8);
  const tx = {
    signatures: [], signature: null,
    sign() { this.signature = signature; },
    serialize() { return Buffer.from('signed'); },
  };
  const conn = {
    getLatestBlockhash: async () => ({ blockhash: 'BH', lastValidBlockHeight: 12 }),
    sendRawTransaction: async () => { broadcasts++; return bs58.encode(signature); },
    getSignatureStatuses: async () => ({ value: [null] }),
    getBlockHeight: async () => 13,
  };
  await assert.rejects(sendConfirm(conn, tx, [{ publicKey: 'OWNER' }], 'hybrid', { retryExpired: false }), /blockhash expired/);
  assert.equal(broadcasts, 1);
});
