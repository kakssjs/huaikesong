// TEST ONLY. A stand-in signing and payment provider for the isolated contract acceptance script
// (scripts/contract-provider-http-smoke.cjs). It is not a real provider and connects to nothing: sessions and payments
// live in a JSON file, and the acceptance script plays the part of the signer or payer by editing that file.
// It refuses to load unless CONTRACT_PROVIDER_TEST_ONLY=1 and the state file is inside the OS temp directory.
// Never point CONTRACT_PROVIDER_MODULE at this file on a server that real people use.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const file = process.env.TEST_CONTRACT_PROVIDER_STATE ? path.resolve(process.env.TEST_CONTRACT_PROVIDER_STATE) : '';
const tmp = path.resolve(os.tmpdir());
if (process.env.CONTRACT_PROVIDER_TEST_ONLY !== '1' || !file || !file.startsWith(tmp + path.sep)) {
  throw new Error('test-contract-provider is for isolated acceptance only (needs CONTRACT_PROVIDER_TEST_ONLY=1 and a state file in the temp directory)');
}
const read = () => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return { sessions: {}, payments: {} }; } };
const write = state => fs.writeFileSync(file, JSON.stringify(state, null, 2));
const id = prefix => `${prefix}-${crypto.randomBytes(6).toString('hex')}`;

export const signing = {
  name: 'acceptance-test-esign',
  async createSignRequest(input) {
    const state = read();
    // Same request id -> same session, as the interface requires.
    const existing = Object.values(state.sessions).find(s => s.requestId === input.requestId);
    if (existing) return { externalId: existing.externalId, signUrl: existing.signUrl };
    const externalId = id('sign');
    const signUrl = `https://esign.acceptance.invalid/session/${externalId}`;
    state.sessions[externalId] = { externalId, signUrl, requestId: input.requestId, role: input.role, signerName: input.signer.name,
      organization: input.signer.organization, termsHash: input.termsHash, supplement: input.supplement ?? null, status: 'open' };
    write(state);
    return { externalId, signUrl };
  },
  async fetchResult(externalId) {
    const s = read().sessions[externalId];
    if (!s || s.status === 'open') return null;
    if (s.status === 'declined') return { provider: this.name, externalId, receiptId: `rcpt-${externalId}`, signerVerified: true, signedAt: new Date().toISOString(), evidenceHash: '0'.repeat(64), outcome: 'declined' };
    return { provider: this.name, externalId, receiptId: `rcpt-${externalId}`, signerVerified: s.signerVerified !== false,
      organizationVerified: s.organization ? s.organizationVerified !== false : undefined, signerName: s.signerName, termsHash: s.termsHash,
      signedAt: s.signedAt, evidenceHash: crypto.createHash('sha256').update(`${externalId}:${s.termsHash}`).digest('hex') };
  },
  async verifyCallback(input) {
    if (input.headers['x-acceptance-token'] !== process.env.TEST_CONTRACT_PROVIDER_TOKEN) return null;
    const body = JSON.parse(input.body || '{}');
    return typeof body.externalId === 'string' ? { externalId: body.externalId } : null;
  },
};

export const payment = {
  name: 'acceptance-test-pay',
  async createPayment(input) {
    const state = read();
    const existing = Object.values(state.payments).find(p => p.idempotencyKey === input.idempotencyKey);
    if (existing) return { externalId: existing.externalId, ...(existing.payUrl ? { payUrl: existing.payUrl } : {}) };
    const externalId = id(input.kind);
    const payUrl = input.kind === 'fund' ? `https://pay.acceptance.invalid/checkout/${externalId}` : undefined;
    // What the server told the provider is kept, so the acceptance script can check the payee and the fee split it was given.
    state.payments[externalId] = { externalId, payUrl, idempotencyKey: input.idempotencyKey, kind: input.kind, amountCents: input.amountCents,
      stageId: input.stageId ?? null, status: 'pending', platformFeeCents: input.platformFeeCents ?? null,
      payer: input.payer?.legalName ?? null, payee: input.payee?.legalName ?? null, relatedExternalIds: input.relatedExternalIds ?? null };
    write(state);
    return { externalId, ...(payUrl ? { payUrl } : {}) };
  },
  async fetchPayment(externalId) {
    const p = read().payments[externalId];
    if (!p) return null;
    return { provider: this.name, externalId, receiptId: `pay-${externalId}`, status: p.status, amountCents: p.reportedAmountCents ?? p.amountCents,
      ...(p.status === 'succeeded' ? { confirmedAt: p.confirmedAt } : {}), ...(p.kind === 'release' && p.platformFeeCents !== null ? { feeCents: p.platformFeeCents } : {}),
      reconciled: p.status === 'succeeded' };
  },
  // The acceptance script decides whether this stand-in "can still stop" a payout by setting cancellable on the record.
  async cancelPayment(externalId) {
    const state = read(), p = state.payments[externalId];
    if (!p || p.status !== 'pending' || p.cancellable !== true) return false;
    p.status = 'failed'; p.cancelled = true; write(state);
    return true;
  },
};
