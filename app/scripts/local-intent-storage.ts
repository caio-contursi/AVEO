import { randomUUID } from 'node:crypto'
import { closeSync, constants, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { MAX_SUBMISSION_INTENT_BYTES, SUBMISSION_INTENT_STORAGE_KEY, type SubmissionIntentStorage } from '../src/features/operations/submission-intent'

const failure = () => new Error('Isolated submission-intent storage is unavailable.')

function directoryOf(file: string): string {
  const directory = path.dirname(file)
  const relative = path.relative(realpathSync(tmpdir()), directory)
  if (!path.isAbsolute(file) || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ||
      realpathSync(directory) !== directory || !lstatSync(directory).isDirectory() || (lstatSync(directory).mode & 0o077) !== 0 ||
      !/^local-intent-[a-f0-9-]{36}\.json$/.test(path.basename(file))) throw failure()
  return directory
}

/** Private synthetic-test metadata only. Native browser Web Locks are not emulated here. */
export function openLocalIntentStorage(file: string): SubmissionIntentStorage {
  try {
    directoryOf(file)
    const original = lstatSync(file)
    if (!original.isFile() || original.isSymbolicLink() || original.nlink !== 1 || (original.mode & 0o077) !== 0) throw failure()
    function access<T>(key: string, flags: number, operation: (fd: number) => T): T {
      if (key !== SUBMISSION_INTENT_STORAGE_KEY) throw failure()
      let fd: number | undefined
      try {
        fd = openSync(file, flags | constants.O_NOFOLLOW)
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.dev !== original.dev || stat.ino !== original.ino || stat.nlink !== 1 ||
            (stat.mode & 0o077) !== 0 || stat.size > MAX_SUBMISSION_INTENT_BYTES) throw failure()
        return operation(fd)
      } catch { throw failure() } finally { if (fd !== undefined) closeSync(fd) }
    }
    return {
      getItem: (key) => access(key, constants.O_RDONLY, (fd) => {
        const raw = readFileSync(fd, 'utf8')
        if (Buffer.byteLength(raw) > MAX_SUBMISSION_INTENT_BYTES) throw failure()
        return raw
      }),
      setItem: (key, value) => {
        if (typeof value !== 'string' || Buffer.byteLength(value) > MAX_SUBMISSION_INTENT_BYTES) throw failure()
        access(key, constants.O_RDWR, (fd) => {
          // A partial write remains invalid/blocked on reopening, never an empty record.
          ftruncateSync(fd, 0)
          writeFileSync(fd, value, 'utf8')
          fsyncSync(fd)
        })
      },
    }
  } catch { throw failure() }
}

export function createLocalIntentStorage(directory: string): { file: string; storage: SubmissionIntentStorage } {
  const file = path.join(directory, `local-intent-${randomUUID()}.json`)
  try {
    directoryOf(file)
    writeFileSync(file, 'null', { flag: 'wx', mode: 0o600 })
    return { file, storage: openLocalIntentStorage(file) }
  } catch { throw failure() }
}
