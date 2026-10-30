import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { resetDb, startApp, post, get } from './helpers';

// Two app instances, like several servers behind a load balancer. Parallel
// requests are split across both, so the tests prove the locking lives in
// Postgres and not in one process's memory.
let a: { app: INestApplication; base: string };
let b: { app: INestApplication; base: string };
let pool: Pool;

before(async () => {
  a = await startApp();
  b = await startApp();
  pool = new Pool({
    connectionString: process.env.DATABASE_URL ?? 'postgres://wallet:wallet@localhost:5432/wallet',
  });
});
after(async () => {
  await a.app.close();
  await b.app.close();
  await pool.end();
});
beforeEach(resetDb);

const debit = (body: object, base = a.base) => post(base, '/wallet/debit', body);
const credit = (body: object, base = a.base) => post(base, '/wallet/credit', body);
const rollback = (body: object, base = a.base) => post(base, '/wallet/rollback', body);
const balance = async (userId: number) => (await get(a.base, `/wallet/${userId}`)).body.balance;

/** Ledger rows for a tx_id, or all rows when no tx_id is given. */
async function ledgerRows(txId?: string): Promise<number> {
  const res = txId
    ? await pool.query('SELECT count(*) FROM wallet_transactions WHERE tx_id = $1', [txId])
    : await pool.query('SELECT count(*) FROM wallet_transactions');
  return Number(res.rows[0].count);
}

/** Runs n requests at the same time, alternating between the two instances. */
function parallel(n: number, send: (i: number, base: string) => ReturnType<typeof post>) {
  return Promise.all(Array.from({ length: n }, (_, i) => send(i, i % 2 ? a.base : b.base)));
}

// --- Required by the README ---

test('20 parallel debits of 10.00 on 100.00: exactly 10 succeed, balance 0.00', async () => {
  const results = await parallel(20, (i, base) =>
    debit({ txId: `d-${i}`, userId: 1, betId: `b-${i}`, amount: '10.00' }, base),
  );

  assert.ok(results.every((r) => r.http === 200));
  assert.equal(results.filter((r) => r.body.status === 'OK').length, 10);
  assert.equal(results.filter((r) => r.body.status === 'INSUFFICIENT_FUNDS').length, 10);
  assert.equal(await balance(1), '0.00');
  assert.equal(await ledgerRows(), 10);
});

test('the same debit txId sent 10 times at once is applied once', async () => {
  const results = await parallel(10, (_, base) =>
    debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount: '10.00' }, base),
  );

  for (const r of results) {
    assert.equal(r.body.status, 'OK');
    assert.equal(r.body.txId, 'd-1');
  }
  assert.equal(await balance(1), '90.00');
  assert.equal(await ledgerRows('d-1'), 1);
});

test('a rollback before its debit adds no money, and the later debit is rejected', async () => {
  const rb = await rollback({ txId: 'r-1', userId: 1, betId: 'b-1', refTxId: 'd-1' });
  assert.deepEqual(rb.body, { status: 'OK', txId: 'r-1', balance: '100.00' });

  const late = await debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount: '10.00' });
  assert.equal(late.body.status, 'INVALID_REQUEST');
  assert.equal(await balance(1), '100.00');
  assert.equal(await ledgerRows('d-1'), 0);
});

test('user 2 has 500.00 but only 50.00 spendable, so a debit of 60 fails', async () => {
  const res = await debit({ txId: 'd-1', userId: 2, betId: 'b-1', amount: '60' });
  assert.deepEqual(res.body, { status: 'INSUFFICIENT_FUNDS', txId: 'd-1', balance: '500.00' });
});

// --- Debit ---

test('a debit of exactly the spendable amount is allowed', async () => {
  const res = await debit({ txId: 'd-1', userId: 2, betId: 'b-1', amount: '50.00' });
  assert.deepEqual(res.body, { status: 'OK', txId: 'd-1', balance: '450.00' });
});

test('a debit never takes more than the balance', async () => {
  const res = await debit({ txId: 'd-1', userId: 3, betId: 'b-1', amount: '0.01' });
  assert.deepEqual(res.body, { status: 'INSUFFICIENT_FUNDS', txId: 'd-1', balance: '0.00' });
  assert.equal(await ledgerRows(), 0);
});

test('a retried debit with the same details returns OK and changes nothing', async () => {
  await debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount: '10' });
  const retry = await debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount: '10.00' });
  assert.deepEqual(retry.body, { status: 'OK', txId: 'd-1', balance: '90.00' });
});

test('the same txId with a different amount or user is rejected', async () => {
  await debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount: '10.00' });

  const otherAmount = await debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount: '20.00' });
  const otherUser = await debit({ txId: 'd-1', userId: 2, betId: 'b-1', amount: '10.00' });
  assert.equal(otherAmount.body.status, 'INVALID_REQUEST');
  assert.equal(otherUser.body.status, 'INVALID_REQUEST');
  assert.equal(await balance(1), '90.00');
  assert.equal(await balance(2), '500.00');
});

test('a credit txId cannot be reused as a debit', async () => {
  await credit({ txId: 'tx-1', userId: 1, betId: 'b-1', amount: '5.00' });
  const res = await debit({ txId: 'tx-1', userId: 1, betId: 'b-1', amount: '5.00' });
  assert.equal(res.body.status, 'INVALID_REQUEST');
  assert.equal(await balance(1), '105.00');
});

