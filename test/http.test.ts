import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app';
import { HabitService } from '../src/service';
import { MemoryRepository } from '../src/repository';

test('HTTP health is public but commands require platform identity', async () => {
  const repo = new MemoryRepository(), service = new HabitService(repo);
  const app = createApp(service, repo, { allowedAppId: 'wx_test', allowLocalAuth: false });
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  try {
    assert.equal((await fetch(base + '/healthz')).status, 200);
    const denied = await fetch(base + '/api/v1/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ protocolVersion: 1, action: 'session.bootstrap', requestId: randomUUID(), payload: {} }) });
    assert.equal(denied.status, 401);
    const permitted = await fetch(base + '/api/v1/commands', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-wx-appid': 'wx_test', 'x-wx-openid': 'alice', 'x-wx-source': 'wx_devtools' }, body: JSON.stringify({ protocolVersion: 1, action: 'session.bootstrap', requestId: randomUUID(), payload: {} }) });
    assert.equal((await permitted.json()).ok, true);
    assert.equal((await fetch(base + '/api/count', { method: 'POST' })).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
