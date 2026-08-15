/**
 * Who currently owns the keyboard.
 *
 * THE PROBLEM THIS EXISTS FOR: `useScheduleEditing` binds Escape on `window`
 * to unwind placement mode, then selection. The command palette binds Escape to
 * close itself. With the palette open on /schedule, one keypress would do both
 * — close the palette AND cancel a placement the user never meant to cancel.
 * `stopPropagation` does not fix it: both listeners are on the same target, so
 * ordering is registration order, which is an implementation detail.
 *
 * So overlays declare themselves, and page-level global key handlers stand down
 * while one is open. One question, one owner.
 *
 * A LEAKED CLAIM WOULD BE A SILENT BUG — Escape would simply stop working on
 * the schedule, with nothing to see. Two things make that hard: claims are held
 * by NAME in a set (so a stuck one is inspectable in devtools rather than being
 * an opaque count), and `useOverlay` releases on unmount whether or not the
 * component remembered to.
 */
const useOverlayClaims = () => useState<string[]>('calendry.overlay.claims', () => []);

/** True while any overlay owns the keyboard. Read this in global key handlers. */
export function useOverlayActive() {
    const claims = useOverlayClaims();

    return computed(() => claims.value.length > 0);
}

/**
 * Claim the keyboard for a named overlay. Call from the overlay's setup; the
 * claim is dropped automatically when it unmounts.
 */
export function useOverlay(name: string) {
    const claims = useOverlayClaims();

    function claim() {
        if (!claims.value.includes(name)) {
            claims.value = [...claims.value, name];
        }
    }

    function release() {
        if (claims.value.includes(name)) {
            claims.value = claims.value.filter((held) => held !== name);
        }
    }

    onBeforeUnmount(release);

    return { claim, release };
}
