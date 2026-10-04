export type Document = Record<string, any>;
export interface Identity { appId: string; openId: string; }
export interface Command { protocolVersion: number; action: string; requestId: string; payload: Document; }
export interface ListOptions { limit?: number; after?: { sortAt: string; id: string }; from?: string; to?: string; }
export interface Transaction {
  user: Document;
  get(collection: string, id: string): Promise<Document | null>;
  save(collection: string, document: Document): Promise<void>;
  remove(collection: string, id: string): Promise<void>;
  list(collection: string, filters?: Document, options?: ListOptions): Promise<Document[]>;
  clearOwner(): Promise<void>;
}
export interface Repository {
  signingKey: string;
  withUser<T>(identity: Identity, work: (tx: Transaction) => Promise<T>): Promise<T>;
  initialize(): Promise<void>;
  cleanup(now: Date): Promise<void>;
  pendingExports(): Promise<Identity[]>;
  exportDownload(jobId: string, token: string, now: Date): Promise<Document | null>;
}
export const COLLECTIONS = ['tasks', 'task_rules', 'rounds', 'checkins', 'points_ledger', 'goal_claims', 'command_receipts', 'outbox_events', 'export_jobs', 'notification_jobs'];
