// Deleting a program must not report a delete it did not do.
//
// `program_delete` without `recursive` on a folder used to answer `{deleted: path}` and remove
// nothing: `#programFile` only ever names a file, so a folder fell through. An agent that then
// reused the folder's contents found them still there with no warning anywhere. A folder is a
// REFUSAL now, and it names the flag.
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { Store } from './store.mjs'

async function volume() {
  const root = await mkdtemp(path.join(tmpdir(), 'program-delete-'))
  const store = new Store(root)
  await store.init()
  return { root, store }
}

test('removeProgram REFUSES a folder and names recursive', async () => {
  const { root, store } = await volume()
  try {
    await store.makeProgramDir('levels/rooftop')
    await store.putProgram('levels/rooftop/run.ts', 'export const x = 1')
    await assert.rejects(store.removeProgram('levels/rooftop'), /is a folder — pass recursive/)
    // and it really is still there
    assert.equal(existsSync(path.join(store.programs, 'levels/rooftop/run.ts')), true)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removeProgram removes a file and reports what it removed', async () => {
  const { root, store } = await volume()
  try {
    await store.putProgram('levels/rooftop/run.ts', 'export const x = 1')
    assert.deepEqual(await store.removeProgram('levels/rooftop/run.ts'), { deleted: 'levels/rooftop/run.ts' })
    assert.equal(await store.getProgram('levels/rooftop/run.ts'), null)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removeProgram on a path that is nothing is a reported no-op, not a fake delete', async () => {
  const { root, store } = await volume()
  try {
    // no extension and not an existing folder: nothing to delete, and it says so rather than
    // claiming a file was removed
    assert.deepEqual(await store.removeProgram('levels/ghost'), { deleted: null })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('removeProgramDir with the flag deletes a folder and everything in it', async () => {
  const { root, store } = await volume()
  try {
    await store.makeProgramDir('levels/rooftop')
    await store.putProgram('levels/rooftop/run.ts', 'export const x = 1')
    assert.deepEqual(await store.removeProgramDir('levels/rooftop'), { deleted: 'levels/rooftop' })
    assert.equal(existsSync(path.join(store.programs, 'levels/rooftop')), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
