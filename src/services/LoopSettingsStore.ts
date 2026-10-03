import { LoopSettings } from '../models/settings';
import { parseLoopSettings } from '../domain/loopSettings';
import { LOOP_SETTINGS_PATH, LoopFiles } from './ResearchLoopModel';

/**
 * Read and write the local loop policy file. Shared by the extension and the
 * CLI; must not import vscode.
 */

export async function readLoopSettings(files: LoopFiles): Promise<{ settings: LoopSettings; problems: string[]; exists: boolean }> {
  const text = await files.readFile(LOOP_SETTINGS_PATH).catch(() => undefined);
  return { ...parseLoopSettings(text), exists: text !== undefined };
}

export function serializeLoopSettings(settings: LoopSettings): string {
  return JSON.stringify(settings, null, 2) + '\n';
}

/** Write the settings and return the text written, so the caller can recognise its own write. */
export async function writeLoopSettings(files: LoopFiles, settings: LoopSettings): Promise<string> {
  const text = serializeLoopSettings(settings);
  await files.writeFile(LOOP_SETTINGS_PATH, text);
  return text;
}
