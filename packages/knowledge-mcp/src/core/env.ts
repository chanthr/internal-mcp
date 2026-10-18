/** An env value counts as set only when it has non-space content (an empty `FOO=` line in .env is unset). */
export function isSet(v: string | undefined): boolean {
  return !!v && v.trim().length > 0;
}
