<template>
    <common-box>
        <h1 class="login_title">Calendry</h1>

        <!-- STEP 1 — credentials -->
        <form
            v-if="step === 'credentials'"
            class="login_form"
            @submit.prevent="submitCredentials"
        >
            <p
                v-if="justChanged"
                class="login_changed"
                role="status"
            >Password changed. Sign in with your new password.</p>
            <p
                v-else
                class="login_lead"
            >Sign in to continue.</p>

            <common-input-text
                v-model="email"
                placeholder="Email"
                input-type="email"
                :disabled="busy"
                :input-attrs="{ autocomplete: 'username', required: true, autofocus: true }"
            />

            <common-input-text
                v-model="password"
                placeholder="Password"
                input-type="password"
                :disabled="busy"
                :input-attrs="{ autocomplete: 'current-password', required: true }"
            />

            <p
                v-if="error"
                class="login_error"
                role="alert"
            >{{ error }}</p>

            <!--
                native-type="submit" makes this a real submit button inside the
                <form>, so Enter in either field works and the @submit.prevent
                handler is the single entry point. No @click here — that would
                fire the handler twice. CommonButton defaults to type="button",
                so this opt-in is what keeps Enter-to-submit working.
            -->
            <common-button
                native-type="submit"
                type="primary"
                width="100%"
                :disabled="busy"
            >{{ busy ? 'Signing in…' : 'Sign in' }}</common-button>

            <p class="login_note">
                Accounts are created by an administrator. There is no self-service sign-up.
            </p>
        </form>

        <!-- STEP 2 — tenant selection, only when the account has several identities -->
        <div
            v-else
            class="login_form"
        >
            <p class="login_lead">
                Your account belongs to more than one institution. Choose one to continue.
            </p>

            <common-button
                v-for="tenant in availableTenants"
                :key="tenant.tenantId"
                type="secondary"
                width="100%"
                :disabled="busy"
                @click="chooseTenant(tenant.tenantId)"
            >{{ tenant.name }}</common-button>

            <p
                v-if="error"
                class="login_error"
                role="alert"
            >{{ error }}</p>

            <common-button
                type="link"
                :disabled="busy"
                @click="cancelSelection"
            >Use a different account</common-button>
        </div>
    </common-box>
</template>

<script setup lang="ts">
import { LOGIN_ERROR, type SessionTenant, fetchSession, useSession } from '~/composables/session';

/**
 * Two-step sign-in.
 *
 *   credentials → (one identity)  → redirect
 *   credentials → (many identities) → tenant selection → redirect
 *
 * The tenant step is never skipped silently: the API returns
 * tenantSelectionRequired and the session has no active Person until a choice
 * is made, so an ambiguous account genuinely cannot proceed by accident.
 */
definePageMeta({ layout: 'empty' });
useHead({ title: 'Sign in' });

const route = useRoute();
const session = useSession();

const step = ref<'credentials' | 'tenant'>('credentials');
const email = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);
const availableTenants = ref<SessionTenant[]>([]);
const justChanged = computed(() => route.query.changed === '1');

// Arriving with ?select=1 means an already-signed-in user came back to change
// institution. Skip straight to the selection step using the identities the
// session already knows about — no re-authentication required.
if (route.query.select === '1' && session.value?.availableTenants.length) {
    availableTenants.value = session.value.availableTenants;
    step.value = 'tenant';
}

function destination(): string {
    const redirect = route.query.redirect;

    if (typeof redirect !== 'string' || !redirect.startsWith('/') || redirect.startsWith('//')) {
        return '/';
    }

    return redirect;
}

async function submitCredentials() {
    if (busy.value) {
        return;
    }

    error.value = '';
    busy.value = true;

    try {
        const result = await $fetch<{
            requiresPasswordChange?: boolean;
            tenantSelectionRequired: boolean;
            availableTenants: SessionTenant[];
        }>('/api/auth/login', {
            method: 'POST',
            body: { email: email.value, password: password.value },
        });

        // Credentials were correct, but an operator forced a reset: no session
        // was issued, so the only way forward is changing the password.
        if (result.requiresPasswordChange) {
            await navigateTo(`/change-password?forced=1&email=${encodeURIComponent(email.value)}`);

            return;
        }

        if (result.tenantSelectionRequired) {
            availableTenants.value = result.availableTenants;
            step.value = 'tenant';

            return;
        }

        await finish();
    } catch {
        // ONE message for every failure mode — wrong password, unknown account,
        // and an account with no active Person all land here. The API already
        // returns identical 401s for the first two; distinguishing them in the
        // UI would reintroduce the account-existence oracle that the server
        // deliberately avoids.
        error.value = LOGIN_ERROR;
        password.value = '';
    } finally {
        busy.value = false;
    }
}

async function chooseTenant(tenantId: string) {
    if (busy.value) {
        return;
    }

    error.value = '';
    busy.value = true;

    try {
        await $fetch('/api/auth/select-tenant', { method: 'POST', body: { tenantId } });
        await finish();
    } catch {
        error.value = 'That institution is not available for this account.';
    } finally {
        busy.value = false;
    }
}

async function cancelSelection() {
    await $fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);

    session.value = null;
    availableTenants.value = [];
    password.value = '';
    step.value = 'credentials';
}

/** Refresh shared state before navigating so the guard sees the new session. */
async function finish() {
    await fetchSession(true);
    await navigateTo(destination());
}
</script>

<style scoped lang="scss">
.login {
    &_title {
        margin: 0;
        font-size: 32px;
        font-weight: bold;
    }

    &_form {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 280px;
    }

    &_lead {
        margin: 0 0 4px;
        color: $content6;
    }

    &_error {
        margin: 0;
        color: $error400;
    }

    &_changed {
        margin: 0 0 4px;
        font-size: 13px;
        line-height: 1.5;
        color: $success300;
    }

    &_note {
        margin: 8px 0 0;
        font-size: 12px;
        color: $content7;
    }
}
</style>
