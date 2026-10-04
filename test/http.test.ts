import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app';
import { HabitService } from '../src/service';
import { MemoryRepository } from '../src/repository';

test('HTTP health is public but commands require platform identity', async (context) => {
  context.mock.method(console, 'warn', () => {});
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

test('Cloud Run source markers are not restricted to VM examples; missing or mismatched identity remains denied', async (context) => {
  const warning = context.mock.method(console, 'warn', () => {});
  const repo = new MemoryRepository(), service = new HabitService(repo);
  const server = createApp(service, repo, { allowedAppId: 'wx_test', allowLocalAuth: false }).listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = 'http://127.0.0.1:' + (server.address() as any).port;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', 'x-wx-appid': 'wx_test', 'x-wx-openid': 'private-user-id', 'x-wx-source': 'opaque-cloud-run-marker' };
  const body = JSON.stringify({ protocolVersion: 1, action: 'session.bootstrap', requestId: randomUUID(), payload: {} });
  try {
    const permitted = await fetch(base + '/api/v1/commands', { method: 'POST', headers, body });
    assert.equal(permitted.status, 200, 'a source marker is platform metadata, not a fixed two-value enum');
    assert.equal((await permitted.json()).ok, true);
    for (const [field, value, reason] of [
      ['x-wx-source', '', 'MISSING_SOURCE'],
      ['x-wx-appid', '', 'MISSING_APP_ID'],
      ['x-wx-appid', 'wx_other', 'APP_ID_MISMATCH'],
      ['x-wx-openid', '', 'MISSING_OPEN_ID'],
      ['x-wx-openid', 'a'.repeat(129), 'INVALID_OPEN_ID']
    ]) {
      const response = await fetch(base + '/api/v1/commands', { method: 'POST', headers: { ...headers, [field]: value }, body });
      assert.equal(response.status, 401);
      const denied = await response.json();
      assert.equal(denied.error.details.reason, reason);
      assert.equal(denied.error.retryable, false);
      assert.ok(!JSON.stringify(denied).includes('private-user-id'), 'diagnostics must not expose OpenID');
    }
    assert.equal(warning.mock.calls.length, 5);
    assert.ok(!JSON.stringify(warning.mock.calls).includes('private-user-id'), 'logs must not expose OpenID');
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
