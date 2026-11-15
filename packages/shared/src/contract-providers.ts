/**
 * Provider interfaces for real contract signing and real money movement.
 *
 * No provider is bundled. Nothing in this repository claims to be connected to an e-signature vendor, an escrow
 * agent or a payment institution. A deployment registers its own implementation of these two interfaces (see
 * registerContractProviders and CONTRACT_PROVIDER_MODULE in docs/V2使用与部署说明.md); until it does, the real actions
 * are refused with PROVIDER_NOT_CONFIGURED instead of being recorded as if they had succeeded.
 *
 * The fields are the ones every vendor has in some form (an external id, a receipt id, a verification result,
 * an evidence digest). They are deliberately not named after any one vendor's API.
 *
 * Flow: a party asks to sign or to move money -> the workflow records a provider request -> the server calls
 * createSignRequest/createPayment with the request id as idempotency key -> the party finishes on the provider's page
 * -> the server asks the provider for the outcome (fetchResult/fetchPayment, triggered by a verified callback or by a
 * sync) -> only that provider record is written into the contract. A browser never supplies a receipt.
 */
import { WorkflowError, type ContractParty, type PaymentReceipt, type SigningReceipt, type WorkflowRole } from './workflow';

export interface SignRequestInput {
  /** Stable per request; the provider must treat a repeated id as the same session. */
  requestId: string;
  contractId: string; version: number; role: WorkflowRole;
  /** Present when the party signs a supplementary agreement rather than the contract itself. */
  supplement?: { id: string; number: number };
  /** The frozen terms digest the signer is agreeing to. The provider must bind its evidence to this value. */
  termsHash: string;
  signer: { name: string; party: ContractParty; organization: boolean };
}
export interface SignRequestResult {
  externalId: string;
  /** Where the signer completes identity verification and signing. Must be https. */
  signUrl: string;
  expiresAt?: string;
}
/** What a verified callback identifies. The server then asks the provider for the record; the callback body is never trusted as a receipt. */
export interface CallbackReference { externalId: string }
export interface CallbackInput { headers: Record<string, string>; body: string }
export interface SigningProvider {
  readonly name: string;
  /** Start a signing session for one party. Does not mean the party has signed. */
  createSignRequest(input: SignRequestInput): Promise<SignRequestResult>;
  /** The provider's own record of a session: null while the party has not finished. Never a client-supplied value. */
  fetchResult(externalId: string): Promise<SigningReceipt | null>;
  /** Optional: verify a provider callback (signature, timestamp) and say which session it is about. */
  verifyCallback?(input: CallbackInput): Promise<CallbackReference | null>;
}

export interface PaymentRequestInput {
  contractId: string; stageId?: string;
  kind: 'fund' | 'release' | 'refund';
  amountCents: number;
  /** Stable per user action. The provider must treat a repeated key as the same movement. */
  idempotencyKey: string;
  reason?: string;
  /** fund: the homeowner who pays in. */
  payer?: ContractParty;
  /** release: the contractor who is paid. refund: the homeowner who gets money back. */
  payee?: ContractParty;
  /** release only: the part of amountCents that is the platform fee. The payee receives amountCents minus this. Fixed at the platform review. */
  platformFeeCents?: number;
  /** refund only: this contract's incoming payments already recorded from this provider, for providers that refund against an original payment. */
  relatedExternalIds?: string[];
}
export interface PaymentRequestResult {
  externalId: string;
  /** Present when the payer still has to pay (for example a checkout link). Must be https. */
  payUrl?: string;
}
export interface PaymentProvider {
  readonly name: string;
  createPayment(input: PaymentRequestInput): Promise<PaymentRequestResult>;
  /** Ask the provider for the outcome of one movement. Must come from the provider, not from the browser. null if it has no such record. */
  fetchPayment(externalId: string): Promise<PaymentReceipt | null>;
  /** Optional: verify a provider callback and say which movement it is about. */
  verifyCallback?(input: CallbackInput): Promise<CallbackReference | null>;
  /**
   * Optional: stop a movement that has not completed. Resolve true only when the provider confirms nothing moved and nothing will.
   * Used when a dispute is opened while a payout is with the provider; without it the payout stays on hold until its receipt arrives.
   */
  cancelPayment?(externalId: string): Promise<boolean>;
}

export function requireSigningProvider(provider: SigningProvider | undefined): SigningProvider {
  if (!provider) throw new WorkflowError('尚未配置电子签署服务商，不能进行真实签署', 'PROVIDER_NOT_CONFIGURED', 503);
  return provider;
}
export function requirePaymentProvider(provider: PaymentProvider | undefined): PaymentProvider {
  if (!provider) throw new WorkflowError('尚未配置资金服务商，不能进行真实入金、拨付或退款', 'PROVIDER_NOT_CONFIGURED', 503);
  return provider;
}

export interface ContractProviders { signing?: SigningProvider; payment?: PaymentProvider }
// Kept on globalThis: Next.js bundles instrumentation and route handlers separately, but they share one process.
const store = globalThis as unknown as { __contractProviders?: ContractProviders };
const usable = (provider: unknown, methods: string[]): boolean => !!provider && typeof provider === 'object'
  && typeof (provider as { name?: unknown }).name === 'string' && !!(provider as { name: string }).name.trim()
  && methods.every(method => typeof (provider as Record<string, unknown>)[method] === 'function');
/**
 * Called once at server start by the deployment. Passing a key with undefined removes that provider.
 * A provider without a name or without its two required methods is refused here, at start-up, rather than failing later in the middle of a signature or a payment.
 */
export function registerContractProviders(next: ContractProviders): void {
  if (next.signing !== undefined && !usable(next.signing, ['createSignRequest', 'fetchResult'])) throw new Error('signing provider needs a name, createSignRequest and fetchResult');
  if (next.payment !== undefined && !usable(next.payment, ['createPayment', 'fetchPayment'])) throw new Error('payment provider needs a name, createPayment and fetchPayment');
  store.__contractProviders = { ...(store.__contractProviders ?? {}), ...next };
}
export function getContractProviders(): ContractProviders {
  return { ...(store.__contractProviders ?? {}) };
}
