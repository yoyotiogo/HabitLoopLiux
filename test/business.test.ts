import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { HabitService } from '../src/service';
import { MemoryRepository } from '../src/repository';
import { Rules } from '../src/rules';

const rule = { score: { type: 'STREAK_STEP', basePoints: 10, stepEveryDays: 7, stepPoints: 1, maxPoints: 15 }, goal: { type: 'POINTS_BALANCE', target: 450 }, completionMode: 'REPEAT', reward: { description: '奖励自己', budgetCents: 50000, currency: 'CNY' }, backfillWindowDays: 7 };
const alice = { appId: 'wx_test', openId: 'alice' };
const bob = { appId: 'wx_test', openId: 'bob' };
function fixture() {
  let now = new Date('2026-10-01T12:00:00.000Z');
  const repo = new MemoryRepository();
  const service = new HabitService(repo, () => now);
  const invoke = (action: string, payload: any = {}, who = alice, requestId = randomUUID()) => service.execute(who, { protocolVersion: 1, action, requestId, payload });
  return { repo, service, invoke, day: (day: number) => { now = new Date(Date.UTC(2026, 9, day, 12)); }, date: () => now.toISOString().slice(0, 10) };
}
async function create(f: ReturnType<typeof fixture>, config = rule) {
  const response = await f.invoke('task.create', { title: '不购买额外吃食', description: '', icon: 'leaf', timezone: 'Asia/Shanghai', startDate: f.date(), rule: config });
  assert.equal(response.ok, true, JSON.stringify(response));
  return response.data.task;
}
async function submit(f: ReturnType<typeof fixture>, task: any, outcome = 'SUCCESS', requestId = randomUUID()) {
  const response = await f.invoke('checkin.submit', { taskId: task._id, expectedTaskRevision: task.revision, businessDate: f.date(), outcome, note: '' }, alice, requestId);
  if (response.ok) task.revision = response.data.taskRevision;
  return response;
}
test('weekly score boundaries and cap', () => {
  assert.deepEqual([6, 7, 14, 35, 70].map(day => Rules.points(rule.score, day)), [10, 11, 12, 15, 15]);
});
test('business dates use task timezone across local midnight', () => {
  assert.equal(Rules.date(new Date('2026-10-04T15:59:59Z'),'Asia/Shanghai'),'2026-10-04');
  assert.equal(Rules.date(new Date('2026-10-04T16:00:00Z'),'Asia/Shanghai'),'2026-10-05');
  assert.equal(Rules.date(new Date('2026-10-04T16:00:00Z'),'America/New_York'),'2026-10-04');
});
test('backfill can be disabled and longest streak goal survives later missed dates', async () => {
  const f=fixture(), config=structuredClone(rule);config.backfillWindowDays=0;config.goal={type:'CONSECUTIVE_DAYS',target:2};
  const task=await create(f,config);await submit(f,task);f.day(2);await submit(f,task);f.day(4);
  const detail=await f.invoke('task.get',{taskId:task._id});
  assert.equal(detail.data.progress.actualStreakDays,0);assert.equal(detail.data.progress.goalProgress.ready,true);
  const backfill=await f.invoke('checkin.backfill',{taskId:task._id,expectedTaskRevision:task.revision,businessDate:'2026-10-03',note:''});
  assert.equal(backfill.code,'BACKFILL_NOT_ALLOWED');
});
test('37 daily successes reach 455; claiming deducts 450 and preserves actual streak', async () => {
  const f = fixture(); const task = await create(f);
  for (let day = 1; day <= 37; day++) { f.day(day); assert.equal((await submit(f, task)).ok, true); }
  const detail = await f.invoke('task.get', { taskId: task._id });
  assert.equal(detail.data.progress.balancePoints, 455);
  const claim = await f.invoke('goal.claim', { taskId: task._id, roundId: detail.data.round._id, expectedTaskRevision: task.revision, rewardRecord: { amountCents: 39900, note: '' } });
  assert.equal(claim.ok, true); assert.equal(claim.data.balancePoints, 5);
  assert.equal(claim.data.nextRound.startDate, '2026-11-07');
  f.day(38); task.revision = claim.data.task.revision;
  const next = await submit(f, task); assert.equal(next.data.awardedPoints, 15); assert.equal(next.data.actualStreakDays, 38);
});
test('same request replay and new request on same date never award twice', async () => {
  const f = fixture(); const task = await create(f); const id = randomUUID();
  const payload = { taskId: task._id, expectedTaskRevision: task.revision, businessDate: f.date(), outcome: 'SUCCESS', note: '' };
  const first = await f.invoke('checkin.submit', payload, alice, id);
  const replay = await f.invoke('checkin.submit', payload, alice, id);
  assert.equal(replay.meta.replayed, true); assert.equal(replay.data.balancePoints, 10);
  const duplicate = await f.invoke('checkin.submit', { ...payload, expectedTaskRevision: first.data.taskRevision });
  assert.equal(duplicate.data.applied, false);
  assert.equal(duplicate.data.balancePoints, 10);
  const changed = await f.invoke('checkin.submit', { ...payload, note: 'changed' }, alice, id);
  assert.equal(changed.code, 'IDEMPOTENCY_CONFLICT');
});
test('concurrent submissions serialize and produce a single ledger award', async () => {
  const f = fixture(); const task = await create(f);
  await Promise.all([submit(f, task), submit(f, task)]);
  const ledger = await f.invoke('ledger.list', { taskId: task._id, limit: 50, cursor: null });
  assert.equal(ledger.data.items.length, 1);
});
test('missed date keeps balance and resets the score tier', async () => {
  const f = fixture(); const task = await create(f);
  for (let day = 1; day <= 7; day++) { f.day(day); await submit(f, task); }
  f.day(9); const next = await submit(f, task);
  assert.equal(next.data.awardedPoints, 10); assert.equal(next.data.actualStreakDays, 1); assert.equal(next.data.balancePoints, 81);
});
test('same-day correction reverses original award and can be restored without inflation', async () => {
  const f = fixture(); const task = await create(f); const success = await submit(f, task);
  const corrected = await f.invoke('checkin.correct', { taskId: task._id, expectedTaskRevision: task.revision, checkinId: success.data.checkinId, expectedCheckinRevision: 1, outcome: 'UNRECORDED', note: '' });
  assert.equal(corrected.ok, true); assert.equal(corrected.data.pointDelta, -10); assert.equal(corrected.data.progress.balancePoints, 0);
  const restored = await f.invoke('checkin.correct', { taskId: task._id, expectedTaskRevision: corrected.data.progress.taskRevision, checkinId: success.data.checkinId, expectedCheckinRevision: 2, outcome: 'SUCCESS', note: '' });
  assert.equal(restored.data.progress.balancePoints, 10);
});
test('backfill is base-only, cannot repair streak, and rejects future and expired dates', async () => {
  const f = fixture(); const task = await create(f); await submit(f, task); f.day(3); await submit(f, task);
  const backfill = await f.invoke('checkin.backfill', { taskId: task._id, expectedTaskRevision: task.revision, businessDate: '2026-10-02', note: '' });
  assert.equal(backfill.data.awardedPoints, 10); assert.equal(backfill.data.progress.actualStreakDays, 1);
  const future = await f.invoke('checkin.backfill', { taskId: task._id, expectedTaskRevision: backfill.data.progress.taskRevision, businessDate: '2026-10-04', note: '' });
  assert.equal(future.ok, false);
});
test('other users cannot read or mutate tasks', async () => {
  const f = fixture(); const task = await create(f);
  assert.equal((await f.invoke('task.get', { taskId: task._id }, bob)).code, 'NOT_FOUND');
  assert.equal((await f.invoke('task.list', { status: 'ACTIVE', limit: 20, cursor: null }, bob)).data.items.length, 0);
});
test('rule changes apply next round; excessive reward budget rolls back', async () => {
  const f = fixture(); const config = structuredClone(rule); config.goal.target = 10;
  const task = await create(f, config); await submit(f, task);
  const nextRule = structuredClone(config); nextRule.score.basePoints = 20; nextRule.score.maxPoints = 25;
  const scheduled = await f.invoke('task.scheduleRule', { taskId: task._id, expectedTaskRevision: task.revision, rule: nextRule });
  const detail = await f.invoke('task.get', { taskId: task._id });
  assert.equal(detail.data.rule.config.score.basePoints, 10);
  const payload = { taskId: task._id, roundId: detail.data.round._id, expectedTaskRevision: scheduled.data.taskRevision, rewardRecord: { amountCents: 50001, note: '' } };
  assert.equal((await f.invoke('goal.claim', payload)).ok, false);
  assert.equal((await f.invoke('task.get', { taskId: task._id })).data.progress.balancePoints, 10);
  const claim = await f.invoke('goal.claim', { ...payload, rewardRecord: { amountCents: 0, note: '' } });
  assert.equal(claim.data.task.currentRuleId, scheduled.data.pendingRuleId);
});
test('counts and streak targets do not debit points; once-only tasks archive', async () => {
  for (const goalType of ['SUCCESS_COUNT', 'CONSECUTIVE_DAYS']) {
    const f = fixture(); const config = structuredClone(rule); config.goal = { type: goalType, target: 1 }; config.completionMode = 'ONCE';
    const task = await create(f, config); await submit(f, task);
    const claim = await f.invoke('goal.claim', { taskId: task._id, roundId: task.activeRoundId, expectedTaskRevision: task.revision, rewardRecord: { amountCents: 0, note: '' } });
    assert.equal(claim.data.balancePoints, 10); assert.equal(claim.data.task.status, 'ARCHIVED'); assert.equal(claim.data.nextRound, null);
  }
});
test('invalid rule, injected identity, stale version and wrong business date are rejected', async () => {
  const f = fixture(); const task = await create(f);
  const injected = await f.invoke('checkin.submit', { taskId: task._id, expectedTaskRevision: task.revision, businessDate: f.date(), outcome: 'SUCCESS', note: '', awardedPoints: 1000 });
  assert.equal(injected.code, 'INVALID_ARGUMENT');
  const stale = await f.invoke('checkin.submit', { taskId: task._id, expectedTaskRevision: 999, businessDate: f.date(), outcome: 'SUCCESS', note: '' });
  assert.equal(stale.code, 'VERSION_CONFLICT');
  const wrongDate = await f.invoke('checkin.submit', { taskId: task._id, expectedTaskRevision: task.revision, businessDate: '2026-10-02', outcome: 'SUCCESS', note: '' });
  assert.equal(wrongDate.code, 'BUSINESS_DATE_CHANGED');
});
test('next round cannot be claimed until tomorrow even when surplus already meets target', async () => {
  const f = fixture(); const config = structuredClone(rule); config.goal.target = 1;
  const task = await create(f, config); await submit(f, task);
  const first = await f.invoke('goal.claim', { taskId: task._id, roundId: task.activeRoundId, expectedTaskRevision: task.revision, rewardRecord: { amountCents: 0, note: '' } });
  const second = await f.invoke('goal.claim', { taskId: task._id, roundId: first.data.nextRound._id, expectedTaskRevision: first.data.task.revision, rewardRecord: { amountCents: 0, note: '' } });
  assert.equal(second.ok, false); assert.equal(second.code, 'ROUND_NOT_STARTED');
});
test('pausing, deleting and signed pagination enforce task visibility', async () => {
  const f = fixture(); const task = await create(f);
  const pause = await f.invoke('task.setStatus', { taskId: task._id, expectedTaskRevision: task.revision, status: 'PAUSED' });
  task.revision = pause.data.task.revision;
  assert.equal((await submit(f, task)).code, 'TASK_INACTIVE');
  await f.invoke('task.delete', { taskId: task._id, expectedTaskRevision: task.revision });
  assert.equal((await f.invoke('task.get', { taskId: task._id })).code, 'NOT_FOUND');
});
test('export is private and account deletion removes history and changes internal user id', async () => {
  const f = fixture(); const before = await f.invoke('session.bootstrap'); const task = await create(f); await submit(f, task);
  const job = await f.invoke('export.request', { format: 'JSON' });
  assert.equal(job.data.status, 'PENDING'); await f.service.maintenance();
  const exported = await f.invoke('export.get', { jobId: job.data.jobId });
  assert.equal(exported.data.status, 'READY');
  const url = new URL(exported.data.downloadUrl);
  assert.equal(await f.repo.exportDownload(job.data.jobId, 'wrong-token', new Date('2026-10-01T12:00:00Z')), null);
  const downloaded = await f.repo.exportDownload(job.data.jobId, url.searchParams.get('token')!, new Date('2026-10-01T12:00:00Z'));
  assert.equal(downloaded!.tasks.length, 1); assert.equal(JSON.stringify(downloaded).includes('alice'), false);
  const deletionId = randomUUID(); const deletion = await f.invoke('account.delete', { confirmation: 'DELETE' }, alice, deletionId);
  assert.equal(deletion.data.status, 'DELETING');
  const after = await f.invoke('session.bootstrap'); assert.notEqual(after.data.user.userId, before.data.user.userId);
  assert.equal((await f.invoke('task.list', { status: 'ACTIVE', limit: 20, cursor: null })).data.items.length, 0);
  const replay = await f.invoke('account.delete', { confirmation: 'DELETE' }, alice, deletionId);
  assert.equal(replay.meta.replayed, true);
});
