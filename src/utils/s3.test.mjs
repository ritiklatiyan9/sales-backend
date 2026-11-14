import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PGlite } from '@electric-sql/pglite';

// Nothing leaves this process: S3 is blanked before s3.js loads, its local fallback writes
// under <cwd>/src/uploads (cwd moves to a throwaway directory, which also keeps the project
// .env out), and the shared pool answers from an in-memory PGlite documents table.
const repoDir = process.cwd();
const workDir = mkdtempSync(path.join(tmpdir(), 's3-delete-guard-'));
process.chdir(workDir);
Object.assign(process.env, { AWS_ACCESS_KEY_ID: '', AWS_SECRET_ACCESS_KEY: '' });
const { default: pool } = await import('../config/db.js');
const { deleteKycDocument } = await import('./s3.js');
test.after(() => { process.chdir(repoDir); rmSync(workDir, { recursive: true, force: true }); });

test('a stored file is deleted only once no documents row references it', async () => {
  const db = new PGlite();
  await db.exec(`CREATE TABLE documents (id SERIAL PRIMARY KEY, file_path TEXT);
    INSERT INTO documents (file_path) VALUES ('local::shared.jpg'), ('local::shared.jpg');`);
  const original = pool.query;
  pool.query = (sql, values) => db.query(sql, values);
  const file = (name) => path.join(workDir, 'src', 'uploads', name);
  try {
    for (const name of ['shared.jpg', 'orphan.jpg']) writeFileSync(file(name), 'bytes');
    await deleteKycDocument('local::shared.jpg');
    await deleteKycDocument('local::orphan.jpg');
    assert.ok(existsSync(file('shared.jpg')), 'a file another row still references is kept');
    assert.ok(!existsSync(file('orphan.jpg')), 'an unreferenced file is deleted');

    await db.query("DELETE FROM documents WHERE file_path = 'local::shared.jpg'");
    await deleteKycDocument('local::shared.jpg');
    assert.ok(!existsSync(file('shared.jpg')), 'the file goes once its last row is gone');
  } finally {
    pool.query = original;
    await db.close();
  }
});
