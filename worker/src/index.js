const CART_TTL_SECONDS = 86400;
const SESSION_TTL_SECONDS = 60 * 60;
const ORDER_TTL_SECONDS = 86400 * 7;
const LOGIN_WINDOW_SECONDS = 15 * 60;
const LOGIN_ATTEMPT_LIMIT = 5;
const PASSWORD_ITERATIONS = 120000;

class ApiError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

const CATALOG = Object.freeze({
  'BM6+': Object.freeze({
    sku: 'BM6+',
    name: 'BM6+ – Phiên bản gia đình',
    price: 17600000,
  }),
  'ARCII PLUS': Object.freeze({
    sku: 'ARCII PLUS',
    name: 'ARCII plus – Phiên bản di động',
    price: 5800000,
  }),
  'ARC PLUS': Object.freeze({
    sku: 'ARC PLUS',
    name: 'ARC plus – Phiên bản dùng cho ô tô',
    price: 3500000,
  }),
  PRO9: Object.freeze({
    sku: 'PRO9',
    name: 'PRO9 – Phiên bản thương mại',
    price: 56780000,
  }),
});

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      if (error instanceof ApiError) {
        return json(request, { ok: false, error: error.message }, error.status, env);
      }
      console.error('Unhandled Worker error', error);
      return json(request, { ok: false, error: 'internal_error' }, 500);
    }
  },
};

