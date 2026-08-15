import { describe, expect, it } from 'vitest';
import {
    CONSTRAINT_TYPES,
    SOLVER_OWNED_CONSTRAINT_TYPES,
    STRUCTURAL_CONSTRAINT_TYPES,
    constraintCatalogueDrift,
} from '../shared/constraintTypes';

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
