import { BusinessError } from './errors';
import { Document } from './types';

export class Rules {
  static points(score: Document, streak: number): number {
    if (score.type === 'FIXED') return score.basePoints;
    return Math.min(score.maxPoints, score.basePoints + Math.floor(streak / score.stepEveryDays) * score.stepPoints);
  }
  static validate(config: Document): void {
    if (config.score.type === 'STREAK_STEP' && config.score.maxPoints < config.score.basePoints) throw new BusinessError('INVALID_RULE', '封顶积分不能低于每日基础积分。');
  }
  static date(now: Date, timezone = 'Asia/Shanghai'): string {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
      return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
    } catch { throw new BusinessError('INVALID_ARGUMENT', '不支持该时区。'); }
  }
  static addDays(date: string, days: number): string { return new Date(Date.parse(date + 'T00:00:00.000Z') + days * 86400000).toISOString().slice(0, 10); }
  static daysBetween(from: string, to: string): number { return (Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000; }
  static actualStreak(task: Document, date: string): number {
    return task.lastOnTimeSuccessDate && Rules.daysBetween(task.lastOnTimeSuccessDate, date) <= 1 ? task.streakAtLastSuccess : 0;
  }
  static goal(config: Document, task: Document, round: Document): Document {
    const type = config.goal.type;
    const current = type === 'POINTS_BALANCE' ? task.balancePoints : type === 'SUCCESS_COUNT' ? round.successCount : round.maxGoalStreak;
    return { type, current, target: config.goal.target, ready: current >= config.goal.target };
  }
}