async function handleRequest(request, env) {
  if (request.method === 'OPTIONS') {
    if (!isAllowedOrigin(request.headers.get('Origin'), env)) {
      return new Response(null, { status: 403 });
    }
    return new Response(null, { status: 204, headers: corsHeaders(request, env) });
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';

  if (request.method !== 'GET' && !isAllowedOrigin(request.headers.get('Origin'), env)) {
    return json(request, { ok: false, error: 'origin_not_allowed' }, 403, env);
  }

  if (request.method === 'GET' && path === '/health') {
    return json(request, { ok: true, version: '2' }, 200, env);
  }

  if (request.method === 'GET' && path === '/cart') {
    return getCart(request, env, url.searchParams.get('sid'));
  }

  if (request.method === 'POST' && path === '/cart/add') {
    const body = await readJson(request);
    return addCartItem(request, env, body.sid, body.sku, body.qty);
  }

  if (request.method === 'PUT' && path === '/cart') {
    const body = await readJson(request);
    return replaceCart(request, env, body.sid, body.items);
  }

  if (request.method === 'DELETE' && path === '/cart') {
    return clearCart(request, env, url.searchParams.get('sid'));
  }

  // Temporary compatibility for already-cached frontend pages. Client prices are ignored.
  if (request.method === 'GET' && path === '/add') {
    return addCartItem(
      request,
      env,
      url.searchParams.get('sid'),
      url.searchParams.get('sku'),
      url.searchParams.get('qty'),
    );
  }

  if (request.method === 'POST' && path === '/clear') {
    return clearCart(request, env, url.searchParams.get('sid'));
  }

  if (request.method === 'GET' && path === '/profile/check') {
    return checkProfile(request, env, url.searchParams.get('email'));
  }

  if (request.method === 'POST' && path === '/profile/login') {
    return loginProfile(request, env);
  }

  if (request.method === 'POST' && path === '/profile/save') {
    return updateProfile(request, env);
  }

  if (request.method === 'POST' && path === '/profile/logout') {
    return logoutProfile(request, env);
  }

  if (request.method === 'POST' && path === '/order') {
    return createOrder(request, env);
  }

  return json(request, { ok: false, error: 'not_found' }, 404, env);
}

async function getCart(request, env, rawSid) {
  const sid = normalizeSid(rawSid);
  if (!sid) return json(request, { ok: false, error: 'invalid_sid' }, 400, env);
  const cart = await readCart(env, sid);
  return json(request, { ok: true, cart }, 200, env);
}

async function addCartItem(request, env, rawSid, rawSku, rawQty) {
  const sid = normalizeSid(rawSid);
  const sku = normalizeSku(rawSku);
  const qty = normalizeQty(rawQty);
  if (!sid || !sku || !qty) {
    return json(request, { ok: false, error: 'invalid_cart_item' }, 400, env);
  }

  const cart = await readCart(env, sid);
  const existing = cart.find((item) => item.sku === sku);
  if (existing) existing.qty = Math.min(99, existing.qty + qty);
  else cart.push(catalogItem(sku, qty));

  await writeCart(env, sid, cart);
  return json(request, { ok: true, cart }, 200, env);
}

async function replaceCart(request, env, rawSid, rawItems) {
  const sid = normalizeSid(rawSid);
  if (!sid || !Array.isArray(rawItems) || rawItems.length > 20) {
    return json(request, { ok: false, error: 'invalid_cart' }, 400, env);
  }

  const merged = new Map();
  for (const rawItem of rawItems) {
    const sku = normalizeSku(rawItem && rawItem.sku);
    const qty = normalizeQty(rawItem && rawItem.qty);
    if (!sku || !qty) {
      return json(request, { ok: false, error: 'invalid_cart_item' }, 400, env);
    }
    merged.set(sku, Math.min(99, (merged.get(sku) || 0) + qty));
  }

  const cart = Array.from(merged, ([sku, qty]) => catalogItem(sku, qty));
  await writeCart(env, sid, cart);
  return json(request, { ok: true, cart }, 200, env);
}

async function clearCart(request, env, rawSid) {
  const sid = normalizeSid(rawSid);
  if (!sid) return json(request, { ok: false, error: 'invalid_sid' }, 400, env);
  await env.CART.delete(`cart:${sid}`);
  return json(request, { ok: true }, 200, env);
}

async function checkProfile(request, env, rawAccountId) {
  const accountId = normalizeAccountId(rawAccountId);
  if (!accountId) return json(request, { exists: false }, 200, env);
  const profile = await readProfile(env, accountId);
  return json(request, { exists: Boolean(profile && hasPassword(profile)) }, 200, env);
}

async function loginProfile(request, env) {
  const body = await readJson(request);
  const accountId = normalizeAccountId(body.email);
  const password = String(body.password || '');
  if (!accountId || !password) return loginFailure(request, env);

  const rateKey = await loginRateKey(request, accountId);
  const attempts = Number((await env.PROFILE.get(rateKey)) || 0);
  if (attempts >= LOGIN_ATTEMPT_LIMIT) {
    return json(request, { ok: false, login: false, error: 'too_many_attempts' }, 429, env);
  }

  const profile = await readProfile(env, accountId);
  const valid = profile ? await verifyProfilePassword(profile, password) : false;
  if (!valid) {
    await env.PROFILE.put(rateKey, String(attempts + 1), {
      expirationTtl: LOGIN_WINDOW_SECONDS,
    });
    return loginFailure(request, env);
  }

  await env.PROFILE.delete(rateKey);
  if (!profile.password_hash) {
    Object.assign(profile, await makePasswordRecord(password));
    delete profile.password;
    profile.updated_at = new Date().toISOString();
    await writeProfile(env, accountId, profile);
  }

  const token = await createSession(env, accountId);
  return json(request, {
    ok: true,
    login: true,
    token,
    profile: safeProfile(profile),
  }, 200, env);
}

async function updateProfile(request, env) {
  const session = await requireSession(request, env);
  if (!session) return json(request, { ok: false, error: 'unauthorized' }, 401, env);

  const body = await readJson(request);
  const accountId = normalizeAccountId(body.email);
  if (!accountId || accountId !== session.accountId) {
    return json(request, { ok: false, error: 'unauthorized' }, 401, env);
  }

  const current = await readProfile(env, accountId);
  if (!current) return json(request, { ok: false, error: 'profile_not_found' }, 404, env);
  const updated = mergeProfile(current, body);
  await writeProfile(env, accountId, updated);
  return json(request, { ok: true, profile: safeProfile(updated) }, 200, env);
}

async function logoutProfile(request, env) {
  const token = bearerToken(request);
  if (token) await env.PROFILE.delete(`session:${await sha256(token)}`);
  return json(request, { ok: true }, 200, env);
}

async function createOrder(request, env) {
  const body = await readJson(request);
  const sid = normalizeSid(body.sid);
  const submissionId = normalizeSubmissionId(body.submissionId);
  const customer = validateCustomer(body.customer);
  if (!sid || !submissionId || !customer) {
    return json(request, { ok: false, error: 'invalid_order' }, 400, env);
  }

  const existingOrder = await readOrderResult(env, submissionId);
  if (existingOrder) {
    if (existingOrder.sid !== sid) {
      return json(request, { ok: false, error: 'invalid_submission_id' }, 409, env);
    }
    await env.CART.delete(`cart:${sid}`);
    return json(request, existingOrder.result, 200, env);
  }

  const cart = await readCart(env, sid);
  if (!cart.length) return json(request, { ok: false, error: 'empty_cart' }, 400, env);

  const total = cart.reduce((sum, item) => sum + item.price * item.qty, 0);
  const orderId = submissionId;
  const orderPayload = {
    action: 'saveOrder',
    order_id: orderId,
    customer: {
      email: customer.accountId,
      recipient_name: customer.recipientName,
      recipient_phone: customer.recipientPhone,
      recipient_address: customer.recipientAddress,
      remarks: customer.remarks,
      bank_last5: customer.bankTransferName,
      invoice_tax_id: customer.invoiceTaxId,
      invoice_title: '',
    },
    cart: cart.map((item) => ({
      sku: item.sku,
      code: item.sku,
      product_id: '',
      sourceId: '',
      name: item.name,
      price: item.price,
      qty: item.qty,
      subtotal: item.price * item.qty,
    })),
    total,
    created_at: new Date().toISOString(),
  };

  const gasUrl = String(env.GAS_URL || '');
  if (!gasUrl.startsWith('https://script.google.com/')) {
    return json(request, { ok: false, error: 'order_service_unavailable' }, 503, env);
  }

  const gasResponse = await fetch(gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
    body: JSON.stringify(orderPayload),
    redirect: 'follow',
  });
  if (!gasResponse.ok) {
    console.error('Order service error', gasResponse.status);
    return json(request, { ok: false, error: 'order_service_failed' }, 502, env);
  }

  let profileSaved = false;
  if (customer.saveProfile) {
    profileSaved = await saveProfileFromOrder(request, env, customer);
  }

  const result = { ok: true, orderId, total, profileSaved };
  await env.CART.put(`order:${submissionId}`, JSON.stringify({ sid, result }), {
    expirationTtl: ORDER_TTL_SECONDS,
  });
  await env.CART.delete(`cart:${sid}`);
  return json(request, result, 200, env);
}

