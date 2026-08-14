export interface WebUser {  
    id: string;
    username: string;
    email: string;
    avatarUrl?: string;
    /**
     * TODO(auth): template leftover. No code populates this yet. Real
     * permissions are per-tenant, tenant-configured roles (TAXONOMY.md §4),
     * which will replace this boolean.
     */
    isAdmin: boolean;
    loggedIn: boolean;
}