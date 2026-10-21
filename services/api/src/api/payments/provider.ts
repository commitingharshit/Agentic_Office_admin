// What a payment provider has to do for us, and nothing more. Our billing service owns users, subscriptions and credits; a provider only
// takes a payment and tells us what it saw. Replacing the provider changes one adapter, never the plans, periods or ledger.
export type ProviderEventKind = 'SUCCESS' | 'FAILED' | 'EXPIRED' | 'CANCELLED';

export interface CheckoutRequest {
  orderId: string;                // our order id; the provider echoes it back
  amountMinor: number;            // integer minor units (paise)
  currency: string;               // lower-case code, e.g. inr
  description: string;
  returnUrl?: string;
  customer?: { name?: string; email?: string };
  metadata?: Record<string, string>;
}
export interface Checkout { providerPaymentId: string; checkoutUrl: string }

/** What the provider says about one payment. Never proof of settlement by itself. */
export interface ProviderPayment {
  providerPaymentId: string;
  orderId: string;
  status: 'INITIATED' | 'ACTIVE' | 'QUEUED' | 'PROCESSING' | ProviderEventKind;
  amountMinor: number;
  currency: string;
  verificationLevel: number;      // 0 = unverified, 1 = one bank signal, 2 = two independent signals
  reference?: string;             // the bank's reference (UTR) when it reported one
}

/** A webhook after its signature, timestamp and shape were checked. */
export interface VerifiedWebhook {
  deliveryId: string;
  event: ProviderEventKind;
  providerPaymentId: string;
  orderId: string;
  amountMinor: number;
  currency: string;
  reference?: string;
  verificationLevel?: number;
  payload: Record<string, unknown>;
}

export class WebhookRejected extends Error {
  readonly reason: 'signature' | 'timestamp' | 'shape' | 'delivery';
  constructor(reason: 'signature' | 'timestamp' | 'shape' | 'delivery', message: string) { super(message); this.reason = reason; }
}

export interface PaymentProvider {
  readonly id: string;
  /** Experimental providers are off unless explicitly enabled, and their orders are never settled automatically. */
  readonly experimental: boolean;
  createCheckout(req: CheckoutRequest): Promise<Checkout>;
  getPayment(providerPaymentId: string): Promise<ProviderPayment>;
  cancel(providerPaymentId: string): Promise<void>;
  /** Throws WebhookRejected. `rawBody` is the exact bytes received. */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>, now?: number): VerifiedWebhook;
}
