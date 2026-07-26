import { lineMatchesFilter } from './codeFilter';
import type {
  AtlasNode,
  CallHierarchyLocation,
  CallHierarchyTarget,
  CodeFilter,
} from './types';

export function callLocationKey(location: CallHierarchyLocation) {
  return `${location.filePath}:${location.line}:${location.column}`;
}

export function aggregateCallTargets(targets: CallHierarchyTarget[]): CallHierarchyTarget[] {
  const aggregated = new Map<string, CallHierarchyTarget>();
  for (const target of targets) {
    const key = `${target.name}:${callLocationKey(target.declaration)}`;
    const existing = aggregated.get(key);
    if (!existing) {
      aggregated.set(key, {
        ...target,
        callSites: [...target.callSites],
      });
      continue;
    }
    const seen = new Set(existing.callSites.map(callLocationKey));
    for (const callSite of target.callSites) {
      const siteKey = callLocationKey(callSite);
      if (!seen.has(siteKey)) {
        existing.callSites.push(callSite);
        seen.add(siteKey);
      }
    }
  }
  return [...aggregated.values()];
}

export function filterCallTargets(
  targets: CallHierarchyTarget[],
  nodesByPath: ReadonlyMap<string, AtlasNode>,
  codeFilter: CodeFilter,
): CallHierarchyTarget[] {
  return aggregateCallTargets(targets).flatMap((target) => {
    const callSites = target.callSites.filter((location) => {
      if (codeFilter === 'all') return true;
      const node = nodesByPath.get(location.filePath);
      if (!node) return codeFilter === 'no-tests';
      return lineMatchesFilter(node, location.line, codeFilter);
    });
    if (codeFilter !== 'all' && callSites.length === 0) return [];
    return [{ ...target, callSites }];
  });
}
