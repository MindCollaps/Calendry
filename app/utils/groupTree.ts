import type { EntityRow } from '~/utils/manageRegistry';

/**
 * Client-side shaping of the flat `/api/groups` response into a hierarchy.
 *
 * The DATABASE is the authority on the hierarchy: `group_closure` is maintained
 * by a write-time trigger, and reparenting into a descendant is rejected by that
 * trigger with a 409 (migration 20260812000100). Nothing here enforces anything.
 * Its only job is to stop the UI OFFERING a move the database will refuse — a
 * select box that lists impossible choices is a worse experience than one that
 * does not, and both end in the same rejection.
 */
export interface GroupNode {
    row: EntityRow;
    id: string;
    parentId: string | null;
    depth: number;
    children: GroupNode[];
}

function parentOf(row: EntityRow): string | null {
    const value = row.parentGroupId;

    return typeof value === 'string' && value ? value : null;
}

/**
 * Roots first, each with its children nested. Depth is precomputed so rendering
 * is a flat v-for with an indent, rather than a recursive component.
 *
 * Rows whose parent is not in the set become roots. That happens legitimately
 * when a search has matched a child but not its parent, and it is why the tree
 * view refuses to render at all on a partial page — see ManageGroupTree.
 */
export function buildGroupTree(rows: EntityRow[]): GroupNode[] {
    const nodes = new Map<string, GroupNode>();

    for (const row of rows) {
        nodes.set(String(row.id), {
            row,
            id: String(row.id),
            parentId: parentOf(row),
            depth: 0,
            children: [],
        });
    }

    const roots: GroupNode[] = [];

    for (const node of nodes.values()) {
        const parent = node.parentId ? nodes.get(node.parentId) : undefined;

        if (parent) {
            parent.children.push(node);
        } else {
            roots.push(node);
        }
    }

    const byName = (a: GroupNode, b: GroupNode) => String(a.row.name ?? '').localeCompare(String(b.row.name ?? ''));

    const assignDepth = (node: GroupNode, depth: number) => {
        node.depth = depth;
        node.children.sort(byName);
        node.children.forEach((child) => assignDepth(child, depth + 1));
    };

    roots.sort(byName);
    roots.forEach((root) => assignDepth(root, 0));

    return roots;
}

/** Depth-first flattening, so the tree renders as one list with indents. */
export function flattenTree(nodes: GroupNode[], collapsed: Set<string>): GroupNode[] {
    const out: GroupNode[] = [];

    const walk = (node: GroupNode) => {
        out.push(node);

        if (!collapsed.has(node.id)) {
            node.children.forEach(walk);
        }
    };

    nodes.forEach(walk);

    return out;
}

/**
 * A group and everything beneath it.
 *
 * Used to remove impossible parents from the reparent select: a group cannot
 * become its own descendant's child without creating a cycle, which the
 * database trigger rejects with "group % cannot be reparented under %".
 */
export function descendantIds(rows: EntityRow[], id: string): Set<string> {
    const childrenOf = new Map<string, string[]>();

    for (const row of rows) {
        const parent = parentOf(row);

        if (!parent) {
            continue;
        }

        childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), String(row.id)]);
    }

    const out = new Set<string>([id]);
    const queue = [id];

    while (queue.length) {
        const current = queue.shift() as string;

        for (const child of childrenOf.get(current) ?? []) {
            if (!out.has(child)) {
                out.add(child);
                queue.push(child);
            }
        }
    }

    return out;
}

/** Indented labels for a flat select, so nesting survives outside the tree view. */
export function indentedOptions(rows: EntityRow[]): { value: string; label: string }[] {
    return flattenTree(buildGroupTree(rows), new Set()).map((node) => ({
        value: node.id,
        label: `${'  '.repeat(node.depth)}${node.depth ? '└ ' : ''}${node.row.name}`,
    }));
}
