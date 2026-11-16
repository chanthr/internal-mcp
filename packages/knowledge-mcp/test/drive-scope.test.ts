/**
 * Drive scope: documents shared with the service account are visible outside the roots (drive.scope "shared"),
 * excluded folders stay hidden wherever they are, a failed folder lookup hides the file, and DRIVE_SCOPE=roots
 * restores the roots-only behaviour. Also: picture data is stripped from exported Google Docs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MCP_CONFIG_JSON = JSON.stringify({
  drive: { roots: [{ id: 'root1', name: 'Docs', source: 'biz' }], excludeFolders: ['HR'] },
});

const { classifyAndPath, classifyFolder, clearFolderMetaCache } = await import('../src/plugins/drive/path.js');
const { stripEmbeddedImages } = await import('../src/plugins/drive/clean_text.js');
type Drive = Parameters<typeof classifyAndPath>[0];

/** Folder id → { name, parents }. Ids starting with "ERR" fail like a transient Drive error. */
function fakeDrive(folders: Record<string, { name: string; parents?: string[] }>): Drive {
  return {
    files: {
      get: async ({ fileId }: { fileId: string }) => {
        if (fileId.startsWith('ERR')) throw new Error('[drive] 500 backendError');
        const f = folders[fileId];
        if (!f) throw new Error('[drive] 404 File not found');
        return { data: { name: f.name, parents: f.parents } };
      },
    },
  } as unknown as Drive;
}

const drive = fakeDrive({
  clients: { name: 'Clients', parents: ['root1'] },
  acme: { name: 'Acme', parents: ['clients'] },
  hr: { name: 'HR', parents: ['root1'] },
  hr2026: { name: '2026', parents: ['hr'] },
  team: { name: 'Team handbook' }, // shared as a folder, outside the roots
  onboarding: { name: 'Onboarding', parents: ['team'] },
  teamHr: { name: 'HR', parents: ['team'] },
  hrTop: { name: 'HR' }, // an excluded name shared on its own
  underErr: { name: 'Sub', parents: ['ERR_parent'] },
  ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`deep${i}`, { name: `d${i}`, parents: [`deep${i + 1}`] }])),
});

test('scope: under a root is ok, with the path starting right under the root', async () => {
  assert.deepEqual(await classifyAndPath(drive, ['acme']), { cls: 'ok', path: 'Clients/Acme' });
  assert.deepEqual(await classifyAndPath(drive, ['root1']), { cls: 'ok', path: '' });
});

test('scope: shared outside the roots is visible, with the path starting at the shared folder', async () => {
  assert.deepEqual(await classifyAndPath(drive, undefined), { cls: 'shared', path: '' });
  assert.deepEqual(await classifyAndPath(drive, ['onboarding']), { cls: 'shared', path: 'Team handbook/Onboarding' });
  assert.deepEqual(await classifyFolder(drive, 'onboarding'), { cls: 'shared', path: 'Team handbook/Onboarding' });
});

test('scope: excluded folders stay hidden under a root, inside a shared folder and when shared on their own', async () => {
  assert.equal((await classifyAndPath(drive, ['hr2026'])).cls, 'excluded');
  assert.equal((await classifyAndPath(drive, ['teamHr'])).cls, 'excluded');
  assert.equal((await classifyAndPath(drive, ['hrTop'])).cls, 'excluded');
  assert.equal((await classifyFolder(drive, 'hrTop')).cls, 'excluded');
});

test('scope: a failed folder lookup or a chain deeper than 12 hides the file', async () => {
  assert.equal((await classifyAndPath(drive, ['underErr'])).cls, 'outside');
  assert.equal((await classifyAndPath(drive, ['ERR_direct'])).cls, 'outside');
  assert.equal((await classifyAndPath(drive, ['deep0'])).cls, 'outside');
});

test('scope: DRIVE_SCOPE=roots hides shared documents and keeps the roots', async () => {
  clearFolderMetaCache();
  process.env.DRIVE_SCOPE = 'roots';
  try {
    assert.equal((await classifyAndPath(drive, ['onboarding'])).cls, 'outside');
    assert.equal((await classifyAndPath(drive, undefined)).cls, 'outside');
    assert.equal((await classifyAndPath(drive, ['acme'])).cls, 'ok');
  } finally {
    delete process.env.DRIVE_SCOPE;
  }
});

test('stripEmbeddedImages: removes base64 definitions and their references, keeps everything else', () => {
  const b64 = 'A'.repeat(5000);
  const md = [
    'First line ![][image1] continues',
    'Linked ![alt](https://example.com/a.png) stays',
    'Other ref ![][other] stays',
    `Inline ![x](data:image/png;base64,${b64}) end`,
    '',
    `[image1]: <data:image/png;base64,${b64}>`,
    '[other]: https://example.com/b.png',
  ].join('\n');
  const out = stripEmbeddedImages(md);
  assert.ok(!out.includes('base64') && out.length < 300, `${md.length} → ${out.length}`);
  assert.ok(!out.includes('![][image1]') && out.includes('![][other]') && out.includes('[other]: https://'));
  assert.ok(out.includes('![alt](https://example.com/a.png)') && out.includes('First line') && out.includes('continues'));
  assert.equal(stripEmbeddedImages('plain\n\n\n\ntext'), 'plain\n\n\n\ntext');
});
