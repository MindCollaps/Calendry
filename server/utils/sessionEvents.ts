import type { Prisma } from '@prisma/client';
import type { Tx } from './tenantDb';
import type { RequestIdentity } from './tenantResolver';

export type EventType = 'CREATE' | 'MOVE' | 'SWAP' | 'DELETE' | 'LOCK' | 'UNLOCK' | 'APPLY_GENERATION';

/**
 * Appends to the immutable edit log (TAXONOMY.md §3).
 *
 * The baseline Generation is required: an event is a delta *on top of* a
 * snapshot, so an event with no baseline could not be replayed. Payloads carry
 * full before/after state rather than references, so replay never depends on
 * rows that may have changed since.
 *
 * The database revokes UPDATE and DELETE on session_event from the runtime role
 * and enforces it again by trigger, so nothing written here can be rewritten.
 */
export async function appendEvent(
    tx: Tx,
    identity: RequestIdentity,
    input: {
        type: EventType;
        generationId: string;
        sessionId?: string | null;
        counterpartSessionId?: string | null;
        payload: Prisma.InputJsonObject;
        reason?: string | null;
    },
) {
    const created = await tx.sessionEvent.create({
        data: {
            tenantId: identity.tenantId,
            generationId: input.generationId,
            type: input.type,
            sessionId: input.sessionId ?? null,
            counterpartSessionId: input.counterpartSessionId ?? null,
            payload: input.payload,
            actorPersonId: identity.actorPersonId,
            reason: input.reason ?? null,
        },
    });

    // `seq` is a BigInt, which JSON.stringify refuses to serialize — returning
    // the row as-is makes every editing route throw at response time. Converted
    // here, at the single point events are created, rather than in each route.
    return { ...created, seq: created.seq.toString() };
}

/**
 * The Generation an edit hangs off. Falls back to the tenant's current baseline.
 * Editing before any Generation exists is refused rather than silently creating
 * one, because an implicit baseline would make history ambiguous.
 */
export async function requireBaselineGeneration(tx: Tx, tenantId: string, sessionGenerationId?: string | null) {
    if (sessionGenerationId) {
        return sessionGenerationId;
    }

    const current = await tx.generation.findFirst({
        where: { tenantId, isCurrent: true },
        select: { id: true },
    });

    if (!current) {
        throw createError({
            statusCode: 409,
            statusMessage: 'No current Generation to record this edit against. Apply a Generation first.',
        });
    }

    return current.id;
}

/** Placement fields captured in event payloads. */
export function placementOf(session: {
    termId: string;
    termWeek: number;
    dayOfWeek: number;
    blockIndex: number;
    durationBlocks: number;
    timeGridId: string | null;
}) {
    return {
        termId: session.termId,
        termWeek: session.termWeek,
        dayOfWeek: session.dayOfWeek,
        blockIndex: session.blockIndex,
        durationBlocks: session.durationBlocks,
        timeGridId: session.timeGridId,
    };
}
