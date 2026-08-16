#!/usr/bin/env node
/**
 * Fails `bun install` with an explanation when the GitHub Packages credential
 * for the @mindcollaps scope is missing — or, worse, present but inert.
 *
 * WHY THIS EXISTS
 * ---------------
 * A missing token surfaces as a bare `401 Unauthorized`, and GitHub Packages
 * returns the identical 401 for a package that genuinely does not exist. The
 * two are indistinguishable from the error alone. This turns one ambiguous line
 * into the actual cause and the fix.
 *
 * THE INERT-TOKEN TRAP, verified empirically against a local probe registry
 * that logged the Authorization header:
 *
 *   .npmrc  //npm.pkg.github.com/:_authToken=<t>          -> sent
 *   bunfig  "@mindcollaps" = { url = "...", token = "<t>" } -> sent
 *   bunfig  "@mindcollaps" = { token = "<t>" }              -> NOT SENT
 *
 * bun attaches a scope token to the URL declared in the SAME `install.scopes`
 * entry. A token-only entry is silently ignored even when the registry mapping
 * exists in .npmrc — bun reports the same 401 as having no token at all. That
 * is precisely the failure this repo keeps designing against, so it is checked
 * for by name and reported as its own case.
 *
 * Run directly with `bun run check:registry-auth` to diagnose without
 * attempting an install.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SCOPE = '@mindcollaps';
const REGISTRY_HOST = 'npm.pkg.github.com';

/**
 * Deliberately narrow TOML reading — node has no built-in TOML parser and
 * `preinstall` runs before node_modules exists, so a dependency is not an
 * option. This understands exactly the two shapes bun documents for a scope:
 *
 *   [install.scopes]
 *   "@mindcollaps" = { url = "...", token = "..." }
 *
 *   [install.scopes."@mindcollaps"]
 *   url = "..."
 *   token = "..."
 *
 * Anything else returns `unparsed` rather than "absent". Reporting a shape it
 * cannot read as "no token" would be the same lie the whole script exists to
 * prevent.
 */
