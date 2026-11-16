/**
 * Source labels are free-form: each root names its own, the default is "docs", documents shared outside the
 * roots get drive.sharedSource, and `metadata` decides whether category, customer and tags come from the path.
 * "dev" keeps its 0.3 meaning (frontmatter) and "biz" its (path).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.MCP_CONFIG_JSON = JSON.stringify({
  drive: {
    roots: [
      { id: 'r1', name: 'Handbook', source: 'handbook', metadata: 'frontmatter' },
      { id: 'r2', name: 'Sales', source: 'sales' },
      { id: 'r3', name: 'Unlabelled' },
      { id: 'r4', name: 'Old wiki', source: 'dev' },
      { id: 'r5', name: 'Old files', source: 'biz' },
    ],
    sharedSource: 'team',
    customerFolders: ['Clients'],
  },
});
const { sourceLabels, usesPathMetadata, SHARED_SOURCE } = await import('../src/plugins/drive/settings.js');
const { deriveBizMeta, classifyFile } = await import('../src/plugins/drive/indexer.js');

test('source labels: from the roots, default "docs", plus the shared label', () => {
  assert.deepEqual(sourceLabels(), ['handbook', 'sales', 'docs', 'dev', 'biz', 'team']);
  assert.equal(SHARED_SOURCE, 'team');
});

test('metadata: per root, with "dev" and "biz" keeping their 0.3 meaning', () => {
  assert.equal(usesPathMetadata('handbook'), false);
  assert.equal(usesPathMetadata('sales'), true);
  assert.equal(usesPathMetadata('docs'), true);
  assert.equal(usesPathMetadata('team'), true);
  assert.equal(usesPathMetadata('dev'), false);
  assert.equal(usesPathMetadata('biz'), true);
});

test('path metadata follows the source setting', () => {
  assert.equal(deriveBizMeta('Clients/Acme/proposal.pdf', 'sales').doc_customer, 'Acme');
  assert.equal(deriveBizMeta('Clients/Acme/proposal.pdf', 'team').doc_category, 'Clients');
  assert.equal(deriveBizMeta('Clients/Acme/notes.md', 'handbook').doc_customer, null);
  assert.equal(classifyFile('Guides/setup.md', 'handbook').cluster, 'Guides');
});
