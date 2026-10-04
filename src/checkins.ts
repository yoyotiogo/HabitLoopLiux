import { BusinessError } from './errors';
import { Rules } from './rules';
import { State } from './state';
import { Document } from './types';

export class CheckinOperations {
  constructor(private state: State) {}
  async submit(payload: Document): Promise<Document> {
    const s = this.state, task = await s.task(payload.taskId, payload.expectedTaskRevision, true);
    const date = Rules.date(s.now, task.timezone), round = await s.round(task), rule = await s.rule(task);
    if (payload.businessDate !== date) throw new BusinessError('BUSINESS_DATE_CHANGED', '日期已变化，请刷新后重新打卡。', { businessDate: date });
    if (date < round.startDate || date < task.startDate || round.state === 'CLAIMED') throw new BusinessError('ROUND_CLOSED', '当前轮次尚未开始或已结束。');
    const id = s.stableId('chk', s.tx.user._id + '|' + task._id + '|' + date);
    const existing = await s.tx.get('checkins', id);
    if (existing && existing.outcome !== 'UNRECORDED') return this.submitResult(existing, await s.progress(task), false);
    const previous = existing?.previousStreakState || { lastOnTimeSuccessDate: task.lastOnTimeSuccessDate, streakAtLastSuccess: task.streakAtLastSuccess };
    const streak = payload.outcome === 'SUCCESS' ? (previous.lastOnTimeSuccessDate === Rules.addDays(date, -1) ? previous.streakAtLastSuccess + 1 : 1) : 0;
    const points = payload.outcome === 'SUCCESS' ? Rules.points(rule.config.score, streak) : 0;
    const record = { _id: id, taskId: task._id, roundId: round._id, ruleId: rule._id, businessDate: date, outcome: payload.outcome, source: 'ON_TIME', awardedPoints: points, streakAfter: streak, previousStreakState: previous, note: payload.note || '', revision: existing ? existing.revision + 1 : 1, createdAt: existing?.createdAt || s.timestamp, updatedAt: s.timestamp };
    if (points) await s.ledger(task, 'CHECKIN_AWARD', points, id, record.revision);
    task.lastOnTimeSuccessDate = payload.outcome === 'SUCCESS' ? date : null; task.streakAtLastSuccess = streak;
    await s.tx.save('checkins', record); await s.updateRound(task); await s.changed(task);
    return this.submitResult(record, await s.progress(task), true);
  }
  private submitResult(record: Document, progress: Document, applied: boolean): Document {
    return { checkinId: record._id, awardedPoints: applied ? record.awardedPoints : 0, balancePoints: progress.balancePoints, actualStreakDays: progress.actualStreakDays, goalProgress: progress.goalProgress, taskRevision: progress.taskRevision, applied };
  }
  async correct(payload: Document): Promise<Document> {
    const s = this.state, task = await s.task(payload.taskId, payload.expectedTaskRevision, true);
    const record = await s.tx.get('checkins', payload.checkinId), round = await s.round(task), rule = await s.rule(task);
    const date = Rules.date(s.now, task.timezone);
    if (!record || record.taskId !== task._id) throw new BusinessError('NOT_FOUND', '打卡记录不存在。');
    if (record.revision !== payload.expectedCheckinRevision) throw new BusinessError('VERSION_CONFLICT', '打卡记录已更新，请刷新。');
    if (record.businessDate !== date || record.roundId !== round._id || round.state === 'CLAIMED' || record.source !== 'ON_TIME') throw new BusinessError('CORRECTION_NOT_ALLOWED', '只允许纠正当天、尚未领取奖励的准时记录。');
    const oldPoints = record.awardedPoints;
    if (oldPoints) await s.ledger(task, 'CHECKIN_REVERSAL', -oldPoints, record._id, record.revision);
    const previous = record.previousStreakState;
    record.outcome = payload.outcome; record.note = payload.note || ''; record.revision++; record.updatedAt = s.timestamp;
    record.streakAfter = record.outcome === 'SUCCESS' ? (previous.lastOnTimeSuccessDate === Rules.addDays(date, -1) ? previous.streakAtLastSuccess + 1 : 1) : 0;
    record.awardedPoints = record.outcome === 'SUCCESS' ? Rules.points(rule.config.score, record.streakAfter) : 0;
    if (record.awardedPoints) await s.ledger(task, 'CHECKIN_AWARD', record.awardedPoints, record._id, record.revision);
    if (record.outcome === 'UNRECORDED') Object.assign(task, previous);
    else { task.lastOnTimeSuccessDate = record.outcome === 'SUCCESS' ? date : null; task.streakAtLastSuccess = record.streakAfter; }
    await s.tx.save('checkins', record); await s.updateRound(task); await s.changed(task);
    return { checkin: State.checkinView(record), progress: await s.progress(task), pointDelta: record.awardedPoints - oldPoints };
  }
  async backfill(payload: Document): Promise<Document> {
    const s = this.state, task = await s.task(payload.taskId, payload.expectedTaskRevision, true), round = await s.round(task), rule = await s.rule(task);
    const date = Rules.date(s.now, task.timezone), age = Rules.daysBetween(payload.businessDate, date);
    if (age < 1 || age > rule.config.backfillWindowDays || payload.businessDate < round.startDate || payload.businessDate < task.startDate || round.state === 'CLAIMED') throw new BusinessError('BACKFILL_NOT_ALLOWED', '该日期不在本轮允许的补卡范围内。');
    const id = s.stableId('chk', s.tx.user._id + '|' + task._id + '|' + payload.businessDate);
    if (await s.tx.get('checkins', id)) throw new BusinessError('ALREADY_CHECKED_IN', '该日期已经有记录。');
    const record = { _id: id, taskId: task._id, roundId: round._id, ruleId: rule._id, businessDate: payload.businessDate, outcome: 'SUCCESS', source: 'BACKFILL', awardedPoints: rule.config.score.basePoints, streakAfter: 0, previousStreakState: null, note: payload.note || '', revision: 1, createdAt: s.timestamp, updatedAt: s.timestamp };
    await s.ledger(task, 'CHECKIN_AWARD', record.awardedPoints, id, 1); await s.tx.save('checkins', record); await s.updateRound(task); await s.changed(task);
    return { checkin: State.checkinView(record), progress: await s.progress(task), awardedPoints: record.awardedPoints };
  }
}
