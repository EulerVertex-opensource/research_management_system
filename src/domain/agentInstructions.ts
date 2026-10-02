export const GENERATED_START = '<!-- research-assistant:generated:start -->';
export const GENERATED_END = '<!-- research-assistant:generated:end -->';

/** Replace the marked generated section, keeping everything the researcher wrote around it; append one if missing. */
export function upsertGeneratedSection(existing: string, generated: string): string {
  const section = `${GENERATED_START}\n${generated.trim()}\n${GENERATED_END}`;
  const start = existing.indexOf(GENERATED_START);
  const end = existing.indexOf(GENERATED_END);
  if (start !== -1 && end > start) {
    return existing.slice(0, start) + section + existing.slice(end + GENERATED_END.length);
  }
  return existing.trim() ? `${existing.trimEnd()}\n\n${section}\n` : `${section}\n`;
}

/**
 * The guidance now lives only in AGENTS.md, which Claude Code reads natively,
 * but only when no CLAUDE.md exists. So an existing CLAUDE.md either goes away
 * (it held nothing but our generated copy) or keeps the researcher's own text
 * and imports AGENTS.md instead of duplicating it. Returns null to delete.
 */
export function claudeMdForAgentsMd(existing: string): string | null {
  const start = existing.indexOf(GENERATED_START);
  const end = existing.indexOf(GENERATED_END);
  const own = start !== -1 && end > start ? existing.slice(0, start) + existing.slice(end + GENERATED_END.length) : existing;
  if (!own.trim()) return null;
  if (/^@(\.\/)?AGENTS\.md\s*$/m.test(own)) return start !== -1 && end > start ? `${own.trim()}\n` : existing;
  return upsertGeneratedSection(existing, '@AGENTS.md');
}
