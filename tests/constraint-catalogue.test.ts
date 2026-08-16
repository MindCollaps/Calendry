import { describe, expect, it } from 'vitest';
import {
    CONSTRAINT_TYPES,
    SOLVER_OWNED_CONSTRAINT_TYPES,
    STRUCTURAL_CONSTRAINT_TYPES,
    constraintCatalogueDrift,
    findConstraintType,
    severityMismatch,
} from '../shared/constraintTypes';
import { toWireConstraint } from '../server/utils/solverInput';

/**
 * Guards the one invariant `shared/constraintTypes.ts` exists to hold.
 *
 * The rule builder offers what the catalogue declares; `server/utils/violations.ts`
 * evaluates what the two type lists name. If those diverge, a tenant can
 * configure a constraint that is enabled, reports nothing, and means nothing —
 * a failure with no symptom, which is the kind this codebase keeps designing
 * against.
 *
 * A pure unit test: it needs no server and no database, unlike the four
 * integration suites alongside it.
 */
describe('constraint catalogue', () => {
    it('describes every type the evaluators know, and no others', () => {
        const drift = constraintCatalogueDrift();

        expect(drift.missingFromCatalogue).toEqual([]);
        expect(drift.missingFromEvaluators).toEqual([]);
    });

    it('marks structural types as app-evaluated and the rest as solver-owned', () => {
        for (const type of CONSTRAINT_TYPES) {
            const expected = (STRUCTURAL_CONSTRAINT_TYPES as readonly string[]).includes(type.key)
                ? 'app'
                : 'solver';

            expect(type.evaluator, `${type.key} evaluator`).toBe(expected);
        }
    });

    it('covers exactly the two evaluator lists', () => {
        expect(CONSTRAINT_TYPES).toHaveLength(
            STRUCTURAL_CONSTRAINT_TYPES.length + SOLVER_OWNED_CONSTRAINT_TYPES.length,
        );
    });

    it('gives every type a unique key and a description', () => {
        const keys = CONSTRAINT_TYPES.map((type) => type.key);

        expect(new Set(keys).size).toBe(keys.length);

        for (const type of CONSTRAINT_TYPES) {
            expect(type.label.length, `${type.key} label`).toBeGreaterThan(0);
            expect(type.description.length, `${type.key} description`).toBeGreaterThan(0);
        }
    });

    it('only allows a penalty weight where severity can be SOFT', () => {
        // The database CHECK enforces HARD ⇒ weight null, SOFT ⇒ weight set. A
        // type whose severity is pinned to HARD must never be offered a weight
        // control, so the catalogue must not describe one.
        for (const type of CONSTRAINT_TYPES.filter((t) => t.severity === 'HARD')) {
            expect(type.params.some((p) => p.key === 'weight'), `${type.key}`).toBe(false);
        }
    });
});

