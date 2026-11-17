/**
 * Drive scope: documents shared with the service account by a trusted owner are visible outside the roots
 * (drive.scope "shared" + drive.trustedOwners), anything shared by someone else stays hidden, excluded folders stay
 * hidden wherever they are, a failed folder lookup hides the file, and DRIVE_SCOPE=roots restores the roots-only
 * behaviour. Also: picture data is stripped from exported Google Docs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MCP_CONFIG_JSON = JSON.stringify({
  drive: { roots: [{ id: 'root1', name: 'Docs', source: 'biz' }], excludeFolders: ['HR'], trustedOwners: ['acme.com', 'ann@gmail.com', 'drive:TEAMDRIVE'] },
});

const { classifyAndPath, classifyFolder, clearFolderMetaCache } = await import('../src/plugins/drive/path.js');
const { stripEmbeddedImages } = await import('../src/plugins/drive/clean_text.js');
type Drive = Parameters<typeof classifyAndPath>[0];

/** Folder id → { name, parents }. Ids starting with "ERR" fail like a transient Drive error. */
type Folder = { name: string; parents?: string[]; owner?: string; driveId?: string };
function fakeDrive(folders: Record<string, Folder>): Drive {
  return {
    files: {
      get: async ({ fileId }: { fileId: string }) => {
        if (fileId.startsWith('ERR')) throw new Error('[drive] 500 backendError');
        const f = folders[fileId];
        if (!f) throw new Error('[drive] 404 File not found');
        return { data: { name: f.name, parents: f.parents, owners: f.owner ? [{ emailAddress: f.owner }] : [], driveId: f.driveId } };
      },
    },
  } as unknown as Drive;
}

const drive = fakeDrive({
  clients: { name: 'Clients', parents: ['root1'] },
  acme: { name: 'Acme', parents: ['clients'] },
  hr: { name: 'HR', parents: ['root1'] },
  hr2026: { name: '2026', parents: ['hr'] },
  team: { name: 'Team handbook', owner: 'boss@acme.com' }, // shared as a folder by a trusted domain, outside the roots
  stranger: { name: 'Company policy', owner: 'mallory@evil.example' }, // shared by someone nobody listed
  strangerSub: { name: 'Sub', parents: ['stranger'] },
  otherGmail: { name: 'Notes', owner: 'bob@gmail.com' }, // same mail provider as a trusted address, different person
  teamDrive: { name: 'Team drive', driveId: 'TEAMDRIVE' }, // a shared drive root: no owner
  otherDrive: { name: 'Their drive', driveId: 'OTHERDRIVE' },
  onboarding: { name: 'Onboarding', parents: ['team'] },
  teamHr: { name: 'HR', parents: ['team'] },
  hrTop: { name: 'HR', owner: 'boss@acme.com' }, // an excluded name shared on its own
  underErr: { name: 'Sub', parents: ['ERR_parent'] },
  ...Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`deep${i}`, { name: `d${i}`, parents: [`deep${i + 1}`] }])),
});

test('scope: under a root is ok, with the path starting right under the root', async () => {
  assert.deepEqual(await classifyAndPath(drive, ['acme']), { cls: 'ok', path: 'Clients/Acme' });
  assert.deepEqual(await classifyAndPath(drive, ['root1']), { cls: 'ok', path: '' });
});

test('scope: shared outside the roots is visible, with the path starting at the shared folder', async () => {
  assert.deepEqual(await classifyAndPath(drive, undefined, { owners: ['ann@gmail.com'] }), { cls: 'shared', path: '' });
  assert.deepEqual(await classifyAndPath(drive, ['teamDrive']), { cls: 'shared', path: 'Team drive' });
  assert.deepEqual(await classifyAndPath(drive, ['onboarding']), { cls: 'shared', path: 'Team handbook/Onboarding' });
  assert.deepEqual(await classifyFolder(drive, 'onboarding'), { cls: 'shared', path: 'Team handbook/Onboarding' });
});

test('scope: a document shared by an owner who is not trusted stays hidden', async () => {
  assert.equal((await classifyAndPath(drive, undefined, { owners: ['mallory@evil.example'] })).cls, 'outside');
  assert.equal((await classifyAndPath(drive, undefined)).cls, 'outside'); // owner unknown
  assert.equal((await classifyAndPath(drive, ['strangerSub'])).cls, 'outside');
  assert.equal((await classifyFolder(drive, 'stranger')).cls, 'outside');
  assert.equal((await classifyAndPath(drive, ['otherGmail'])).cls, 'outside');
  assert.equal((await classifyAndPath(drive, ['otherDrive'])).cls, 'outside');
  // The file's own owner does not matter inside a share: the top of the share decides.
  assert.equal((await classifyAndPath(drive, ['onboarding'], { owners: ['mallory@evil.example'] })).cls, 'shared');
  assert.equal((await classifyAndPath(drive, ['strangerSub'], { owners: ['boss@acme.com'] })).cls, 'outside');
});

test('trust entries: email, domain, shared drive, everyone; a public mail domain is refused', async () => {
  const { ownerMatches, isTrusted, trustEntryFor, validTrustEntry } = await import('../src/plugins/drive/trust.js');
  assert.equal(ownerMatches('acme.com', ['Ann@Acme.com']), true);
  assert.equal(ownerMatches('@acme.com', ['ann@acme.com']), true);
  assert.equal(ownerMatches('acme.com', ['ann@notacme.com']), false);
  assert.equal(ownerMatches('acme.com', ['ann@acme.com.evil.example']), false);
  assert.equal(ownerMatches('ann@gmail.com', ['bob@gmail.com']), false);
  assert.equal(ownerMatches('drive:ABC', [], 'abc'), true);
  assert.equal(ownerMatches('*', []), true);
  assert.equal(isTrusted([], ['ann@acme.com']), false);
  assert.equal(trustEntryFor('Ann@Acme.com'), 'acme.com');
  assert.equal(trustEntryFor('bob@gmail.com'), 'bob@gmail.com');
  assert.equal(trustEntryFor('sa@proj.iam.gserviceaccount.com'), null);
  assert.equal(validTrustEntry('acme.com'), true);
  assert.equal(validTrustEntry('drive:0ABcd_-9'), true);
  assert.match(String(validTrustEntry('gmail.com')), /public mail provider/);
  assert.match(String(validTrustEntry('not an entry')), /not an email/);
});

test('trust: with no trusted owner nothing outside the roots is shown', async () => {
  clearFolderMetaCache();
  process.env.DRIVE_TRUSTED_OWNERS = '';
  try {
    assert.equal((await classifyAndPath(drive, ['onboarding'])).cls, 'outside');
    assert.equal((await classifyAndPath(drive, ['acme'])).cls, 'ok');
  } finally {
    delete process.env.DRIVE_TRUSTED_OWNERS;
  }
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
    assert.equal((await classifyAndPath(drive, undefined, { owners: ['ann@gmail.com'] })).cls, 'outside');
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
