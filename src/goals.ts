import { BusinessError } from './errors';
import { Rules } from './rules';
import { State } from './state';
import { Document } from './types';

export class GoalOperations {
  constructor(private state: State) {}
  async claim(payload: Document): Promise<Document> {
    const s = this.state, task = await s.task(payload.taskId, payload.expectedTaskRevision, true), round = await s.round(task), rule = await s.rule(task);
    if (payload.roundId !== round._id || round.state === 'CLAIMED') throw new BusinessError('ROUND_CLOSED', '该轮次已结束，请刷新。');
    if (Rules.date(s.now, task.timezone) < round.startDate) throw new BusinessError('ROUND_NOT_STARTED', '新一轮从明天开始，请明天再确认奖励。');
    if (!Rules.goal(rule.config, task, round).ready) throw new BusinessError('GOAL_NOT_READY', '还未达成目标。');
    if (rule.config.reward.budgetCents !== null && payload.rewardRecord.amountCents !== null && payload.rewardRecord.amountCents > rule.config.reward.budgetCents) throw new BusinessError('REWARD_BUDGET_EXCEEDED', '奖励金额不能超过设定预算。');
    const claimId = s.stableId('clm', round._id);
    if (await s.tx.get('goal_claims', claimId)) throw new BusinessError('ALREADY_CLAIMED', '该轮奖励已经确认。');
    const date = Rules.date(s.now, task.timezone), debit = rule.config.goal.type === 'POINTS_BALANCE' ? rule.config.goal.target : 0;
    if (debit) await s.ledger(task, 'GOAL_DEBIT', -debit, claimId, 1);
    round.state = 'CLAIMED'; round.endDate = date; round.revision++; round.updatedAt = s.timestamp; await s.tx.save('rounds', round);
    let nextRound = null;
    if (rule.config.completionMode === 'REPEAT') {
      task.currentRuleId = task.pendingRuleId || task.currentRuleId; task.pendingRuleId = null;
      nextRound = s.newRound(task._id, task.currentRuleId, round.sequence + 1, Rules.addDays(date, 1));
      await s.tx.save('rounds', nextRound); task.activeRoundId = nextRound._id;
    } else task.status = 'ARCHIVED';
    const claim = { _id: claimId, taskId: task._id, roundId: round._id, goalSnapshot: rule.config.goal, rewardSnapshot: rule.config.reward, debitedPoints: debit, balanceAfter: task.balancePoints, rewardRecord: payload.rewardRecord, claimedBusinessDate: date, nextRoundId: nextRound?._id || null, createdAt: s.timestamp };
    await s.tx.save('goal_claims', claim); await s.changed(task);
    return { claim: State.claimView(claim), task: State.taskView(task), nextRound: State.roundView(nextRound, date), balancePoints: task.balancePoints };
  }
}
