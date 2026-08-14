/** Minimal HTTP client that carries a session cookie, like a browser would. */
const BASE = process.env.TEST_BASE_URL ?? 'http://localhost:8080';

export interface ApiResponse<T = unknown> {
    status: number;
    body: T;
    setCookie: string | null;
}

export async function api<T = unknown>(
    path: string,
    init: RequestInit & { cookie?: string | null } = {},
): Promise<ApiResponse<T>> {
    const { cookie, ...rest } = init;

    const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(rest.headers as Record<string, string> | undefined),
    };

    if (cookie) {
        headers.cookie = cookie;
    }

    const res = await fetch(`${BASE}${path}`, { ...rest, headers });
    const text = await res.text();

    let body: unknown = text;

    try {
        body = text ? JSON.parse(text) : null;
    } catch {
        // Non-JSON error page — keep the raw text for assertion messages.
    }

    return { status: res.status, body: body as T, setCookie: res.headers.get('set-cookie') };
}

/** Extracts just the `name=value` pair, which is all a request needs to send back. */
export function cookieFrom(setCookie: string | null): string {
    if (!setCookie) {
        throw new Error('Expected a Set-Cookie header but got none.');
    }

    return setCookie.split(';')[0] as string;
}

/** Logs in and returns the session cookie plus the login payload. */
export async function login(email: string, password: string, tenantSlug?: string) {
    const res = await api<{
        tenantSelectionRequired: boolean;
        activeTenant: { id: string; slug: string } | null;
        availableTenants: { tenantId: string; slug: string }[];
    }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, ...(tenantSlug ? { tenantSlug } : {}) }),
    });

    if (res.status !== 200) {
        throw new Error(`Login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
    }

    return { cookie: cookieFrom(res.setCookie), ...res.body };
}
