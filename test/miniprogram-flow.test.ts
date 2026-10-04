import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve,dirname } from 'node:path';
import { runInNewContext } from 'node:vm';
import { createApp } from '../src/app';
import { HabitService } from '../src/service';
import { MemoryRepository } from '../src/repository';

test('native page handlers run create → checkin → correction → reward → history over HTTP', async () => {
  const repo=new MemoryRepository(), service=new HabitService(repo,()=>new Date('2026-10-04T12:00:00Z'));
  const server=createApp(service,repo,{allowedAppId:'wx_test',allowLocalAuth:true}).listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  const base='http://127.0.0.1:'+(server.address() as any).port;
  const storage=new Map(), routes:any[]=[], toasts:any[]=[], cloudCalls:any[]=[];
  const wx:any={ cloud:{callContainer(options:any){ cloudCalls.push(options); fetch(base+options.path,{method:options.method,headers:{'Content-Type':'application/json','x-habitloop-test-user':'alice'},body:options.method==='POST'?JSON.stringify(options.data):undefined}).then(async response=>options.success({statusCode:response.status,data:await response.json()})).catch(options.fail); }}, getStorageSync:(key:string)=>storage.get(key), setStorageSync:(key:string,value:any)=>storage.set(key,structuredClone(value)), removeStorageSync:(key:string)=>storage.delete(key), getStorageInfoSync:()=>({keys:[...storage.keys()]}), showModal:(options:any)=>options.success({confirm:true}), showToast:(options:any)=>toasts.push(options), navigateTo:(options:any)=>routes.push(options),redirectTo:(options:any)=>routes.push(options),navigateBack:()=>{},stopPullDownRefresh:()=>{} };
  const {ApiClient}=require('../../HabitLoop/miniprogram/lib/api');
  const api=new ApiClient(wx,{env:'test',service:'svc',domain:base},()=>Promise.resolve());
  const nativeView=require('../../HabitLoop/miniprogram/lib/view').View;
  const View={ task:nativeView.task,rule:nativeView.rule,money:nativeView.money,allTasks:nativeView.allTasks,confirm:async()=>true,toast:(title:string)=>toasts.push({title}),error:(error:any)=>{throw error;} };
  const page=(name:string)=>{
    const filename=resolve('../HabitLoop/miniprogram/pages',name,'index.js'); let definition:any;
    runInNewContext(readFileSync(filename,'utf8'),{Page:(value:any)=>definition=value,require:(name:string)=>name.endsWith('/api')?{api}:name.endsWith('/view')?{View}:require(resolve(dirname(filename),name)),wx,console,setTimeout,clearTimeout});
    definition.data=structuredClone(definition.data); definition.setData=(values:any)=>{for(const[key,value]of Object.entries(values)){if(key.startsWith('form.')) definition.data.form[key.slice(5)]=value;else definition.data[key]=value;}};return definition;
  };
  try {
    const editor=page('task-edit'); await editor.onLoad({});
    editor.data.form.title='不买额外吃食';editor.data.form.target='10'; await editor.save();
    assert.match(routes[0].url,/\/pages\/task\/index\?id=tsk_/);
    const id=routes[0].url.split('id=')[1], home=page('index');await home.onShow();assert.equal(home.data.items.length,1);
    await home.submit({currentTarget:{dataset:{id}}});assert.equal(home.data.items[0].task.balancePoints,10);
    await home.reload({type:'tap'});assert.equal(home.data.items.length,1,'button event must not append');
    const detail=page('task');detail.onLoad({id});await detail.onShow();assert.equal(detail.data.cells.find((cell:any)=>cell.date==='2026-10-04').points,10);
    await detail.mutate('checkin.correct',{taskId:id,expectedTaskRevision:detail.data.detail.task.revision,checkinId:detail.data.detail.today.checkinId,expectedCheckinRevision:1,outcome:'FAILURE',note:''},'修正');
    assert.equal(detail.data.detail.task.balancePoints,0);
    await detail.mutate('checkin.correct',{taskId:id,expectedTaskRevision:detail.data.detail.task.revision,checkinId:detail.data.detail.today.checkinId,expectedCheckinRevision:2,outcome:'SUCCESS',note:''},'修正');
    const reward=page('reward');reward.onLoad({id});await reward.onShow();reward.data.amount='399.99';await reward.claim();
    const history=page('history');await history.onShow();await history.selectKind({currentTarget:{dataset:{index:2}}});assert.equal(history.data.items.length,1);assert.equal(history.data.items[0].rewardRecord.amountCents,39999);
    await history.selectKind({currentTarget:{dataset:{index:1}}});assert.equal(history.data.items.length,4);
    const reread=await api.query('task.get',{taskId:id});assert.equal(reread.task.balancePoints,0);assert.equal(reread.round.startDate,'2026-10-05');
    await service.maintenance();assert.equal(api.pendingCount(),0);assert.ok(cloudCalls.length>10);
  } finally { await new Promise<void>(resolve=>server.close(()=>resolve())); }
});