async function saveProfileFromOrder(request, env, customer) {
  const existing = await readProfile(env, customer.accountId);
  const session = await requireSession(request, env);

  if (existing && (!session || session.accountId !== customer.accountId)) return false;
  if (!existing && customer.newPassword.length < 8) return false;

  let profile = existing || {
    email: customer.accountId,
    ...(await makePasswordRecord(customer.newPassword)),
    created_at: new Date().toISOString(),
  };
  profile = mergeProfile(profile, {
    recipient_name: customer.recipientName,
    recipient_phone: customer.recipientPhone,
    recipient_address: customer.recipientAddress,
    remarks: customer.remarks,
    invoice_tax_id: customer.invoiceTaxId,
  });
  await writeProfile(env, customer.accountId, profile);
  return true;
}

function validateCustomer(raw) {
  const customer = raw && typeof raw === 'object' ? raw : {};
  const accountId = normalizeAccountId(customer.email);
  const recipientName = cleanText(customer.recipient_name, 120);
  const recipientPhone = normalizeAccountId(customer.recipient_phone);
  const recipientAddress = cleanText(customer.recipient_address, 500);
  const bankTransferName = cleanText(customer.bank_last5, 120);
  const newPassword = String(customer.new_password || '');
  if (!accountId || !recipientName || !recipientPhone || !recipientAddress || !bankTransferName) {
    return null;
  }
  return {
    accountId,
    recipientName,
    recipientPhone,
    recipientAddress,
    bankTransferName,
    remarks: cleanText(customer.remarks, 500),
    invoiceTaxId: cleanText(customer.invoice_tax_id, 50),
    saveProfile: Boolean(customer.save_profile),
    newPassword,
  };
}

function mergeProfile(current, body) {
  return {
    ...current,
    email: current.email,
    recipient_name: cleanText(body.recipient_name, 120),
    recipient_phone: normalizeAccountId(body.recipient_phone) || '',
    recipient_address: cleanText(body.recipient_address, 500),
    remarks: cleanText(body.remarks, 500),
    invoice_tax_id: cleanText(body.invoice_tax_id, 50),
    updated_at: new Date().toISOString(),
  };
}

function safeProfile(profile) {
  return {
    email: profile.email,
    recipient_name: profile.recipient_name || '',
    recipient_phone: profile.recipient_phone || '',
    recipient_address: profile.recipient_address || '',
    remarks: profile.remarks || '',
    invoice_tax_id: profile.invoice_tax_id || '',
  };
}

async function makePasswordRecord(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derivePassword(password, salt, PASSWORD_ITERATIONS);
  return {
    password_hash: bytesToBase64(hash),
    password_salt: bytesToBase64(salt),
    password_iterations: PASSWORD_ITERATIONS,
  };
}

