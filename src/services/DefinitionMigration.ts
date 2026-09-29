import { parseMarkdown, stringifyMarkdown } from './Frontmatter';
import { AssetInput, computeAssetOrder, AssetOrderResult } from './AssetOrder';

export interface DefinitionMigrationPlan {
  moved: AssetInput[];
  updatedAssets: AssetInput[];
  assetOrder: AssetOrderResult;
  definitionOrder: AssetOrderResult;
  review: string[];
}

/** Plan all changes and validate both dependency graphs before touching files. */
export function planDefinitionMigration(assets: AssetInput[], definitions: AssetInput[], ideas: AssetInput[] = []): DefinitionMigrationPlan {
  const definitionIds = new Set(definitions.map((item) => item.id));
  const moved = assets.filter((item) => parseMarkdown(item.raw).data.type === 'definition');
  const movedIds = new Set(moved.map((item) => item.id));
  const remainingAssetIds = new Set(assets.filter((item) => !movedIds.has(item.id)).map((item) => item.id));
  for (const item of definitions) {
    if (remainingAssetIds.has(item.id) || ideas.some((idea) => idea.id === item.id)) {
      throw new Error(`Definition ID collision with another node: ${item.id}`);
    }
  }
  for (const item of moved) {
    if (definitionIds.has(item.id)) throw new Error(`Definition ID collision: ${item.id}`);
    if (ideas.some((idea) => idea.id === item.id)) throw new Error(`Definition ID collision with idea: ${item.id}`);
  }
  const allDefinitionIds = new Set([...definitionIds, ...movedIds]);
  const review: string[] = [];
  const migratedDefinitions = moved.map((item) => {
    const parsed = parseMarkdown(item.raw);
    const dependencies = Array.isArray(parsed.data.depends_on) ? parsed.data.depends_on as string[] : [];
    for (const id of dependencies) {
      if (!allDefinitionIds.has(id)) throw new Error(`${item.id}.md has a dependency on non-definition ${id}; review it before migration`);
    }
    return item;
  });
  const updatedAssets = assets.filter((item) => !movedIds.has(item.id)).map((item) => {
    const parsed = parseMarkdown(item.raw);
    const dependencies = Array.isArray(parsed.data.depends_on) ? parsed.data.depends_on as string[] : [];
    const uses = Array.isArray(parsed.data.uses_definitions) ? parsed.data.uses_definitions as string[] : [];
    const converted = dependencies.filter((id) => allDefinitionIds.has(id));
    if (converted.length) {
      parsed.data.depends_on = dependencies.filter((id) => !allDefinitionIds.has(id));
      parsed.data.uses_definitions = [...new Set([...uses, ...converted])];
      if (parsed.data.status === 'approved') review.push(`${item.id}.md: review added definition links ${converted.join(', ')}; approval retained`);
    }
    for (const id of parsed.data.uses_definitions ?? []) {
      if (!allDefinitionIds.has(id)) throw new Error(`${item.id}.md uses unknown definition ${id}`);
    }
    return { id: item.id, raw: converted.length ? stringifyMarkdown(parsed.content, parsed.data) : item.raw };
  });
  for (const item of ideas) {
    const related = parseMarkdown(item.raw).data.related_assets;
    if (Array.isArray(related) && related.some((id) => movedIds.has(id))) {
      review.push(`${item.id}.md: related_assets references a moved definition; review its meaning`);
    }
  }
  // Both dependency graphs must stay valid (no missing, inactive, or cyclic links) after the move.
  const assetOrder = computeAssetOrder(updatedAssets);
  const definitionOrder = computeAssetOrder([...definitions, ...migratedDefinitions], 'definition');
  return { moved, updatedAssets, assetOrder, definitionOrder, review };
}
