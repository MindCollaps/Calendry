<template>
    <common-page title="Signed in">
        <!--
            STILL A LANDING PAGE, not a dashboard. It exists so the login flow
            has somewhere to land and so the session is inspectable.

            The old copy here claimed "the schedule UI has not been built yet",
            which stopped being true two steps ago. Rather than restate what
            exists — and go stale again — it now lists the destinations the nav
            registry says this person can actually reach.
        -->
        <p v-if="session">
            {{ session.activePerson?.givenName }} {{ session.activePerson?.familyName }}
            at <strong>{{ session.activeTenant?.name }}</strong>
        </p>

        <nav class="landing_links">
            <common-button
                v-for="entry in destinations"
                :key="entry.id"
                :icon="entry.icon"
                :to="entry.to!"
                type="secondary"
            >{{ entry.label }}</common-button>
        </nav>

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
import { useNavEntries } from '~/composables/navigation';

useHead({ title: 'Home' });

const session = useSession();

// Same permission-filtered registry as the header, sidebar and Ctrl+K. "Home"
// is dropped because linking a page to itself is noise.
const navEntries = useNavEntries();

const destinations = computed(() => navEntries.value.filter(
    (entry) => entry.to && entry.id !== 'home' && entry.section !== 'account',
));

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
    &_links {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-4);
        justify-content: center;
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
