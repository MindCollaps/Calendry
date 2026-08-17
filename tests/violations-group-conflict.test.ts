import { describe, expect, it } from 'vitest';
import { describeCollision } from '../server/utils/violations';

/**
 * Nested-group conflict detection — the sibling false positive.
 *
 * `describeCollision` used to intersect the EXPANDED conflict closure of both
 * Sessions. Every group expands to include its ancestors, so two groups sharing
 * any common ancestor always intersected at that ancestor, however distantly
 * related they were. Against real demo data that produced 24 phantom
 * `group_double_booked` violations on a timetable the solver reported as clean.
 *
 * The rule (TAXONOMY.md §6) is that a Session blocks its group's ANCESTORS and
 * DESCENDANTS — not everything under a shared root. So exactly one side is
 * expanded, and it is matched against the other side's DIRECTLY assigned groups
 * by identity.
 *
 * The tree used throughout is the demo tenant's, which is where this was found:
 *
 *     Informatics 2026
 *     ├── Class A
 *     │   └── Seminar A1
 *     └── Class B
 */
const INFORMATICS = 'g-informatics';
const CLASS_A = 'g-class-a';
const CLASS_B = 'g-class-b';
const SEMINAR_A1 = 'g-seminar-a1';

/** self ∪ ancestors ∪ descendants — what `conflictGroupIds()` returns. */
const CLOSURE: Record<string, string[]> = {
    [INFORMATICS]: [INFORMATICS, CLASS_A, CLASS_B, SEMINAR_A1],
    [CLASS_A]: [CLASS_A, INFORMATICS, SEMINAR_A1],
    [CLASS_B]: [CLASS_B, INFORMATICS],
    [SEMINAR_A1]: [SEMINAR_A1, CLASS_A, INFORMATICS],
};

function session(id: string) {
    return {
        id,
        tenantId: 't',
        termId: 'term',
        kindId: 'kind',
        offeringId: `off-${id}`,
        termWeek: 1,
        dayOfWeek: 1,
        blockIndex: 0,
        durationBlocks: 1,
    };
}

/** Two overlapping Sessions, each with its directly assigned groups. */
function collide(groupsA: string[], groupsB: string[]) {
    const a = session('a');
    const b = session('b');

    const byGroup = new Map([[a.id, groupsA], [b.id, groupsB]]);

    const conflictSets = new Map(
        [[a.id, groupsA], [b.id, groupsB]].map(([id, groups]) => [
            id as string,
            new Set((groups as string[]).flatMap((g) => CLOSURE[g] ?? [g])),
        ]),
    );

    return describeCollision('no_double_booking_group', a, b, {
        byRoom: new Map(),
        byPerson: new Map(),
        byGroup,
        conflictSets,
    });
}

describe('no_double_booking_group', () => {
    it('does NOT flag two groups whose only relationship is a shared ancestor', () => {
        // The regression. Seminar A1 is under Class A; Class B is its uncle.
        // Neither is an ancestor or descendant of the other and no person is in
        // both, so booking them at the same time is legitimate.
        expect(collide([SEMINAR_A1], [CLASS_B])).toBeNull();
    });

    it('does NOT flag two siblings directly under the same parent', () => {
        expect(collide([CLASS_A], [CLASS_B])).toBeNull();
    });

    it('flags a parent against its direct child', () => {
        const result = collide([CLASS_A], [SEMINAR_A1]);

        expect(result).not.toBeNull();
        expect(result).toMatchObject({ reason: 'group_double_booked', groupIds: [SEMINAR_A1] });
    });

    it('flags a child against its parent — detection is symmetric', () => {
        // Only one side is expanded, so this direction is worth pinning
        // separately: the reported ids differ, the verdict must not.
        const result = collide([SEMINAR_A1], [CLASS_A]);

        expect(result).not.toBeNull();
        expect(result).toMatchObject({ reason: 'group_double_booked', groupIds: [CLASS_A] });
    });

    it('flags a distant ancestor against a deep descendant', () => {
        expect(collide([INFORMATICS], [SEMINAR_A1])).not.toBeNull();
        expect(collide([SEMINAR_A1], [INFORMATICS])).not.toBeNull();
    });

    it('flags the same group booked twice', () => {
        expect(collide([CLASS_B], [CLASS_B])).toMatchObject({ groupIds: [CLASS_B] });
    });

    it('reports only the genuinely related groups when a Session has several', () => {
        // Class B is unrelated to Seminar A1 and must not appear, even though
        // it rides along on the same Session as Class A.
        const result = collide([SEMINAR_A1], [CLASS_A, CLASS_B]);

        expect(result).toMatchObject({ groupIds: [CLASS_A] });
    });

    it('does not flag Sessions with no groups at all', () => {
        expect(collide([], [])).toBeNull();
        expect(collide([CLASS_A], [])).toBeNull();
    });
});
