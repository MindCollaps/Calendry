<template>
    <common-page title="Signed in">
        <!--
            PLACEHOLDER LANDING PAGE.

            There is no real home screen yet — the schedule UI does not exist.
            This page exists so the login flow has somewhere to land and so the
            session is inspectable. Replace it with the schedule view when that
            is built; do not grow it into one.
        -->
        <p v-if="session">
            {{ session.activePerson?.givenName }} {{ session.activePerson?.familyName }}
            at <strong>{{ session.activeTenant?.name }}</strong>
        </p>

        <p class="landing_note">
            Placeholder landing page — the schedule UI has not been built yet.
        </p>

        <details
            v-if="session"
            class="landing_permissions"
        >
            <summary>{{ session.permissions.length }} permissions in this tenant</summary>
            <ul>
                <li
                    v-for="permission in session.permissions"
                    :key="permission"
                >{{ permission }}</li>
            </ul>
        </details>

        <common-button
            v-if="(session?.availableTenants.length ?? 0) > 1"
            type="secondary"
            @click="switchTenant"
        >Switch institution</common-button>

        <common-button
            type="secondary-black"
            @click="logout"
        >Sign out</common-button>
    </common-page>
</template>

<script setup lang="ts">
import { logout, useSession } from '~/composables/session';

useHead({ title: 'Home' });

const session = useSession();

/**
 * Switching goes back through the login page's selection step rather than
 * duplicating that UI here — the server treats a switch as a session mutation,
 * so no re-authentication is needed, only a new choice.
 */
async function switchTenant() {
    await navigateTo('/login?select=1');
}
</script>

<style scoped lang="scss">
.landing {
    &_note {
        margin: 0;
        color: $content7;
    }

    &_permissions {
        max-width: 480px;

        ul {
            columns: 2;
            margin: 8px 0 0;
            font-size: 13px;
        }
    }
}
</style>
