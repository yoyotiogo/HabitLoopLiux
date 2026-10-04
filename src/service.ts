import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BusinessError } from './errors';
import { CheckinOperations } from './checkins';
import { GoalOperations } from './goals';
import { TaskOperations } from './tasks';
import { PersonalOperations } from './personal';
import { Pagination } from './pagination';
import { Rules } from './rules';
import { State } from './state';
import { Command, Document, Identity, Repository } from './types';
import { MemoryRepository } from './repository';

export class HabitService {
  private validate;
  private queries = new Set(['session.bootstrap','task.list','task.get','checkin.list','ledger.list','claim.list','export.get']);
  constructor(private repository: Repository, private clock = () => new Date(), private baseUrl = 'https://express-4jhq-323197-8-1500194038.sh.run.tcloudbase.com') {
    const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
    ajv.addSchema(JSON.parse(readFileSync(resolve(__dirname, '../collections.schema.json'), 'utf8').replace(/^\uFEFF/, '')));
    this.validate = ajv.compile(JSON.parse(readFileSync(resolve(__dirname, '../protocol.schema.json'), 'utf8').replace(/^\uFEFF/, '')));
  }
  async execute(identity: Identity, request: Command): Promise<any> {
    const now = this.clock(), requestId = typeof request?.requestId === 'string' ? request.requestId : randomUUID();
    try {
      if (!identity?.appId || !identity?.openId) throw new BusinessError('UNAUTHORIZED', '请从微信小程序进入。');
      if (!this.validate(request)) throw new BusinessError('INVALID_ARGUMENT', '请求参数不符合接口约定。');
      return await this.repository.withUser(identity, async tx => {
        const s = new State(tx, now, requestId);
        if (request.action === 'account.delete' && tx.user.lastDeletion?.requestId === requestId) return this.success(requestId, now, tx.user.lastDeletion.response, true);
        if (tx.user.status === 'DELETING') {
          if (request.action !== 'session.bootstrap') throw new BusinessError('ACCOUNT_DELETING', '账号数据已清理，请重新进入小程序。');
          const deletion = tx.user.lastDeletion;
          Object.assign(tx.user, MemoryRepository.newUser(identity), { lastDeletion: deletion });
        }
        const receiptId = s.stableId('cmd', tx.user._id + '|' + request.action + '|' + requestId);
        const command = !this.queries.has(request.action), payloadHash = Pagination.fingerprint(request.payload);
        if (command) {
          const receipt = await tx.get('command_receipts', receiptId);
          if (receipt) {
            if (receipt.payloadHash !== payloadHash) throw new BusinessError('IDEMPOTENCY_CONFLICT', '相同请求编号不能用于不同操作内容。');
            return this.success(requestId, now, receipt.responseData, true);
          }
        }
        const data = await this.dispatch(s, request);
        if (command && request.action !== 'account.delete') {
          await tx.save('command_receipts', { _id: receiptId, action: request.action, requestId, payloadHash, responseData: data, createdAt: s.timestamp });
          await tx.save('outbox_events', { _id: s.id('evt'), taskId: request.payload.taskId || data.task?._id || null, type: request.action, status: 'APPLIED', createdAt: s.timestamp });
        }
        return this.success(requestId, now, data, false);
      });
    } catch (error) {
      if (!(error instanceof BusinessError)) console.error('habitloop_request_failed', requestId, (error as any)?.code || 'INTERNAL_ERROR');
      const failure = error instanceof BusinessError ? error : new BusinessError('INTERNAL_ERROR', '服务暂时不可用，请稍后用原请求重试。', {}, true);
      return { ok: false, code: failure.code, requestId, serverTime: now.toISOString(), error: { message: failure.message, details: failure.details, retryable: failure.retryable } };
    }
  }
  private success(requestId: string, now: Date, data: Document, replayed: boolean): Document { return { ok: true, code: 'OK', requestId, serverTime: now.toISOString(), data, meta: { replayed } }; }
  private async dispatch(s: State, request: Command): Promise<Document> {
    const p = request.payload, tasks = new TaskOperations(s), checkins = new CheckinOperations(s), goals = new GoalOperations(s), personal = new PersonalOperations(s, this.baseUrl);
    switch (request.action) {
      case 'session.bootstrap': return { user: { userId: s.tx.user._id, status: s.tx.user.status, defaultTimezone: s.tx.user.defaultTimezone }, businessDate: Rules.date(s.now), templateVersion: 1 };
      case 'task.create': return tasks.create(p);
      case 'task.get': return s.detail(await s.task(p.taskId));
      case 'task.updateMetadata': return tasks.metadata(p);
      case 'task.scheduleRule': return tasks.scheduleRule(p);
      case 'task.setStatus': return tasks.status(p);
      case 'task.delete': return tasks.delete(p);
      case 'reminder.update': return tasks.reminder(p);
      case 'checkin.submit': return checkins.submit(p);
      case 'checkin.correct': return checkins.correct(p);
      case 'checkin.backfill': return checkins.backfill(p);
      case 'goal.claim': return goals.claim(p);
      case 'export.request': return personal.requestExport();
      case 'export.get': return personal.getExport(p);
      case 'account.delete': return personal.deleteAccount();
      case 'task.list': case 'checkin.list': case 'ledger.list': case 'claim.list': return this.list(s, request);
      default: throw new BusinessError('UNKNOWN_ACTION', '不支持该操作。');
    }
  }
  private async list(s: State, request: Command): Promise<Document> {
    const p = request.payload, pagination = new Pagination(this.repository.signingKey);
    const binding = pagination.binding(s.tx.user._id, request.action, p), after = pagination.decode(p.cursor, binding), limit = p.limit || 20;
    let collection: string, filters: Document, from: string | undefined, to: string | undefined;
    if (request.action === 'task.list') { collection = 'tasks'; filters = p.status ? { status: p.status } : {}; }
    else {
      await s.task(p.taskId); filters = { taskId: p.taskId };
      collection = request.action === 'checkin.list' ? 'checkins' : request.action === 'ledger.list' ? 'points_ledger' : 'goal_claims';
      if (collection === 'checkins') {
        if (Rules.daysBetween(p.dateFrom, p.dateTo) < 0 || Rules.daysBetween(p.dateFrom, p.dateTo) > 92) throw new BusinessError('INVALID_ARGUMENT', '日历查询最多 93 天。');
        from = p.dateFrom; to = p.dateTo;
      }
    }
    let docs = await s.tx.list(collection, filters, { limit: limit + 1, after, from, to });
    if (collection === 'tasks') docs = docs.filter(doc => doc.status !== 'DELETED');
    const more = docs.length > limit; docs = docs.slice(0, limit);
    const items = [];
    for (const doc of docs) items.push(collection === 'tasks' ? { task: State.taskView(doc), progress: await s.progress(doc) } : collection === 'checkins' ? State.checkinView(doc) : collection === 'points_ledger' ? State.ledgerView(doc) : State.claimView(doc));
    return { items, nextCursor: more && docs.length ? pagination.encode(binding, docs[docs.length - 1]) : null };
  }
  async maintenance(): Promise<void> {
    const now = this.clock();
    for (const identity of await this.repository.pendingExports()) await this.repository.withUser(identity, tx => new PersonalOperations(new State(tx, now, 'maintenance'), this.baseUrl).processExports());
    await this.repository.cleanup(now);
  }
}
