import { createHash, randomBytes } from 'node:crypto';
import { BusinessError } from './errors';
import { COLLECTIONS, Document } from './types';
import { State } from './state';

export class PersonalOperations {
  constructor(private state: State, private baseUrl: string) {}
  async requestExport(): Promise<Document> {
    const s = this.state;
    const jobs = await s.tx.list('export_jobs');
    if (jobs.some(job => job.status === 'PENDING')) throw new BusinessError('EXPORT_IN_PROGRESS', '已有导出正在生成，请稍后查看。');
    const job = { _id: s.id('exp'), status: 'PENDING', format: 'JSON', createdAt: s.timestamp, expiresAt: new Date(s.now.getTime() + 86400000).toISOString(), snapshot: null, tokenHash: null, urlExpiresAt: null, errorCode: null };
    await s.tx.save('export_jobs', job);
    return { jobId: job._id, status: 'PENDING' };
  }
  async getExport(payload: Document): Promise<Document> {
    const s = this.state, job = await s.tx.get('export_jobs', payload.jobId);
    if (!job) throw new BusinessError('NOT_FOUND', '导出任务不存在或已过期。');
    if (job.expiresAt <= s.timestamp) return { jobId: job._id, status: 'EXPIRED', downloadUrl: null, urlExpiresAt: null, errorCode: null };
    if (job.status !== 'READY') return { jobId: job._id, status: job.status, downloadUrl: null, urlExpiresAt: null, errorCode: job.errorCode };
    const token = randomBytes(32).toString('base64url');
    job.tokenHash = createHash('sha256').update(token).digest('hex');
    job.urlExpiresAt = new Date(Math.min(s.now.getTime() + 600000, Date.parse(job.expiresAt))).toISOString();
    await s.tx.save('export_jobs', job);
    return { jobId: job._id, status: 'READY', downloadUrl: this.baseUrl + '/api/exports/' + job._id + '?token=' + token, urlExpiresAt: job.urlExpiresAt, errorCode: null };
  }
  async processExports(): Promise<void> {
    const s = this.state, jobs = await s.tx.list('export_jobs', { status: 'PENDING' });
    for (const job of jobs) {
      try {
        const tasks = (await s.tx.list('tasks')).filter(task => task.status !== 'DELETED');
        const snapshots = [];
        for (const task of tasks) {
          const snapshot: Document = { task: State.taskView(task), revision: task.revision, snapshotAt: s.timestamp };
          for (const collection of ['task_rules','rounds','checkins','points_ledger','goal_claims']) {
            snapshot[collection] = (await s.tx.list(collection, { taskId: task._id })).map(doc => { const { ownerUserId, ...fields } = doc; return fields; });
          }
          snapshots.push(snapshot);
        }
        const data = { schemaVersion: 1, application: 'HabitLoop', generatedAt: s.timestamp, tasks: snapshots };
        if (Buffer.byteLength(JSON.stringify(data)) > 8 * 1024 * 1024) throw new Error('EXPORT_TOO_LARGE');
        job.snapshot = data; job.status = 'READY'; job.completedAt = s.timestamp;
      } catch { job.status = 'FAILED'; job.errorCode = 'EXPORT_TOO_LARGE'; }
      await s.tx.save('export_jobs', job);
    }
  }
  async deleteAccount(): Promise<Document> {
    const s = this.state;
    const response = { status: 'DELETING', jobId: s.id('delete') };
    await s.tx.clearOwner();
    s.tx.user.status = 'DELETING';
    s.tx.user.lastDeletion = { requestId: s.requestId, response, createdAt: s.timestamp };
    s.tx.user.deletedAt = s.timestamp;
    return response;
  }
}
