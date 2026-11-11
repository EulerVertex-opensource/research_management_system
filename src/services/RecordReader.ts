import * as path from 'path';
import { sharedFolders } from './ResearchLoopModel';
import { DecisionInfo, IdeaUpdate, LOG_EXTENSION, decisionFromRecord, ideaUpdatesOf, parseDecision, parseLog } from './ResearchRecords';

/** What reading the shared records needs: listing a folder and reading a file. */
export interface RecordFiles {
  listFiles(folder: string, extension?: string): Promise<string[]>;
  readFile(file: string): Promise<string>;
}

/** Every decision: from the collaborators' record logs, and from decision files written before them. */
export async function readDecisions(files: RecordFiles, researchRoot: string): Promise<DecisionInfo[]> {
  const shared = sharedFolders(researchRoot);
  const result: DecisionInfo[] = [];
  for (const file of await files.listFiles(shared.decisions).catch(() => [] as string[])) {
    const info = parseDecision(path.posix.basename(file, '.md'), await files.readFile(file).catch(() => ''));
    if (info) result.push(info);
  }
  for (const file of await files.listFiles(shared.log, LOG_EXTENSION).catch(() => [] as string[])) {
    for (const record of parseLog(await files.readFile(file).catch(() => ''))) {
      const info = record.type === 'decision' ? decisionFromRecord(record) : undefined;
      if (info) result.push(info);
    }
  }
  return result;
}

/** The updates to each idea, oldest first, to apply over its file (overlayIdea). */
export async function readIdeaUpdates(files: RecordFiles, researchRoot: string): Promise<Map<string, IdeaUpdate[]>> {
  return ideaUpdatesOf(await readDecisions(files, researchRoot));
}
