import { createHash, randomUUID } from 'node:crypto';
import { BusinessError } from './errors';
import { Rules } from './rules';
import { Document, Transaction } from './types';

export class State {
  constructor(public tx: Transaction, public now: Date, public requestId: string) {}
  get timestamp(): string { return this.now.toISOString(); }
  id(prefix: string): string { return prefix + '_' + randomUUID(); }
  stableId(prefix: string, key: string): string { return prefix + '_' + createHash('sha256').update(key).digest('hex').slice(0, 48); }
  static pick(document: Document, fields: string[]): Document { return Object.fromEntries(fields.map(field => [field, document[field] ?? null])); }
  static taskView(task: Document): Document { return State.pick(task, ['_id','title','description','icon','timezone','startDate','status','activeRoundId','currentRuleId','pendingRuleId','balancePoints','revision','reminder','deletedAt']); }
  static ruleView(rule: Document): Document { return State.pick(rule, ['_id','version','config']); }
  static roundView(round: Document | null, today: string): Document | null {
    if (!round) return null;
    const view = State.pick(round, ['_id','sequence','ruleId','startDate','endDate','state','successCount','currentGoalStreak','maxGoalStreak','revision']);
    if (round.lastGoalSuccessDate && Rules.daysBetween(round.lastGoalSuccessDate, today) > 1) view.currentGoalStreak = 0;
    return view;
  }
  static checkinView(checkin: Document): Document { return { checkinId: checkin._id, ...State.pick(checkin, ['businessDate','outcome','source','awardedPoints','streakAfter','note','revision']) }; }
  static claimView(claim: Document): Document { return { claimId: claim._id, ...State.pick(claim, ['taskId','roundId','goalSnapshot','rewardSnapshot','debitedPoints','balanceAfter','rewardRecord','claimedBusinessDate','nextRoundId']) }; }
  static ledgerView(ledger: Document): Document { return { ledgerId: ledger._id, ...State.pick(ledger, ['kind','delta','balanceAfter','sourceId','createdAt']) }; }
  async task(taskId: string, revision?: number, editable = false): Promise<Document> {
    const task = await this.tx.get('tasks', taskId);
    if (!task || task.status === 'DELETED') throw new BusinessError('NOT_FOUND', '任务不存在或已删除。');
    if (revision !== undefined && revision !== task.revision) throw new BusinessError('VERSION_CONFLICT', '任务已更新，请刷新后再操作。', { latestTaskRevision: task.revision });
    if (editable && task.status !== 'ACTIVE') throw new BusinessError('TASK_INACTIVE', '请先恢复任务，再进行打卡或兑换。');
    return task;
  }
  async rule(task: Document): Promise<Document> { return (await this.tx.get('task_rules', task.currentRuleId))!; }
  async round(task: Document): Promise<Document> { return (await this.tx.get('rounds', task.activeRoundId))!; }
  async progress(task: Document): Promise<Document> {
    const date = Rules.date(this.now, task.timezone), round = await this.round(task), rule = await this.rule(task);
    const todayId = this.stableId('chk', this.tx.user._id + '|' + task._id + '|' + date);
    const today = await this.tx.get('checkins', todayId);
    const actual = Rules.actualStreak(task, date);
    const prospective = task.lastOnTimeSuccessDate === date ? actual : (task.lastOnTimeSuccessDate === Rules.addDays(date, -1) ? actual + 1 : 1);
    const goalProgress = Rules.goal(rule.config, task, round);
    return { businessDate: date, balancePoints: task.balancePoints, actualStreakDays: actual, todayPotentialPoints: Rules.points(rule.config.score, prospective), todayOutcome: today?.outcome || 'UNRECORDED', goalProgress, taskRevision: task.revision,
      canCheckin: task.status === 'ACTIVE' && round.state !== 'CLAIMED' && date >= round.startDate && date >= task.startDate && (!today || today.outcome === 'UNRECORDED') };
  }
  async detail(task: Document): Promise<Document> {
    const progress = await this.progress(task), rule = await this.rule(task), round = await this.round(task);
    const today = await this.tx.get('checkins', this.stableId('chk', this.tx.user._id + '|' + task._id + '|' + progress.businessDate));
    return { task: State.taskView(task), rule: State.ruleView(rule), round: State.roundView(round, progress.businessDate), today: today ? State.checkinView(today) : null, progress };
  }
  async changed(task: Document): Promise<void> { task.revision++; task.updatedAt = this.timestamp; await this.tx.save('tasks', task); }
  async ledger(task: Document, kind: string, delta: number, sourceId: string, sourceRevision: number): Promise<void> {
    if (!Number.isSafeInteger(task.balancePoints + delta) || task.balancePoints + delta < 0) throw new BusinessError('INSUFFICIENT_POINTS', '积分余额不足。');
    task.balancePoints += delta;
    await this.tx.save('points_ledger', { _id: this.id('led'), taskId: task._id, kind, delta, balanceAfter: task.balancePoints, sourceId, sourceRevision, commandId: this.requestId, createdAt: this.timestamp });
  }
  async updateRound(task: Document): Promise<void> {
    const round = await this.round(task), rule = await this.rule(task);
    const records = (await this.tx.list('checkins', { taskId: task._id, roundId: round._id })).sort((a,b) => a.businessDate.localeCompare(b.businessDate));
    let count = 0, streak = 0, max = 0, previous: string | null = null;
    for (const record of records) {
      if (record.outcome === 'SUCCESS') count++;
      if (record.source !== 'ON_TIME') continue;
      if (record.outcome !== 'SUCCESS') { streak = 0; previous = null; continue; }
      streak = previous === Rules.addDays(record.businessDate, -1) ? streak + 1 : 1;
      previous = record.businessDate; max = Math.max(max, streak);
    }
    round.successCount = count; round.currentGoalStreak = streak; round.maxGoalStreak = max; round.lastGoalSuccessDate = previous;
    const ready = Rules.goal(rule.config, task, round).ready;
    round.state = ready ? 'READY' : 'OPEN'; round.readyAt = ready ? round.readyAt || this.timestamp : null;
    round.revision++; round.updatedAt = this.timestamp;
    await this.tx.save('rounds', round);
  }
  newRound(taskId: string, ruleId: string, sequence: number, startDate: string): Document {
    return { _id: this.id('rnd'), taskId, ruleId, sequence, startDate, endDate: null, state: 'OPEN', successCount: 0, currentGoalStreak: 0, maxGoalStreak: 0, lastGoalSuccessDate: null, readyAt: null, revision: 1, createdAt: this.timestamp, updatedAt: this.timestamp };
  }
}