function readBunfigScope(file) {
    const text = readFileSync(file, 'utf8');
    const quoted = SCOPE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Form 2: a dedicated section for the scope.
    const section = new RegExp(
        // NB: JavaScript regex has no \Z — it would match a literal "Z" and the
        // section would never terminate at end-of-input. This lookahead is the
        // equivalent. (Cost me a full round of tests that all reported "no
        // credential" for perfectly good files.)
        `^\\s*\\[install\\.scopes\\.(?:"${quoted}"|'${quoted}')\\]\\s*$([\\s\\S]*?)(?=^\\s*\\[|$(?![\\s\\S]))`,
        'm',
    ).exec(text);

    if (section) {
        return {
            url: /^\s*url\s*=\s*["']([^"']*)["']/m.exec(section[1])?.[1] ?? '',
            token: /^\s*token\s*=\s*["']([^"']*)["']/m.exec(section[1])?.[1] ?? '',
        };
    }

    // Form 1: an inline table under [install.scopes].
    const scopes = /^\s*\[install\.scopes\]\s*$([\s\S]*?)(?=^\s*\[|$(?![\s\S]))/m.exec(text);

    if (!scopes) {
        return null;
    }

    const entry = new RegExp(`^\\s*(?:"${quoted}"|'${quoted}'|${quoted})\\s*=\\s*(.+)$`, 'm').exec(scopes[1]);

    if (!entry) {
        return null;
    }

    const body = entry[1];

    if (!body.trim().startsWith('{')) {
        return { unparsed: body.trim() };
    }

    return {
        url: /\burl\s*=\s*["']([^"']*)["']/.exec(body)?.[1] ?? '',
        token: /\btoken\s*=\s*["']([^"']*)["']/.exec(body)?.[1] ?? '',
    };
}

/**
 * Nearest wins, and it wins WHOLESALE. Verified: with the same scope declared
 * in both ./bunfig.toml and ~/.bunfig.toml, the project entry replaced the home
 * entry entirely — the home entry's token was not merged in. So a project file
 * shadows a working home credential exactly the way a project .npmrc would.
 * That is why the committed repo carries no scope entry of its own.
 */
function findBunfig() {
    for (const file of [join(process.cwd(), 'bunfig.toml'), join(homedir(), '.bunfig.toml')]) {
        if (!existsSync(file)) {
            continue;
        }

        const scope = readBunfigScope(file);

        if (scope) {
            return { file, ...scope };
        }
    }

    return null;
}

/** bun honours .npmrc auth lines too, so a working setup here must not be failed. */
const NPMRC_AUTH = new RegExp(`^\\s*//${REGISTRY_HOST.replace(/\./g, '\\.')}/:_authToken\\s*=\\s*(.+)$`, 'm');

/**
 * A scope→registry mapping in some .npmrc.
 *
 * An auth line ALONE is not a working setup: with no mapping, bun resolves
 * @mindcollaps against registry.npmjs.org and gets a 404 while cheerfully
 * holding a valid credential for a registry it never contacts. Passing on the
 * token alone would be a guard that reports success for a setup that fails —
 * so both halves are required.
 */
const NPMRC_SCOPE = new RegExp(`^\\s*${SCOPE}:registry\\s*=\\s*(\\S+)$`, 'm');

function findNpmrcScope() {
    for (const file of npmrcFiles()) {
        if (!existsSync(file)) {
            continue;
        }

        const match = NPMRC_SCOPE.exec(readFileSync(file, 'utf8'));

        if (match) {
            return { file, url: match[1] };
        }
    }

    return null;
}

function npmrcFiles() {
    const files = [join(process.cwd(), '.npmrc'), join(homedir(), '.npmrc')];

    if (process.env.NPM_CONFIG_USERCONFIG) {
        files.push(process.env.NPM_CONFIG_USERCONFIG);
    }

    return files;
}

function findNpmrcToken() {
    for (const file of npmrcFiles()) {
        if (!existsSync(file)) {
            continue;
        }

        // Anchored on line start: this repo's own docs quote the line they tell
        // you not to write, and a substring test would "find" it in a comment.
        const match = NPMRC_AUTH.exec(readFileSync(file, 'utf8'));

        if (!match) {
            continue;
        }

        const raw = match[1].trim();
        const variable = /^\$\{([A-Z0-9_]+)\}$/i.exec(raw);

        if (variable) {
            const value = process.env[variable[1]];

            // An unset variable expands to the empty string rather than being
            // skipped, so the line is present and useless.
            return value
                ? { file, ok: true }
                : { file, ok: false, reason: `references \${${variable[1]}}, which is unset or empty` };
        }

        return { file, ok: Boolean(raw), reason: raw ? undefined : 'is empty' };
    }

    return null;
}

const bunfig = findBunfig();
const npmrc = findNpmrcToken();
const npmrcScope = findNpmrcScope();

function pass(how) {
    if (process.env.CALENDRY_REGISTRY_AUTH_VERBOSE) {
        console.log(`${SCOPE} registry auth: ${how}`);
    }

    process.exit(0);
}

/**
 * GitHub Packages rejects FINE-GRAINED tokens for the npm registry.
 *
 * Observed directly: a `github_pat_…` token authenticated fine against
 * api.github.com/user (200) and was then refused by the registry with
 * `permission_denied: The token provided does not match expected scopes`, and
 * by the packages REST API with `Resource not accessible by personal access
 * token`. Nothing about that reads as "wrong kind of token" — it reads as a
 * permissions problem you could chase for an hour on a token that can never
 * work here.
 *
 * Checked by prefix because it is decidable offline and costs nothing.
 */
const FINE_GRAINED = /^github_pat_/;

if (bunfig?.token && bunfig.url && FINE_GRAINED.test(bunfig.token)) {
    console.error(`
──────────────────────────────────────────────────────────────────────────────
 The token in ${bunfig.file} is a FINE-GRAINED PAT (github_pat_…).

 GitHub Packages does not accept fine-grained tokens for the npm registry. It
 will authenticate — api.github.com accepts it — and then the registry refuses
 with "does not match expected scopes", which looks like a permissions problem
 rather than a wrong token type.

 Use a CLASSIC token instead: https://github.com/settings/tokens
   Classic PATs look like  ghp_ + 36 chars  (40 total)
   Required scope: read:packages
──────────────────────────────────────────────────────────────────────────────
`);
    process.exit(1);
}

if (bunfig?.token && bunfig.url) {
    pass(`bunfig scope entry in ${bunfig.file}`);
}

// Requires BOTH halves — see NPMRC_SCOPE above for why a token alone is not a
// working setup.
if (npmrc?.ok && npmrcScope) {
    pass(`.npmrc auth line in ${npmrc.file} + scope mapping in ${npmrcScope.file}`);
}

// Everything below is a failure. Say WHICH failure — the three cases need
// different fixes and look identical from the 401 alone.
let diagnosis;

if (bunfig?.unparsed) {
    diagnosis = `${bunfig.file} declares "${SCOPE}" in a form this check cannot read (${bunfig.unparsed}).\n `
        + `   It may still work; verify by hand, or use the inline-table form below.`;
} else if (bunfig?.token && !bunfig.url) {
    diagnosis = `${bunfig.file} sets a token for "${SCOPE}" but NO url — so bun never sends it.\n`
        + ` \n`
        + `    A scope token is attached to the url declared in the SAME entry. Without\n`
        + `    'url' the token is silently ignored, even though .npmrc maps the scope to\n`
        + `    the right registry. bun then reports the same 401 as having no token at\n`
        + `    all. Add the url to that entry.`;
} else if (bunfig && !bunfig.token) {
    diagnosis = `${bunfig.file} declares "${SCOPE}" but with no token.`;
} else if (npmrc?.ok && !npmrcScope) {
    diagnosis = `${npmrc.file} has a token for ${REGISTRY_HOST}, but nothing maps "${SCOPE}"\n`
        + `    to that registry — so bun resolves it against registry.npmjs.org and gets a\n`
        + `    404 while holding a credential it never uses. Use the bunfig entry below,\n`
        + `    which declares both in one place.`;
} else if (npmrc && !npmrc.ok) {
    diagnosis = `${npmrc.file} has an auth line for ${REGISTRY_HOST}, but it ${npmrc.reason}.`;
} else {
    diagnosis = `No credential for ${SCOPE} in ~/.bunfig.toml, ./bunfig.toml or any .npmrc.`;
}

console.error(`
──────────────────────────────────────────────────────────────────────────────
 Cannot install ${SCOPE}/calendry-proto — GitHub Packages needs a token.

 ${diagnosis}

 The package is public, but GitHub Packages requires authentication to read
 even public packages. Without a working token you get a 401 that looks
 exactly like the package not existing.

 FIX — add to ~/.bunfig.toml (NOT this repo; a project-level entry shadows
 your home one wholesale, and a token in the repo is a token one 'git add -f'
 from being published):

   [install.scopes]
   "${SCOPE}" = { url = "https://${REGISTRY_HOST}/", token = "<token>" }

 BOTH keys are required. url without token cannot authenticate; token without
 url is never sent.

 Token: a GitHub PAT with the 'read:packages' scope.
   Classic PATs look like  ghp_ + 36 chars  (40 total)
   Fine-grained look like  github_pat_...   (~93 total)
   https://github.com/settings/tokens

 Re-check without installing:  bun run check:registry-auth
──────────────────────────────────────────────────────────────────────────────
`);

process.exit(1);
