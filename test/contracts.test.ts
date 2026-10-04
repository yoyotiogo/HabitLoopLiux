import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { HabitService } from '../src/service';
import { MemoryRepository } from '../src/repository';
const alice = { appId: 'wx_test', openId: 'contract_alice' };
const rule = { score: { type: 'FIXED', basePoints: 10 }, goal: { type: 'POINTS_BALANCE', target: 20 }, completionMode: 'REPEAT', reward: { description: '', budgetCents: 50000, currency: 'CNY' }, backfillWindowDays: 7 };
test('all 19 operations return the approved response DTOs', async () => {
  const ajv = new Ajv({ strict: false, allErrors: true }); addFormats(ajv);
  ajv.addSchema(JSON.parse(readFileSync('collections.schema.json','utf8').replace(/^\uFEFF/,'')));
  const schema = JSON.parse(readFileSync('responses.schema.json','utf8').replace(/^\uFEFF/,'')); ajv.addSchema(schema);
  const repo = new MemoryRepository(), service = new HabitService(repo, () => new Date('2026-10-04T12:00:00Z'));
  const actionTypes: Record<string,string> = { 'session.bootstrap':'BootstrapResult','task.create':'TaskDetailResult','task.get':'TaskDetailResult','task.updateMetadata':'TaskResult','task.scheduleRule':'RuleScheduleResult','task.setStatus':'TaskResult','task.delete':'TaskResult','task.list':'TaskListResult','checkin.submit':'CheckinSubmitResult','checkin.correct':'CheckinCorrectResult','checkin.backfill':'CheckinBackfillResult','checkin.list':'CheckinListResult','ledger.list':'LedgerListResult','claim.list':'ClaimListResult','goal.claim':'GoalClaimResult','reminder.update':'TaskResult','export.request':'ExportRequestResult','export.get':'ExportGetResult','account.delete':'AccountDeleteResult' };
  const seen = new Set();
  const invoke = async (action:string, payload:any = {}) => {
    const response = await service.execute(alice,{ protocolVersion:1, action, requestId:randomUUID(),payload });
    assert.equal(response.ok,true,JSON.stringify(response));
    const validator = ajv.compile({ $ref:schema.$id + '#/$defs/' + actionTypes[action] });
    assert.equal(validator(response.data),true,action + ': ' + JSON.stringify(validator.errors)); seen.add(action); return response.data;
  };
  await invoke('session.bootstrap');
  let detail = await invoke('task.create',{ title:'契约验证',description:'',icon:'leaf',timezone:'Asia/Shanghai',startDate:'2026-10-01',rule });
  const taskId = detail.task._id;
  await invoke('task.updateMetadata',{ taskId,expectedTaskRevision:detail.task.revision,title:'新名称',description:'新说明',icon:'book' });
  detail = await invoke('task.get',{taskId});
  await invoke('reminder.update',{taskId,expectedTaskRevision:detail.task.revision,enabled:true,localTime:'21:00'});
  detail = await invoke('task.get',{taskId});
  await invoke('task.scheduleRule',{taskId,expectedTaskRevision:detail.task.revision,rule});
  detail = await invoke('task.get',{taskId});
  const submission = await invoke('checkin.submit',{taskId,expectedTaskRevision:detail.task.revision,businessDate:'2026-10-04',outcome:'SUCCESS',note:''});
  const corrected = await invoke('checkin.correct',{taskId,expectedTaskRevision:submission.taskRevision,checkinId:submission.checkinId,expectedCheckinRevision:1,outcome:'SUCCESS',note:'确认'});
  await invoke('checkin.backfill',{taskId,expectedTaskRevision:corrected.progress.taskRevision,businessDate:'2026-10-03',note:''});
  await invoke('checkin.list',{taskId,dateFrom:'2026-10-01',dateTo:'2026-10-31',limit:50,cursor:null});
  await invoke('ledger.list',{taskId,limit:50,cursor:null});
  await invoke('task.list',{status:'ACTIVE',limit:50,cursor:null});
  detail = await invoke('task.get',{taskId});
  await invoke('goal.claim',{taskId,roundId:detail.round._id,expectedTaskRevision:detail.task.revision,rewardRecord:{amountCents:null,note:''}});
  await invoke('claim.list',{taskId,limit:50,cursor:null});
  detail = await invoke('task.get',{taskId});
  await invoke('task.setStatus',{taskId,expectedTaskRevision:detail.task.revision,status:'PAUSED'});
  const job = await invoke('export.request',{format:'JSON'}); await service.maintenance(); await invoke('export.get',{jobId:job.jobId});
  detail = await invoke('task.get',{taskId}); await invoke('task.delete',{taskId,expectedTaskRevision:detail.task.revision});
  await invoke('account.delete',{confirmation:'DELETE'});
  assert.equal(seen.size,19);
});
test('signed pagination binds user and query and returns no duplicates', async () => {
  const service = new HabitService(new MemoryRepository());
  const invoke = (action:string,payload:any,identity=alice) => service.execute(identity,{protocolVersion:1,action,requestId:randomUUID(),payload});
  for (let index=0;index<3;index++) await invoke('task.create',{title:'任务'+index,description:'',icon:'leaf',timezone:'Asia/Shanghai',startDate:'2026-10-04',rule});
  const first = await invoke('task.list',{status:'ACTIVE',limit:1,cursor:null});
  const second = await invoke('task.list',{status:'ACTIVE',limit:2,cursor:first.data.nextCursor});
  assert.equal(new Set([...first.data.items,...second.data.items].map(item=>item.task._id)).size,3);
  assert.equal((await invoke('task.list',{status:'PAUSED',limit:1,cursor:first.data.nextCursor})).code,'INVALID_CURSOR');
  assert.equal((await invoke('task.list',{status:'ACTIVE',limit:1,cursor:first.data.nextCursor},{...alice,openId:'other'})).code,'INVALID_CURSOR');
});
test('transaction failure after ledger write rolls back facts, balance and receipt', async () => {
  class FaultRepository extends MemoryRepository {
    fail = false;
    async withUser<T>(identity:any,work:any):Promise<T> {
      return super.withUser(identity,async tx=>{
        if (this.fail) { const save=tx.save.bind(tx); tx.save=async (collection,document)=>{ if(collection==='rounds') throw new Error('injected write failure'); return save(collection,document); }; }
        return work(tx);
      });
    }
  }
  const repo = new FaultRepository(), service = new HabitService(repo,()=>new Date('2026-10-04T12:00:00Z'));
  const invoke=(action:string,payload:any,requestId=randomUUID())=>service.execute(alice,{protocolVersion:1,action,requestId,payload});
  const created=await invoke('task.create',{title:'回滚验证',description:'',icon:'leaf',timezone:'Asia/Shanghai',startDate:'2026-10-04',rule});
  const task=created.data.task,payload={taskId:task._id,expectedTaskRevision:task.revision,businessDate:'2026-10-04',outcome:'SUCCESS',note:''},id=randomUUID();
  repo.fail=true; assert.equal((await invoke('checkin.submit',payload,id)).code,'INTERNAL_ERROR'); repo.fail=false;
  assert.equal((await invoke('ledger.list',{taskId:task._id,limit:50,cursor:null})).data.items.length,0);
  assert.equal((await invoke('task.get',{taskId:task._id})).data.task.balancePoints,0);
  assert.equal((await invoke('checkin.submit',payload,id)).data.balancePoints,10);
});