// --- Credit ---

test('a credit pays out once, even when retried in parallel', async () => {
  const results = await parallel(10, (_, base) =>
    credit({ txId: 'c-1', userId: 1, betId: 'b-1', amount: '25.50' }, base),
  );

  assert.ok(results.every((r) => r.body.status === 'OK'));
  assert.equal(await balance(1), '125.50');
  assert.equal(await ledgerRows('c-1'), 1);
});

test('parallel credits do not lose updates', async () => {
  await parallel(50, (i, base) =>
    credit({ txId: `c-${i}`, userId: 1, betId: `b-${i}`, amount: '1.00' }, base),
  );
  assert.equal(await balance(1), '150.00');
  assert.equal(await ledgerRows(), 50);
});

test('money is exact: 0.10 + 0.20 = 0.30', async () => {
  await credit({ txId: 'c-1', userId: 3, betId: 'b-1', amount: '0.10' });
  const res = await credit({ txId: 'c-2', userId: 3, betId: 'b-2', amount: 0.2 });
  assert.equal(res.body.balance, '0.30');
});

// --- Rollback ---

test('a rollback refunds exactly the debit amount, once', async () => {
  await debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount: '12.34' });

  const first = await rollback({ txId: 'r-1', userId: 1, betId: 'b-1', refTxId: 'd-1' });
  assert.deepEqual(first.body, { status: 'OK', txId: 'r-1', balance: '100.00' });

  const retry = await rollback({ txId: 'r-1', userId: 1, betId: 'b-1', refTxId: 'd-1' });
  assert.deepEqual(retry.body, { status: 'OK', txId: 'r-1', balance: '100.00' });

  const second = await rollback({ txId: 'r-2', userId: 1, betId: 'b-1', refTxId: 'd-1' });
  assert.equal(second.body.status, 'INVALID_REQUEST');
  assert.equal(await balance(1), '100.00');
});

test('the same rollback sent 10 times at once refunds once', async () => {
  await debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount: '10.00' });
  const results = await parallel(10, (_, base) =>
    rollback({ txId: 'r-1', userId: 1, betId: 'b-1', refTxId: 'd-1' }, base),
  );

  assert.ok(results.every((r) => r.body.status === 'OK'));
  assert.equal(await balance(1), '100.00');
  assert.equal(await ledgerRows('r-1'), 1);
});

test('a debit and its rollback arriving together end at the starting balance', async () => {
  await Promise.all([
    debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount: '10.00' }, a.base),
    rollback({ txId: 'r-1', userId: 1, betId: 'b-1', refTxId: 'd-1' }, b.base),
  ]);
  assert.equal(await balance(1), '100.00');
});

test('only a debit can be rolled back', async () => {
  await credit({ txId: 'c-1', userId: 1, betId: 'b-1', amount: '5.00' });
  const res = await rollback({ txId: 'r-1', userId: 1, betId: 'b-1', refTxId: 'c-1' });
  assert.equal(res.body.status, 'INVALID_REQUEST');
  assert.equal(await balance(1), '105.00');
});

test("another user's debit cannot be rolled back, and the owner still can", async () => {
  await debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount: '10.00' });

  const wrongUser = await rollback({ txId: 'r-1', userId: 2, betId: 'b-1', refTxId: 'd-1' });
  assert.equal(wrongUser.body.status, 'INVALID_REQUEST');
  assert.equal(await balance(2), '500.00');

  const owner = await rollback({ txId: 'r-2', userId: 1, betId: 'b-1', refTxId: 'd-1' });
  assert.equal(owner.body.status, 'OK');
  assert.equal(await balance(1), '100.00');
});

// --- Every response is HTTP 200 ---

test('unknown users get UNKNOWN_USER', async () => {
  for (const send of [debit, credit]) {
    const res = await send({ txId: 'x-1', userId: 99, betId: 'b-1', amount: '1.00' });
    assert.deepEqual(res.body, { status: 'UNKNOWN_USER', txId: 'x-1' });
  }
  const rb = await rollback({ txId: 'x-2', userId: 99, betId: 'b-1', refTxId: 'd-1' });
  assert.equal(rb.body.status, 'UNKNOWN_USER');
});

test('invalid amounts return HTTP 200 with INVALID_REQUEST', async () => {
  for (const amount of ['0', '0.00', '-5', '10.001', '1e3', 'abc', '', null, 0.1 + 0.2]) {
    const res = await debit({ txId: 'd-1', userId: 1, betId: 'b-1', amount });
    assert.equal(res.http, 200, `amount ${amount}`);
    assert.equal(res.body.status, 'INVALID_REQUEST', `amount ${amount}`);
  }
  assert.equal(await balance(1), '100.00');
  assert.equal(await ledgerRows(), 0);
});

test('missing fields and broken JSON return HTTP 200 with INVALID_REQUEST', async () => {
  const missing = await rollback({ txId: 'r-1', userId: 1, betId: 'b-1' });
  assert.deepEqual(missing, { http: 200, body: { status: 'INVALID_REQUEST', txId: 'r-1' } });

  const res = await fetch(`${a.base}/wallet/debit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { status: 'INVALID_REQUEST' });
});
