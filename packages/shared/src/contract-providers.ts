/**
 * Provider interfaces for real contract signing and real money movement.
 *
 * No provider is bundled. Nothing in this repository claims to be connected to an e-signature vendor, an escrow
 * agent or a payment institution. A deployment wires its own implementation of these two interfaces; until it does,
 * the real actions are refused with PROVIDER_NOT_CONFIGURED instead of being recorded as if they had succeeded.
 *
 * The fields are the ones every vendor has in some form (an external id, a receipt id, a verification result,
 * an evidence digest). They are deliberately not named after any one vendor's API.
 */
import { WorkflowError, type ContractParty, type PaymentReceipt, type SigningReceipt, type WorkflowRole } from './workflow';

export interface SignRequestInput {
  contractId: string; version: number; role: WorkflowRole;
  /** The frozen terms digest the signer is agreeing to. The provider must bind its evidence to this value. */
  termsHash: string;
  signer: { name: string; party: ContractParty };
}
export interface SignRequestResult {
  externalId: string;
  /** Where the signer completes identity verification and signing. */
  signUrl: string;
  expiresAt?: string;
}
export interface SigningProvider {
  readonly name: string;
  /** Start a signing session for one party. Does not mean the party has signed. */
  createSignRequest(input: SignRequestInput): Promise<SignRequestResult>;
  /** Ask the provider for the outcome of a session. Must return the provider's own record, never a client-supplied one. */
  fetchResult(externalId: string): Promise<SigningReceipt>;
}

export interface PaymentRequestInput {
  contractId: string; stageId?: string;
  kind: 'fund' | 'release' | 'refund';
  amountCents: number;
  /** Stable per user action. The provider must treat a repeated key as the same movement. */
  idempotencyKey: string;
  reason?: string;
}
export interface PaymentRequestResult {
  externalId: string;
  /** Present when the payer still has to pay (for example a checkout link). */
  payUrl?: string;
}
export interface PaymentProvider {
  readonly name: string;
  createPayment(input: PaymentRequestInput): Promise<PaymentRequestResult>;
  /** Ask the provider for the outcome of one movement. Must come from the provider, not from the browser. */
  fetchPayment(externalId: string): Promise<PaymentReceipt>;
}

export function requireSigningProvider(provider: SigningProvider | undefined): SigningProvider {
  if (!provider) throw new WorkflowError('尚未配置电子签署服务商，不能进行真实签署', 'PROVIDER_NOT_CONFIGURED', 503);
  return provider;
}
export function requirePaymentProvider(provider: PaymentProvider | undefined): PaymentProvider {
  if (!provider) throw new WorkflowError('尚未配置资金服务商，不能进行真实入金、拨付或退款', 'PROVIDER_NOT_CONFIGURED', 503);
  return provider;
}