async function verifyProfilePassword(profile, password) {
  if (profile.password_hash && profile.password_salt) {
    const iterations = Number(profile.password_iterations || PASSWORD_ITERATIONS);
    const actual = await derivePassword(password, base64ToBytes(profile.password_salt), iterations);
    return timingSafeEqual(actual, base64ToBytes(profile.password_hash));
  }
  return typeof profile.password === 'string' && profile.password === password;
}

async function derivePassword(password, salt, iterations) {
  const material = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    256,
  );
  return new Uint8Array(bits);
}

async function createSession(env, accountId) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToBase64(tokenBytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  await env.PROFILE.put(`session:${await sha256(token)}`, JSON.stringify({ accountId }), {
    expirationTtl: SESSION_TTL_SECONDS,
  });
  return token;
}

async function requireSession(request, env) {
  const token = bearerToken(request);
  if (!token) return null;
  const raw = await env.PROFILE.get(`session:${await sha256(token)}`);
  if (!raw) return null;
  try {
    const session = JSON.parse(raw);
    return normalizeAccountId(session.accountId) ? session : null;
  } catch {
    return null;
  }
}

function bearerToken(request) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '');
  return match ? match[1].trim() : '';
}

async function loginRateKey(request, accountId) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  return `login:${await sha256(accountId)}:${await sha256(ip)}`;
}

async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(left, right) {
  if (left.length !== right.length) return false;
  let result = 0;
  for (let index = 0; index < left.length; index += 1) result |= left[index] ^ right[index];
  return result === 0;
}

function bytesToBase64(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function hasPassword(profile) {
  return Boolean(profile && (profile.password_hash || profile.password));
}

function normalizeSid(value) {
  const sid = String(value || '').trim();
  return /^[A-Za-z0-9_-]{12,128}$/.test(sid) ? sid : '';
}

function normalizeSku(value) {
  const sku = String(value || '').trim().toUpperCase();
  return CATALOG[sku] ? sku : '';
}

function normalizeQty(value) {
  const qty = Number.parseInt(value, 10);
  return Number.isFinite(qty) && qty >= 1 && qty <= 99 ? qty : 0;
}

function normalizeSubmissionId(value) {
  const id = String(value || '').trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
    ? id
    : '';
}

function normalizeAccountId(value) {
  const accountId = String(value || '').replace(/\s+/g, '');
  return /^\+?[0-9]{8,15}$/.test(accountId) ? accountId : '';
}

function cleanText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

function catalogItem(sku, qty) {
  const product = CATALOG[sku];
  return { id: sku, sku, name: product.name, price: product.price, qty };
}

async function readCart(env, sid) {
  const raw = await env.CART.get(`cart:${sid}`);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item) => {
      const sku = normalizeSku(item && item.sku);
      const qty = normalizeQty(item && item.qty);
      return sku && qty ? [catalogItem(sku, qty)] : [];
    });
  } catch {
    return [];
  }
}

async function writeCart(env, sid, cart) {
  await env.CART.put(`cart:${sid}`, JSON.stringify(cart), { expirationTtl: CART_TTL_SECONDS });
}

async function readOrderResult(env, submissionId) {
  const raw = await env.CART.get(`order:${submissionId}`);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && parsed.sid && parsed.result ? parsed : null;
  } catch {
    return null;
  }
}

async function readProfile(env, accountId) {
  const raw = await env.PROFILE.get(`profile:${accountId}`);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeProfile(env, accountId, profile) {
  await env.PROFILE.put(`profile:${accountId}`, JSON.stringify(profile));
}

async function readJson(request) {
  const length = Number(request.headers.get('Content-Length') || 0);
  if (length > 64 * 1024) throw new ApiError('payload_too_large', 413);
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > 64 * 1024) {
      throw new ApiError('payload_too_large', 413);
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError('invalid_json', 400);
  }
}

function loginFailure(request, env) {
  return json(request, { ok: false, login: false, error: 'invalid_credentials' }, 401, env);
}

function isAllowedOrigin(origin, env) {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    const configured = String(env.FRONTEND_URL || 'https://www.ecohealvn.com');
    if (url.origin === configured || url.origin === 'https://ecohealvn.com') return true;
    if (url.hostname === 'ecohealvn-website.pages.dev') return true;
    if (url.hostname.endsWith('.ecohealvn-website.pages.dev')) return true;
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  } catch {
    return false;
  }
}

function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
  };
  if (origin && isAllowedOrigin(origin, env)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

function json(request, data, status = 200, env = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders(request, env), 'Content-Type': 'application/json;charset=UTF-8' },
  });
}

export const __test = {
  CATALOG,
  normalizeSid,
  normalizeSku,
  normalizeQty,
  normalizeSubmissionId,
  validateCustomer,
};
