/**
 * The models a provider lists, to pick one from. A long list (OpenRouter has hundreds) gets a box to narrow it.
 * Used by every dialog that connects a model.
 */
import { useState } from 'react';
import { num } from './format';
import { Select } from './ui/select';
import { TextField } from './ui/text-field';

export interface ListedModel {
  id: string;
  name: string;
}

/** More than this, and a box to narrow the list comes first. */
const LONG = 25;
/** The list shows this many at most: type more to narrow it. */
const SHOWN = 200;

export function ModelList({ models, value, onChange, hint, placeholder }: { models: ListedModel[]; value: string; onChange: (id: string) => void; hint?: string; placeholder?: string }) {
  const [filter, setFilter] = useState('');
  const q = filter.trim().toLowerCase();
  const shown = q ? models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(q)) : models;
  return (
    <>
      {models.length > LONG && (
        <TextField label="Find a model" placeholder={placeholder ?? 'Part of its name'} value={filter} onChange={(e) => setFilter(e.target.value)} autoComplete="off" spellCheck={false} />
      )}
      <Select
        label="Model"
        value={value}
        onChange={onChange}
        options={shown.slice(0, SHOWN).map((m) => ({ value: m.id, label: m.name === m.id ? m.id : `${m.name} (${m.id})` }))}
        hint={shown.length > SHOWN ? `${num(shown.length)} match. Type more to narrow the list.` : hint ?? `${num(models.length)} from the provider's own list.`}
      />
    </>
  );
}
