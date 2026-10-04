import { createHash, randomBytes } from 'node:crypto';
import { createPool, Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { COLLECTIONS, Document, Identity, ListOptions, Repository, Transaction } from './types';
import { MemoryRepository, MemoryTransaction } from './repository';

export class MysqlTransaction implements Transaction {
  constructor(public user: Document, private connection: PoolConnection) {}
  static table(collection: string): string {
    if (!COLLECTIONS.includes(collection)) throw new Error('Unknown collection');
    return '`hl_' + collection + '`';
  }
  static document(row: RowDataPacket): Document { return typeof row.document === 'string' ? JSON.parse(row.document) : row.document; }
  async get(collection: string, id: string): Promise<Document | null> {
    const [rows] = await this.connection.execute<RowDataPacket[]>('SELECT document FROM ' + MysqlTransaction.table(collection) + ' WHERE id = ? AND owner_id = ?', [id, this.user._id]);
    return rows.length ? MysqlTransaction.document(rows[0]) : null;
  }
  async save(collection: string, document: Document): Promise<void> {
    const doc: Document = { ...document, ownerUserId: this.user._id };
    await this.connection.execute('INSERT INTO ' + MysqlTransaction.table(collection) + ' (id,owner_id,task_id,round_id,business_date,sort_at,document) VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE task_id=VALUES(task_id),round_id=VALUES(round_id),business_date=VALUES(business_date),sort_at=VALUES(sort_at),document=VALUES(document)',
      [doc._id, this.user._id, doc.taskId || null, doc.roundId || null, doc.businessDate || null, MemoryTransaction.sortAt(doc), JSON.stringify(doc)]);
  }
  async remove(collection: string, id: string): Promise<void> { await this.connection.execute('DELETE FROM ' + MysqlTransaction.table(collection) + ' WHERE id=? AND owner_id=?', [id, this.user._id]); }
  async list(collection: string, filters: Document = {}, options: ListOptions = {}): Promise<Document[]> {
    const clauses = ['owner_id=?'], values: any[] = [this.user._id];
    const columns: Record<string, string> = { taskId: 'task_id', roundId: 'round_id', businessDate: 'business_date' };
    for (const [field, value] of Object.entries(filters)) {
      if (!/^[A-Za-z_]+$/.test(field)) throw new Error('Invalid filter');
      if (columns[field]) { clauses.push(columns[field] + '=?'); values.push(value); }
      else { clauses.push('JSON_UNQUOTE(JSON_EXTRACT(document,?))=?'); values.push('$.' + field, String(value)); }
    }
    if (options.from) { clauses.push('business_date>=?'); values.push(options.from); }
    if (options.to) { clauses.push('business_date<=?'); values.push(options.to); }
    if (options.after) { clauses.push('(sort_at < ? OR (sort_at=? AND id<?))'); values.push(options.after.sortAt, options.after.sortAt, options.after.id); }
    const limit = options.limit ? ' LIMIT ' + Math.max(1, Math.min(100, Math.trunc(options.limit))) : '';
    const [rows] = await this.connection.execute<RowDataPacket[]>('SELECT document FROM ' + MysqlTransaction.table(collection) + ' WHERE ' + clauses.join(' AND ') + ' ORDER BY sort_at DESC,id DESC' + limit, values);
    return rows.map(row => MysqlTransaction.document(row));
  }
  async clearOwner(): Promise<void> { for (const collection of COLLECTIONS) await this.connection.execute('DELETE FROM ' + MysqlTransaction.table(collection) + ' WHERE owner_id=?', [this.user._id]); }
}

export class MysqlRepository implements Repository {
  signingKey = '';
  private pool: Pool;
  constructor(env: NodeJS.ProcessEnv = process.env) {
    const address = env.MYSQL_ADDRESS || '';
    const [host, portText = '3306'] = address.split(':');
    if (!host || !env.MYSQL_USERNAME || !env.MYSQL_PASSWORD) throw new Error('MYSQL_ADDRESS, MYSQL_USERNAME and MYSQL_PASSWORD are required');
    this.pool = createPool({ host, port: Number(portText), user: env.MYSQL_USERNAME, password: env.MYSQL_PASSWORD, database: env.MYSQL_DATABASE || 'nodejs_demo', connectionLimit: 10, connectTimeout: 5000, charset: 'utf8mb4', timezone: 'Z' });
  }
  static migrationStatements(): string[] {
    const statements = [
      'CREATE TABLE IF NOT EXISTS hl_meta (name VARCHAR(64) PRIMARY KEY,value TEXT NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin',
      'CREATE TABLE IF NOT EXISTS hl_users (identity_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,owner_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,document JSON NOT NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin'
    ];
    for (const collection of COLLECTIONS) statements.push('CREATE TABLE IF NOT EXISTS ' + MysqlTransaction.table(collection) + ' (id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,owner_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,task_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,round_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,business_date CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NULL,sort_at VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,document JSON NOT NULL,KEY idx_owner_sort(owner_id,sort_at,id),KEY idx_task_sort(owner_id,task_id,sort_at,id),KEY idx_round(owner_id,task_id,round_id)' + (collection === 'checkins' ? ',UNIQUE KEY uniq_daily(owner_id,task_id,business_date)' : '') + (collection === 'goal_claims' ? ',UNIQUE KEY uniq_claim(owner_id,round_id)' : '') + ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin');
    return statements;
  }
  async initialize(): Promise<void> {
    for (const sql of MysqlRepository.migrationStatements()) await this.pool.query(sql);
    await this.pool.execute('INSERT IGNORE INTO hl_meta(name,value) VALUES (?,?)', ['cursor_signing_key', randomBytes(32).toString('hex')]);
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT value FROM hl_meta WHERE name=?', ['cursor_signing_key']);
    this.signingKey = rows[0].value;
  }
  async withUser<T>(identity: Identity, work: (tx: Transaction) => Promise<T>): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const key = MemoryRepository.identityKey(identity), initial = MemoryRepository.newUser(identity);
      await connection.execute('INSERT INTO hl_users(identity_key,owner_id,document) VALUES (?,?,?) ON DUPLICATE KEY UPDATE identity_key=identity_key', [key, initial._id, JSON.stringify(initial)]);
      const [rows] = await connection.execute<RowDataPacket[]>('SELECT document FROM hl_users WHERE identity_key=? FOR UPDATE', [key]);
      const user = MysqlTransaction.document(rows[0]);
      const result = await work(new MysqlTransaction(user, connection));
      await connection.execute('UPDATE hl_users SET owner_id=?,document=? WHERE identity_key=?', [user._id, JSON.stringify(user), key]);
      await connection.commit(); return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }
  async pendingExports(): Promise<Identity[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT u.document FROM hl_users u WHERE EXISTS (SELECT 1 FROM hl_export_jobs e WHERE e.owner_id=u.owner_id AND JSON_UNQUOTE(JSON_EXTRACT(e.document,'$.status'))='PENDING') LIMIT 50");
    return rows.map(row => { const doc = MysqlTransaction.document(row); return { appId: doc.appId, openId: doc.openId }; });
  }
  async exportDownload(jobId: string, token: string, now: Date): Promise<Document | null> {
    const [rows] = await this.pool.execute<RowDataPacket[]>('SELECT document FROM hl_export_jobs WHERE id=?', [jobId]);
    if (!rows.length) return null;
    const job = MysqlTransaction.document(rows[0]);
    return job.status === 'READY' && job.expiresAt > now.toISOString() && job.urlExpiresAt > now.toISOString() && job.tokenHash === createHash('sha256').update(token).digest('hex') ? job.snapshot : null;
  }
  async cleanup(now: Date): Promise<void> {
    const cutoff = new Date(now.getTime() - 30 * 86400000).toISOString();
    const [rows] = await this.pool.execute<RowDataPacket[]>("SELECT id,owner_id FROM hl_tasks WHERE JSON_UNQUOTE(JSON_EXTRACT(document,'$.status'))='DELETED' AND JSON_UNQUOTE(JSON_EXTRACT(document,'$.deletedAt'))<? LIMIT 100", [cutoff]);
    for (const row of rows) for (const collection of COLLECTIONS.filter(name => name !== 'command_receipts')) await this.pool.execute('DELETE FROM ' + MysqlTransaction.table(collection) + ' WHERE owner_id=? AND ' + (collection === 'tasks' ? 'id' : 'task_id') + '=?', [row.owner_id, row.id]);
    await this.pool.execute("DELETE FROM hl_export_jobs WHERE JSON_UNQUOTE(JSON_EXTRACT(document,'$.expiresAt'))<?", [now.toISOString()]);
  }
  async close(): Promise<void> { await this.pool.end(); }
}
