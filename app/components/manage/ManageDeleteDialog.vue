<template>
    <Teleport to="body">
        <div
            v-if="open"
            class="confirm"
            @mousedown.self="$emit('cancel')"
        >
            <div
                class="confirm_box"
                role="alertdialog"
                aria-modal="true"
                :aria-label="`Delete ${subject}`"
            >
                <h2>Delete {{ entityLabel.toLowerCase() }}?</h2>

                <p>
                    <strong>{{ subject }}</strong> will be removed permanently.
                    This cannot be undone.
                </p>

                <p class="confirm_note">
                    If anything still references it — a session, an offering, a child
                    group — the database refuses the delete and nothing is lost.
                </p>

                <p
                    v-if="error"
                    class="confirm_error"
                    role="alert"
                >{{ error }}</p>

                <div class="confirm_actions">
                    <common-button
                        ref="cancelRef"
                        type="secondary"
                        :disabled="busy"
                        @click="$emit('cancel')"
                    >Cancel</common-button>
                    <common-button
                        type="destructive"
                        :disabled="busy"
                        @click="$emit('confirm')"
                    >{{ busy ? 'Deleting…' : 'Delete' }}</common-button>
                </div>
            </div>
        </div>
    </Teleport>
</template>

<script setup lang="ts">
import { useOverlay } from '~/composables/overlay';

/**
 * Confirmation for an irreversible delete.
 *
 * It claims the keyboard through `useOverlay` for the same reason the command
 * palette does: Escape here must cancel the dialog and nothing else. That the
 * mechanism is shared is the point — a second overlay that invented its own
 * Escape handling is how the schedule's placement mode starts getting cancelled
 * by unrelated dialogs again.
 */
const props = defineProps<{
    open: boolean;
    /** The row's human title, so the dialog names what it is about to destroy. */
    subject: string;
    entityLabel: string;
    busy?: boolean;
    error?: string;
}>();

const emit = defineEmits<{ confirm: []; cancel: [] }>();

const { claim, release } = useOverlay('manage-delete');

watch(() => props.open, (isOpen) => {
    if (isOpen) claim();
    else release();
}, { immediate: true });

function onKey(event: KeyboardEvent) {
    if (props.open && event.key === 'Escape') {
        event.preventDefault();
        emit('cancel');
    }
}

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<style scoped lang="scss">
.confirm {
    position: fixed;
    z-index: 210;
    inset: 0;

    display: flex;
    align-items: center;
    justify-content: center;

    padding: var(--space-6);

    background: vartorgba('content0', 0.45);

    &_box {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);

        width: 100%;
        max-width: 420px;
        padding: var(--space-7);
        border-radius: var(--radius-xl);

        background: $surface1;
        box-shadow: 0 24px 60px vartorgba('content0', 0.28);

        h2 {
            margin: 0;
            font-size: var(--font-size-lg);
            font-weight: 680;
            color: $content1;
        }

        p {
            margin: 0;
            font-size: var(--font-size-md);
            line-height: 1.5;
            color: $content5;
        }
    }

    &_note {
        font-size: var(--font-size-sm) !important;
        color: $content7 !important;
    }

    &_error {
        padding: var(--space-4) var(--space-5);
        border-radius: var(--radius-lg);

        font-size: var(--font-size-sm) !important;
        color: $error700 !important;

        background: vartorgba('error500', 0.14);
    }

    &_actions {
        display: flex;
        gap: var(--space-4);
        justify-content: flex-end;
        margin-top: var(--space-3);
    }
}
</style>
