import { FileService } from './FileService';
import { computeAssetOrder, AssetOrderResult } from './AssetOrder';

export async function orderAssets(fileService: FileService, folder: string, kind: 'asset' | 'definition' = 'asset'): Promise<AssetOrderResult> {
  const paths = (await fileService.listFiles(folder, '.md')).sort();
  const inputs = await Promise.all(paths.map(async (filePath) => ({
    id: filePath.slice(filePath.lastIndexOf('/') + 1, -3),
    raw: await fileService.readFile(filePath),
  })));
  const result = computeAssetOrder(inputs, kind);
  for (const change of result.changes) {
    await fileService.writeFile(`${folder}/${change.id}.md`, change.raw);
  }
  return result;
}
