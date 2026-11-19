/**
 * Search: how documents are cut into passages and how well search finds them (Passages), and the links between
 * documents (Links).
 */
import { Page, Tabs } from '../app';
import { GraphView } from './graph';
import { Passages } from './passages';

export function Search() {
  return (
    <Page title="Search" text="How the assistant finds what your documents say.">
      <Tabs
        label="Search"
        tabs={[
          { value: 'passages', label: 'Passages' },
          { value: 'links', label: 'Links between documents' },
        ]}
      >
        {(tab) => (tab === 'passages' ? <Passages /> : <GraphView />)}
      </Tabs>
    </Page>
  );
}
