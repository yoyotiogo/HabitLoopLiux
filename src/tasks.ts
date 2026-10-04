import { BusinessError } from './errors';
import { Rules } from './rules';
import { State } from './state';
import { Document } from './types';

export class TaskOperations {
  constructor(private state: State) {}
  async create(payload: Document): Promise<Document> {
    const s = this.state; Rules.validate(payload.rule); Rules.date(s.now, payload.timezone);
    const tasks = await s.tx.list('tasks');
    if (tasks.filter(task => task.status !== 'DELETED').length >= 100) throw new BusinessError('TASK_LIMIT', '最多管理 100 个任务。');
    const taskId = s.id('tsk'), ruleId = s.id('rul');
    const rule = { _id: ruleId, taskId, version: 1, config: payload.rule, createdAt: s.timestamp };
    const round = s.newRound(taskId, ruleId, 1, payload.startDate);
    const task = { _id: taskId, title: payload.title.trim(), description: payload.description || '', icon: payload.icon || 'leaf', timezone: payload.timezone, startDate: payload.startDate, status: 'ACTIVE', activeRoundId: round._id, currentRuleId: ruleId, pendingRuleId: null,
      balancePoints: 0, lastOnTimeSuccessDate: null, streakAtLastSuccess: 0, reminder: { enabled: false, localTime: '21:00' }, revision: 1, deletedAt: null, createdAt: s.timestamp, updatedAt: s.timestamp };
    if (!task.title) throw new BusinessError('INVALID_ARGUMENT', '请输入任务名称。');
    await s.tx.save('tasks', task); await s.tx.save('task_rules', rule); await s.tx.save('rounds', round);
    return s.detail(task);
  }
  async metadata(payload: Document): Promise<Document> {
    const s = this.state, task = await s.task(payload.taskId, payload.expectedTaskRevision);
    if (!payload.title.trim()) throw new BusinessError('INVALID_ARGUMENT', '请输入任务名称。');
    task.title = payload.title.trim(); task.description = payload.description; task.icon = payload.icon;
    await s.changed(task); return { task: State.taskView(task) };
  }
  async scheduleRule(payload: Document): Promise<Document> {
    const s = this.state, task = await s.task(payload.taskId, payload.expectedTaskRevision); Rules.validate(payload.rule);
    if (task.status === 'ARCHIVED') throw new BusinessError('TASK_INACTIVE', '已结束的任务不能修改下一轮规则。');
    const rules = await s.tx.list('task_rules', { taskId: task._id });
    const rule = { _id: s.id('rul'), taskId: task._id, version: Math.max(...rules.map(rule => rule.version)) + 1, config: payload.rule, createdAt: s.timestamp };
    task.pendingRuleId = rule._id; await s.tx.save('task_rules', rule); await s.changed(task);
    return { pendingRuleId: rule._id, version: rule.version, effectiveFrom: 'NEXT_ROUND', taskRevision: task.revision };
  }
  async status(payload: Document): Promise<Document> {
    const s = this.state, task = await s.task(payload.taskId, payload.expectedTaskRevision);
    if (task.status === 'ARCHIVED' && (await s.round(task)).state === 'CLAIMED') throw new BusinessError('TASK_INACTIVE', '单次任务已完成，请创建新任务。');
    task.status = payload.status; await s.changed(task); return { task: State.taskView(task) };
  }
  async reminder(payload: Document): Promise<Document> {
    const s = this.state, task = await s.task(payload.taskId, payload.expectedTaskRevision);
    task.reminder = { enabled: payload.enabled, localTime: payload.localTime };
    await s.changed(task); return { task: State.taskView(task) };
  }
  async delete(payload: Document): Promise<Document> {
    const s = this.state, task = await s.task(payload.taskId, payload.expectedTaskRevision);
    task.status = 'DELETED'; task.deletedAt = s.timestamp; await s.changed(task); return { task: State.taskView(task) };
  }
}
