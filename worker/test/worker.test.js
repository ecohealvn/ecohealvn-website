import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';

class MemoryKV {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value) {
    this.values.set(key, String(value));
  }

  async delete(key) {
    this.values.delete(key);
  }
}

function makeEnv() {
  return {
    CART: new MemoryKV(),
    PROFILE: new MemoryKV(),
    FRONTEND_URL: 'https://www.ecohealvn.com',
    GAS_URL: 'https://script.google.com/macros/s/test/exec',
  };
}

function request(path, { method = 'GET', body, origin = 'https://www.ecohealvn.com', headers = {} } = {}) {
  const requestHeaders = new Headers(headers);
  if (origin) requestHeaders.set('Origin', origin);
  if (body !== undefined) requestHeaders.set('Content-Type', 'application/json');
  return new Request(`https://ecoheal-cart-api.example${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function responseJson(response) {
  return { response, data: await response.json() };
}

const sid = 'customer-session-123';

test('server catalog ignores client-supplied product name and price', async () => {
  const env = makeEnv();
  const { response, data } = await responseJson(await worker.fetch(request('/cart/add', {
    method: 'POST',
    body: { sid, sku: 'BM6+', qty: 2, name: 'Fake', price: 1 },
  }), env));

  assert.equal(response.status, 200);
  assert.equal(data.cart[0].name, 'BM6+ – Phiên bản gia đình');
  assert.equal(data.cart[0].price, 17600000);
  assert.equal(data.cart[0].qty, 2);
});

test('invalid JSON is a client error, not an internal server error', async () => {
  const env = makeEnv();
  const response = await worker.fetch(new Request('https://ecoheal-cart-api.example/cart/add', {
    method: 'POST',
    headers: { Origin: 'https://www.ecohealvn.com', 'Content-Type': 'application/json' },
    body: '{invalid',
  }), env);

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { ok: false, error: 'invalid_json' });
});

test('oversized JSON bodies are rejected even without a Content-Length header', async () => {
  const env = makeEnv();
  const response = await worker.fetch(new Request('https://ecoheal-cart-api.example/cart/add', {
    method: 'POST',
    headers: { Origin: 'https://www.ecohealvn.com', 'Content-Type': 'application/json' },
    body: JSON.stringify({ padding: 'x'.repeat(70 * 1024) }),
  }), env);

  assert.equal(response.status, 413);
  assert.deepEqual(await response.json(), { ok: false, error: 'payload_too_large' });
});

test('profile updates require an authenticated session', async () => {
  const env = makeEnv();
  const { response, data } = await responseJson(await worker.fetch(request('/profile/save', {
    method: 'POST',
    body: { email: '0348580221', recipient_name: 'Attacker' },
  }), env));

  assert.equal(response.status, 401);
  assert.equal(data.error, 'unauthorized');
});

test('successful order uses server totals, hashes password, clears cart, and is idempotent', async () => {
  const env = makeEnv();
  await worker.fetch(request('/cart/add', {
    method: 'POST',
    body: { sid, sku: 'ARCII PLUS', qty: 2 },
  }), env);

  const submissionId = crypto.randomUUID();
  const orderBody = {
    sid,
    submissionId,
    customer: {
      email: '0348580221',
      recipient_name: 'Ecoheal Test',
      recipient_phone: '0348580221',
      recipient_address: 'Ho Chi Minh City',
      bank_last5: 'Ecoheal Test',
      save_profile: true,
      new_password: 'strong-test-password',
    },
  };

  const originalFetch = globalThis.fetch;
  const postedOrders = [];
  globalThis.fetch = async (_url, options) => {
    postedOrders.push(JSON.parse(options.body));
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };

  try {
    const first = await responseJson(await worker.fetch(request('/order', { method: 'POST', body: orderBody }), env));
    assert.equal(first.response.status, 200);
    assert.equal(first.data.orderId, submissionId);
    assert.equal(first.data.total, 11600000);
    assert.equal(first.data.profileSaved, true);
    assert.equal(postedOrders.length, 1);
    assert.equal(postedOrders[0].cart[0].price, 5800000);
    assert.equal(postedOrders[0].total, 11600000);
    assert.equal(await env.CART.get(`cart:${sid}`), null);

    const storedProfile = JSON.parse(await env.PROFILE.get('profile:0348580221'));
    assert.equal(typeof storedProfile.password_hash, 'string');
    assert.equal(storedProfile.password, undefined);

    const retry = await responseJson(await worker.fetch(request('/order', { method: 'POST', body: orderBody }), env));
    assert.equal(retry.response.status, 200);
    assert.deepEqual(retry.data, first.data);
    assert.equal(postedOrders.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('failed order service leaves the cart intact', async () => {
  const env = makeEnv();
  await worker.fetch(request('/cart/add', {
    method: 'POST',
    body: { sid, sku: 'ARC PLUS', qty: 1 },
  }), env);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('failed', { status: 500 });
  try {
    const { response, data } = await responseJson(await worker.fetch(request('/order', {
      method: 'POST',
      body: {
        sid,
        submissionId: crypto.randomUUID(),
        customer: {
          email: '0348580221',
          recipient_name: 'Ecoheal Test',
          recipient_phone: '0348580221',
          recipient_address: 'Ho Chi Minh City',
          bank_last5: 'Ecoheal Test',
          save_profile: false,
        },
      },
    }), env));

    assert.equal(response.status, 502);
    assert.equal(data.error, 'order_service_failed');
    assert.notEqual(await env.CART.get(`cart:${sid}`), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy plaintext profiles migrate after a successful login', async () => {
  const env = makeEnv();
  await env.PROFILE.put('profile:0348580221', JSON.stringify({
    email: '0348580221',
    password: 'legacy-password',
    recipient_name: 'Legacy Customer',
  }));

  const { response, data } = await responseJson(await worker.fetch(request('/profile/login', {
    method: 'POST',
    body: { email: '0348580221', password: 'legacy-password' },
    headers: { 'CF-Connecting-IP': '203.0.113.10' },
  }), env));

  assert.equal(response.status, 200);
  assert.equal(data.login, true);
  assert.equal(typeof data.token, 'string');
  const migrated = JSON.parse(await env.PROFILE.get('profile:0348580221'));
  assert.equal(typeof migrated.password_hash, 'string');
  assert.equal(migrated.password, undefined);
});

test('write requests from unapproved browser origins are rejected', async () => {
  const env = makeEnv();
  const { response, data } = await responseJson(await worker.fetch(request('/cart/add', {
    method: 'POST',
    origin: 'https://attacker.example',
    body: { sid, sku: 'BM6+', qty: 1 },
  }), env));

  assert.equal(response.status, 403);
  assert.equal(data.error, 'origin_not_allowed');
});