describe('constraint → wire mapping (Stage 3d)', () => {
    const scopeless: { offeringId: string | null; kindId: string | null }[] = [];
    const noKinds = new Map<string, string>();

    const row = (over: Partial<Parameters<typeof toWireConstraint>[0]> = {}) => ({
        id: 'c-1',
        type: 'no_double_booking_room',
        severity: 'HARD',
        weight: null,
        params: {},
        scopes: scopeless,
        ...over,
    });

    it('maps every catalogue type to a distinct wire field', () => {
        const fields = CONSTRAINT_TYPES.map((type) => type.wireField);

        expect(new Set(fields).size).toBe(fields.length);
    });

    it('sends a parameterless type as an empty variant', () => {
        const result = toWireConstraint(row(), noKinds);

        expect('config' in result).toBe(true);
        expect((result as { config: Record<string, unknown> }).config.roomDoubleBooking).toEqual({});
    });

    it('SKIPS rather than defaulting when a required parameter is missing', () => {
        // The whole point of skip-and-report: a rule the tenant never chose,
        // enforced by a solver and reported to nobody, is worse than one that
        // visibly did not run.
        const result = toWireConstraint(row({ type: 'minimize_saturday', severity: 'SOFT', weight: 5 }), noKinds);

        expect('skip' in result).toBe(true);
        expect((result as { skip: string }).skip).toContain('days');
    });

    it('treats an EMPTY weekday list as unset, not as "avoid no days"', () => {
        const result = toWireConstraint(
            row({ type: 'minimize_saturday', severity: 'SOFT', weight: 5, params: { days: [] } }),
            noKinds,
        );

        expect('skip' in result).toBe(true);
    });

    it('sends chosen weekdays, sorted', () => {
        const result = toWireConstraint(
            row({ type: 'minimize_saturday', severity: 'SOFT', weight: 5, params: { days: [7, 3] } }),
            noKinds,
        );

        expect((result as { config: Record<string, unknown> }).config.minimizeDayUsage).toEqual({ days: [3, 7] });
    });

    it('converts a percent parameter to the wire ratio', () => {
        const result = toWireConstraint(
            row({
                type: 'max_online_ratio_per_group',
                params: { maxRatio: 30, window: 'SHARE_WINDOW_PER_WEEK' },
            }),
            noKinds,
        );

        // Tenants think 0–100, the wire wants 0.0–1.0. The STORED value stays
        // what was typed; conversion happens only here.
        expect((result as { config: Record<string, unknown> }).config.maxOnlineShare)
            .toEqual({ maxRatio: 0.3, window: 2 });
    });

    it('accepts 0 as a real threshold rather than reading it as unset', () => {
        // rankThreshold 0 means "penalize every room" — a genuine policy.
        const result = toWireConstraint(
            row({ type: 'minimize_high_ranking_rooms', severity: 'SOFT', weight: 2, params: { rankThreshold: 0 } }),
            noKinds,
        );

        expect((result as { config: Record<string, unknown> }).config.minimizeRoomRank).toEqual({ rankThreshold: 0 });
    });

    it('carries weight for SOFT types and zeroes it for HARD ones', () => {
        const soft = toWireConstraint(
            row({ type: 'minimize_first_block', severity: 'SOFT', weight: 7 }),
            noKinds,
        ) as { config: { weight: number } };
        const hard = toWireConstraint(row({ weight: 99 }), noKinds) as { config: { weight: number } };

        expect(soft.config.weight).toBe(7);
        // The solver ignores weight on a HARD type; sending 99 would imply it
        // means something.
        expect(hard.config.weight).toBe(0);
    });

    it('resolves kind scopes to kind KEYS, which is what the wire carries', () => {
        const result = toWireConstraint(
            row({ scopes: [{ offeringId: null, kindId: 'kind-1' }] }),
            new Map([['kind-1', 'lecture']]),
        );

        expect((result as { config: { appliesToKinds: string[] } }).config.appliesToKinds).toEqual(['lecture']);
    });

    it('SKIPS an offering-scoped constraint rather than widening it', () => {
        // ConstraintConfig has applies_to_kinds only. Sending it unscoped would
        // apply the rule to EVERY offering — the opposite of what was configured.
        const result = toWireConstraint(
            row({ scopes: [{ offeringId: 'offering-1', kindId: null }] }),
            noKinds,
        );

        expect('skip' in result).toBe(true);
        expect((result as { skip: string }).skip).toContain('offerings');
    });

    it('skips a type that is not in the catalogue at all', () => {
        const result = toWireConstraint(row({ type: 'invented_by_hand' }), noKinds);

        expect('skip' in result).toBe(true);
    });
});

describe('severityMismatch', () => {
    it('reports a stored severity that contradicts the catalogue', () => {
        const type = findConstraintType('no_double_booking_room')!;

        expect(severityMismatch(type, 'SOFT')).toEqual({ expected: 'HARD', stored: 'SOFT' });
        expect(severityMismatch(type, 'HARD')).toBeNull();
    });
});
