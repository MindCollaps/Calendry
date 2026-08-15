import type { Toast } from '~~/types/toast';
import { defineStore } from 'pinia';

// The `me: WebUser` field and its `types/user.ts` interface were the template's
// auth stub. They were never connected to Calendry's account model and their
// only consumer was the old `useHeaderMenu`, which gated on `me.isAdmin`.
// Navigation now gates on the real permission catalogue, so both are deleted
// rather than left as a second, wrong idea of who the user is.
export const useStore = defineStore('index', {
    state: () => ({
        version: '',
        theme: 'default' as ThemesList,
        ready: true, // Set to true, since there is no secondary connection mechanism that would require waiting for the connection to be established
        isMobile: false,
        isMobileOrTablet: false,
        isTablet: false,
        isPC: true,
        isPCWide: false,
        scrollbarWidth: 0,
        viewport: {
            width: 0,
        },
        toasts: [] as Toast[],
    }),
    actions: {
        addToast(toast: Toast) {
            // limit to 3 toasts at the same time and remove the oldest
            this.toasts.push(toast);
            if (this.toasts.length > 3) {
                this.toasts.shift();
            }

            // Auto-remove after duration
            setTimeout(() => {
                this.removeToast(toast.id);
            }, toast.duration);
        },
        removeToast(id: string) {
            const index = this.toasts.findIndex(t => t.id === id);
            if (index !== -1) {
                this.toasts.splice(index, 1);
            }
        },
    },
});
