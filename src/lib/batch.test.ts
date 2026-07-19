import assert from 'node:assert/strict'
import test from 'node:test'
import {batchSummary, makeBatchItems} from './batch.js'

test('builds pending batch items with stable ids from urls and optional titles', () => {
  const items = makeBatchItems([
    {url: 'https://example.com/a', title: 'Video A'},
    {url: 'https://example.com/b'},
  ])
  assert.equal(items.length, 2)
  assert.equal(items[0]!.status, 'pending')
  assert.equal(items[0]!.title, 'Video A')
  assert.equal(items[1]!.title, undefined)
  assert.notEqual(items[0]!.id, items[1]!.id)
})

test('summarizes counts across every status', () => {
  const items = makeBatchItems([{url: 'a'}, {url: 'b'}, {url: 'c'}, {url: 'd'}, {url: 'e'}])
  items[0]!.status = 'done'
  items[1]!.status = 'done'
  items[2]!.status = 'error'
  items[3]!.status = 'skipped'
  // items[4] stays pending

  assert.deepEqual(batchSummary(items), {done: 2, error: 1, skipped: 1, pending: 1, total: 5})
})
