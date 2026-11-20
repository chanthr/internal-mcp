/**
 * use_skill: read a skill installed on this server (skills.ts): instructions for a kind of task, and the files they
 * refer to. Without a name it lists the skills with what each is for, so an assistant can pick one.
 *
 * Listed only while a skill is installed.
 */
import { z } from 'zod';
import { defineTool } from '../../../plugin/define.js';
import { listSkills, oneLine, readSkill } from '../skills.js';

const DESCRIPTION =
  'Read a skill: instructions installed on this server for a kind of task (a note format, a report, a way of studying). ' +
  'Without a name it lists the skills and what each is for. With a name it returns the instructions (SKILL.md); with file, ' +
  'a file the instructions refer to. Follow a skill when the task is the kind it is for.';

const inputSchema = z.object({
  name: z.string().max(80).optional().describe('The skill. Leave out to list them.'),
  file: z.string().max(300).optional().describe('A file of the skill, as SKILL.md names it.'),
});

export const useSkillTool = defineTool({
  name: 'use_skill',
  description: DESCRIPTION,
  input: inputSchema,
  annotations: { readOnlyHint: true },
  enabled: () => listSkills().length > 0 || 'install a skill on the Skills page',
  run: (args) => {
    try {
      if (!args.name) {
        const skills = listSkills();
        return { content: [{ type: 'text' as const, text: `${skills.length} skill${skills.length === 1 ? '' : 's'}:\n${skills.map((s) => `- ${s.name}: ${oneLine(s.description, 300)}`).join('\n')}` }] };
      }
      const skill = listSkills().find((s) => s.name === args.name);
      const text = readSkill(args.name, args.file);
      const files = !args.file && skill?.files.length ? `\n\n---\nFiles of this skill (read one with file): ${skill.files.slice(0, 50).join(', ')}` : '';
      return { content: [{ type: 'text' as const, text: `${text}${files}` }] };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: `[error] ${e instanceof Error ? e.message : String(e)}` }], isError: true };
    }
  },
});
