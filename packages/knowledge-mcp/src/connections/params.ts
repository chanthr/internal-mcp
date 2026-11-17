/**
 * Turns the `params` of a declared tool into the zod schema the server validates calls with (and from which the
 * model sees each parameter's type, bounds and description).
 */
import { z } from 'zod';
import { isOptional, type ParamSpec } from './schema.js';

const DEFAULT_MAX_LENGTH = 2000;

function one(spec: ParamSpec): z.ZodType {
  let s: z.ZodType;
  if (spec.type === 'string') {
    if (spec.enum) s = z.enum(spec.enum as [string, ...string[]]);
    else {
      let str = z.string().max(spec.maxLength ?? DEFAULT_MAX_LENGTH);
      if (spec.pattern) str = str.regex(new RegExp(spec.pattern));
      s = str;
    }
  } else if (spec.type === 'boolean') {
    s = z.boolean();
  } else {
    let num = spec.type === 'integer' ? z.number().int() : z.number();
    if (spec.min !== undefined) num = num.min(spec.min);
    if (spec.max !== undefined) num = num.max(spec.max);
    s = num;
  }
  if (spec.default !== undefined) s = s.default(spec.default as never);
  else if (isOptional(spec)) s = s.optional();
  return spec.description ? s.describe(spec.description) : s;
}

/** zod object for a tool's arguments. Unknown arguments are rejected, so a misspelled name is reported. */
export function inputSchemaFor(params: Record<string, ParamSpec>) {
  const shape: Record<string, z.ZodType> = {};
  for (const [name, spec] of Object.entries(params)) shape[name] = one(spec);
  return z.object(shape).strict();
}
