import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { COLLECTIONS, Document, Identity, ListOptions, Repository, Transaction } from './types';

export class MemoryTransaction implements Transaction {
  constructor(public user: Document, private records: Map<string, Document>) {}
  async get(collection: string, id: string): Promise<Document | null> {
    const value = this.records.get(collection + ':' + id);
    return value && value.ownerUserId === this.user._id ? structuredClone(value) : null;
  }
  async save(collection: string, doc: Document): Promise<void> { this.records.set(collection + ':' + doc._id, structuredClone({ ...doc, ownerUserId: this.user._id })); }
  async remove(collection: string, id: string): Promise<void> { this.records.delete(collection + ':' + id); }
  async list(collection: string, filters: Document = {}, options: ListOptions = {}): Promise<Document[]> {
    const result = Array.from(this.records.entries()).filter(([key, doc]) => key.startsWith(collection + ':') && doc.ownerUserId === this.user._id && Object.entries(filters).every(([field, value]) => doc[field] === value))
      .map(([, doc]) => structuredClone(doc)).filter(doc => (!options.from || doc.businessDate >= options.from) && (!options.to || doc.businessDate <= options.to))
      .sort((a, b) => MemoryTransaction.sortAt(b).localeCompare(MemoryTransaction.sortAt(a)) || b._id.localeCompare(a._id));
    const after = options.after;
    const filtered = after ? result.filter(doc => MemoryTransaction.sortAt(doc) < after.sortAt || (MemoryTransaction.sortAt(doc) === after.sortAt && doc._id < after.id)) : result;
    return options.limit ? filtered.slice(0, options.limit) : filtered;
  }
  static sortAt(doc: Document): string { return doc.businessDate || doc.updatedAt || doc.createdAt || ''; }
  async clearOwner(): Promise<void> { for (const [key, doc] of this.records) if (doc.ownerUserId === this.user._id) this.records.delete(key); }
}

export class MemoryRepository implements Repository {
  signingKey = randomBytes(32).toString('hex');
  private users = new Map<string, Document>();
  private records = new Map<string, Document>();
  private queues = new Map<string, Promise<void>>();
  static identityKey(identity: Identity): string { return createHash('sha256').update(identity.appId + '|' + identity.openId).digest('hex'); }
  static newUser(identity: Identity): Document { return { _id: 'usr_' + randomUUID(), ...identity, status: 'ACTIVE', defaultTimezone: 'Asia/Shanghai', createdAt: new Date().toISOString() }; }
  async initialize(): Promise<void> {}
  async withUser<T>(identity: Identity, work: (tx: Transaction) => Promise<T>): Promise<T> {
    const key = MemoryRepository.identityKey(identity);
    const previous = this.queues.get(key) || Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    const queued = previous.then(() => current);
    this.queues.set(key, queued);
    await previous;
    try {
      const user = structuredClone(this.users.get(key) || MemoryRepository.newUser(identity));
      const snapshot = new Map(Array.from(this.records.entries()).filter(([, doc]) => doc.ownerUserId === user._id).map(([id, doc]) => [id, structuredClone(doc)]));
      const tx = new MemoryTransaction(user, snapshot);
      const result = await work(tx);
      const previousOwner = this.users.get(key)?._id || user._id;
      for (const [id, doc] of this.records) if (doc.ownerUserId === previousOwner) this.records.delete(id);
      for (const [id, doc] of snapshot) this.records.set(id, doc);
      this.users.set(key, user);
      return result;
    } finally { release(); if (this.queues.get(key) === queued) this.queues.delete(key); }
  }
  async cleanup(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
    const deletedTasks = new Set(Array.from(this.records.entries()).filter(([key, doc]) => key.startsWith('tasks:') && doc.status === 'DELETED' && doc.deletedAt < cutoff).map(([, doc]) => doc._id));
    for (const [key, doc] of this.records) if (deletedTasks.has(doc.taskId) || deletedTasks.has(doc._id) || (key.startsWith('export_jobs:') && doc.expiresAt < now.toISOString())) this.records.delete(key);
  }
  async pendingExports(): Promise<Identity[]> {
    const owners = new Set(Array.from(this.records.entries()).filter(([key, doc]) => key.startsWith('export_jobs:') && doc.status === 'PENDING').map(([, doc]) => doc.ownerUserId));
    return Array.from(this.users.values()).filter(user => owners.has(user._id)).map(user => ({ appId: user.appId, openId: user.openId }));
  }
  async exportDownload(jobId: string, token: string, now: Date): Promise<Document | null> {
    const job = this.records.get('export_jobs:' + jobId);
    return job && job.status === 'READY' && job.expiresAt > now.toISOString() && job.urlExpiresAt > now.toISOString() && job.tokenHash === createHash('sha256').update(token).digest('hex') ? structuredClone(job.snapshot) : null;
  }
}
