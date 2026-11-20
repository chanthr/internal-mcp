/**
 * Skills: instructions an assistant follows for a kind of task, shared with every assistant that uses this server
 * (server: plugins/knowledge/skills.ts). Installed from a GitHub address or a folder on this computer, or written
 * here. Nothing in a skill is run; its text is shown before anyone relies on it.
 */
import { useEffect, useState } from 'react';
import { call } from '../api';
import { AskFirst, Page, Row, Section, useAction, useServer } from '../app';
import { Markdown } from '../markdown';
import { Button } from '../ui/button';
import { Dialog } from '../ui/dialog';
import { TextArea } from '../ui/text-area';
import { TextField } from '../ui/text-field';
import { plural } from '../format';

interface Skill {
  name: string;
  description: string;
  files: string[];
  source: string | null;
}

export function Skills() {
  const { state } = useServer();
  const [skills, setSkills] = useState<Skill[] | null>(null);
  const [from, setFrom] = useState('');
  const [viewing, setViewing] = useState<{ name: string; text: string } | null>(null);
  const [writing, setWriting] = useState(false);
  const install = useAction();
  const view = useAction();
  const load = () => call<{ skills: Skill[] }>('GET', '/skills').then((r) => setSkills(r.skills), () => setSkills([]));
  useEffect(() => void load(), []);

  const open = (name: string) => void view.run(async () => setViewing({ name, text: (await call<{ text: string }>('GET', `/skills/${encodeURIComponent(name)}`)).text }));
  const add = () =>
    void install.run(async () => {
      const r = await call<{ installed: string[]; skills: Skill[] }>('POST', '/skills', { from: from.trim() });
      setSkills(r.skills);
      setFrom('');
      // What was installed is shown at once: its text is what the assistants will read.
      if (r.installed.length === 1) open(r.installed[0]);
    });

  return (
    <Page title="Skills" text="Instructions an assistant follows for a kind of task: a note format, a report, a way of studying. Every assistant that uses this server can read them; nothing in them is run.">
      <Section title="Add a skill" text="A skill is a folder with SKILL.md. Install the ones you trust: an assistant follows what they say.">
        <div className="stack">
          <TextField
            label="GitHub address or folder on this computer"
            placeholder="https://github.com/owner/repo/tree/main/skills/notes"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
          <div className="actions">
            <Button size="sm" loading={install.busy} disabled={!state.editable || from.trim().length < 3} onClick={add}>Install</Button>
            <Button size="sm" variant="ghost" disabled={!state.editable} onClick={() => setWriting(true)}>Write one</Button>
          </div>
          {install.error && <p className="error" role="alert">{install.error}</p>}
        </div>
      </Section>
      <Section title="Installed" text={skills && skills.length ? `${plural(skills.length, 'skill')}. Assistants are told their names and what each is for, and read one when a task calls for it.` : undefined}>
        <div className="rows">
          {skills?.length === 0 && <Row title="No skills yet" help="Install one above, or write one." />}
          {skills?.map((s) => (
            <Row key={s.name} title={s.name} help={<>{s.description}<span className="row-note">{plural(s.files.length + 1, 'file')}{s.source ? ` · ${s.source}` : ''}</span></>}>
              <Button size="sm" variant="secondary" loading={view.busy && viewing === null} onClick={() => open(s.name)}>View</Button>
              <AskFirst
                label="Remove"
                title={`Remove ${s.name}?`}
                text="Its folder is deleted from skills/ on this computer. Assistants no longer see it."
                confirm="Remove"
                disabled={!state.editable}
                onConfirm={async () => setSkills((await call<{ skills: Skill[] }>('DELETE', `/skills/${encodeURIComponent(s.name)}`)).skills)}
              />
            </Row>
          ))}
        </div>
        {view.error && <p className="error" role="alert">{view.error}</p>}
      </Section>
      {viewing && (
        <Dialog open onOpenChange={(o) => !o && setViewing(null)} title={viewing.name} description="What an assistant reads when it uses this skill." footer={<Button variant="ghost" onClick={() => setViewing(null)}>Close</Button>}>
          <div className="md skill-text">
            <Markdown text={viewing.text.replace(/^---[\s\S]*?\n---\n?/, '')} />
          </div>
        </Dialog>
      )}
      {writing && <WriteSkill onClose={() => setWriting(false)} onDone={(list) => (setSkills(list), setWriting(false))} />}
    </Page>
  );
}

/** A skill written here: a name, when to use it, and the instructions. */
function WriteSkill({ onClose, onDone }: { onClose: () => void; onDone: (skills: Skill[]) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [body, setBody] = useState('');
  const save = useAction();
  return (
    <Dialog
      open
      onOpenChange={(o) => !o && onClose()}
      title="Write a skill"
      description="Saved as skills/<name>/SKILL.md on this computer."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            loading={save.busy}
            disabled={!name.trim() || !description.trim() || !body.trim()}
            onClick={() => void save.run(async () => onDone((await call<{ skills: Skill[] }>('POST', '/skills', { name, description, body })).skills))}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="stack">
        <TextField label="Name" placeholder="lecture-notes" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" />
        <TextField label="When to use it" placeholder="Making study notes from lecture slides" value={description} onChange={(e) => setDescription(e.target.value)} autoComplete="off" />
        <TextArea label="Instructions" placeholder={'## How to make the notes\n\n1. …'} value={body} onChange={(e) => setBody(e.target.value)} minRows={8} maxRows={18} />
        {save.error && <p className="error" role="alert">{save.error}</p>}
      </div>
    </Dialog>
  );
}
