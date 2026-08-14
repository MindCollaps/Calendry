<template>
    <template v-if="ready">
        <div class="btn-wrap">
            <common-button
                v-if="!signedIn"
                to="/login"
            >Sign in</common-button>
            <common-button
                v-else
                icon-width="45px"
                type="secondary"
                @click="logout"
            >
                <template #default>
                    <div class="loggedin-view">
                        {{ displayName }}
                    </div>
                </template>
            </common-button>
        </div>
    </template>
    <template v-else>
        <common-loader smol/>
    </template>
</template>

<script setup lang="ts">
import { ready } from '~/composables/layout';
import { logout, useIsSignedIn, useSession } from '~/composables/session';
import CommonLoader from '../common/CommonLoader.vue';

/**
 * Header widget, not the login form itself — that lives at /login.
 *
 * Reads the real session rather than the WebUser template stub, which is now
 * referenced only by the navigation composable and is still slated for removal
 * (see CLAUDE.md).
 *
 * The signed-in button was previously a link to /profile; there is no profile
 * page, so it signs out instead. Point it back at /profile when one exists.
 */
const session = useSession();
const signedIn = useIsSignedIn();

const displayName = computed(() => {
    const person = session.value?.activePerson;

    return person ? `${person.givenName} ${person.familyName}` : 'Sign out';
});
</script>

<style scoped lang="scss">
.notification-indicator {
    display: flex;
    align-items: center;
    justify-content: center;

    width: 22px;
    height: 22px;
    border-radius: 50%;

    color: $content0;

    background: $warning600;
}

.loggedin-view {
    display: flex;
    flex-direction: row;
    gap: 16px;
    align-items: center;
    justify-content: center;
}

.btn-wrap {
    display: flex;
    gap: 12px;
    align-items: center;
    justify-content: center;
}
</style>
