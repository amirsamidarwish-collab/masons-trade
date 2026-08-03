export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  DB: D1Database;
  AI: Ai;
  DRY_RUN: string;
  SITE_ORIGIN: string;
  FROM_EMAIL: string;
  TEST_INBOX: string;
  RESEND_API_KEY: string;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPERATOR_CHAT_ID: string;
  SUBSCRIBE_LIMITER: RateLimiter;
}

export type SubscriberStatus =
  | 'pending_approval'
  | 'approved'
  | 'unsubscribed'
  | 'bounced';

export interface Subscriber {
  id: number;
  email: string;
  status: SubscriberStatus;
  unsub_token: string;
  created_at: number;
  approved_at: number | null;
}

export interface Trade {
  pair: string;
  direction: 'Buy' | 'Sell';
  entry: string;
  take_profit: string;
  stop_loss: string;
  note: string | null;
}

export interface StoredTrade extends Trade {
  id: number;
  draft_token: string;
  status: 'draft' | 'sending' | 'sent' | 'cancelled';
}
