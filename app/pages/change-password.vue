<template>
    <common-box>
        <h1 class="cp_title">Choose a new password</h1>

        <form
            class="cp_form"
            @submit.prevent="submit"
        >
            <p class="cp_lead">
                {{ forced
                    ? 'This account was reset by an administrator. Set a new password to continue.'
                    : 'Enter your current password and a new one.' }}
            </p>

            <common-input-text
                v-model="email"
                placeholder="Email"
                input-type="email"
                :disabled="busy"
                :input-attrs="{ autocomplete: 'username', required: true }"
            />

            <common-input-text
                v-model="currentPassword"
                placeholder="Current password"
                input-type="password"
                :disabled="busy"
                :input-attrs="{ autocomplete: 'current-password', required: true }"
            />

            <common-input-text
                v-model="newPassword"
                placeholder="New password"
                input-type="password"
                :disabled="busy"
                :input-attrs="{ autocomplete: 'new-password', required: true, minlength: 12 }"
            />

            <p class="cp_hint">At least 12 characters, and different from the current one.</p>

            <p
                v-if="error"
                class="cp_error"
                role="alert"
            >{{ error }}</p>

            <common-button
                tag="button"
                type="primary"
                width="100%"
                :disabled="busy"
            >{{ busy ? 'Saving…' : 'Change password' }}</common-button>

            <common-button
                type="link"
                :disabled="busy"
                @click="navigateTo('/login')"
            >Back to sign in</common-button>
        </form>
    </common-box>
</template>

<script setup lang="ts">
import { LOGIN_ERROR } from '~/composables/session';

definePageMeta({ layout: 'empty' });
useHead({ title: 'Change password' });

const route = useRoute();

const email = ref(typeof route.query.email === 'string' ? route.query.email : '');
const currentPassword = ref('');
const newPassword = ref('');
const error = ref('');
const busy = ref(false);

/** Arrived here because a reset forced it, rather than by choice. */
const forced = computed(() => route.query.forced === '1');

async function submit() {
    if (busy.value) {
        return;
    }

    error.value = '';
    busy.value = true;

    try {
        await $fetch('/api/auth/change-password', {
            method: 'POST',
            body: {
                email: email.value,
                currentPassword: currentPassword.value,
                newPassword: newPassword.value,
            },
        });

        // No auto-login: the change endpoint issues no session, so the user
        // signs in normally with the password they just chose.
        await navigateTo('/login?changed=1');
    } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;

        // 422 is the only case worth naming — it is about the new password, not
        // about whether the account exists.
        error.value = status === 422
            ? ((e as { statusMessage?: string }).statusMessage ?? 'That password cannot be used.')
            : LOGIN_ERROR;
        currentPassword.value = '';
    } finally {
        busy.value = false;
    }
}
</script>

<style scoped lang="scss">
.cp {
    &_title {
        margin: 0;
        font-size: 26px;
        font-weight: bold;
    }

    &_form {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 300px;
    }

    &_lead {
        margin: 0 0 4px;
        font-size: 13px;
        line-height: 1.5;
        color: $content6;
    }

    &_hint {
        margin: -4px 0 0;
        font-size: 11.5px;
        color: $surface7;
    }

    &_error {
        margin: 0;
        font-size: 13px;
        color: $error400;
    }
}
</style>
