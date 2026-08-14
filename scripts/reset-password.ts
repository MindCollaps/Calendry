/**
 * Force-resets an Account's password. Last-resort operator recovery.
 *
 * WHY A CLI, NOT AN ENDPOINT
 * -------------------------
 * Same reasoning as provision:tenant: an operator-only recovery tool exposed
 * over HTTP is a credential-reset endpoint reachable from the internet. Keeping
 * it in a CLI means the running application cannot reset anyone's password, no
 * matter what it is tricked into doing.
 *
 * WHY THE APP ROLE, NOT THE OWNER
 * -------------------------------
 * Unlike provisioning, this needs no ownership. `account`, `account_person` and
 * `auth_session` are the pre-tenant plane with no RLS, so the app role can
 * write them; the one tenant-scoped read (which tenants the account spans)
 * goes through calendry_internal.account_identities(), which the app role may
 * execute. Verified against the live database, not assumed. Using the owner
 * would mean an operator needs credentials that can drop FORCE ROW LEVEL
 * SECURITY just to change a password.
 *
 * TARGETS AN ACCOUNT, NOT A PERSON
 * --------------------------------
 * `account.email` is globally unique; `person.email` is unique only per tenant.
 * One Account spans tenants via account_person, so resetting a tenant+person
 * pair would leave the actual credential untouched everywhere else.
 *
 *   bun run reset:password -- --email someone@example.edu [--yes]
 */
import { createInterface } from 'node:readline/promises';
import { hostname, userInfo } from 'node:os';
import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
// The real hashing path, not a re-implementation. A second copy of the KDF
// drifts silently the moment the original changes.
import { hashPassword } from '../server/utils/auth';
import { describeTarget, resolveAppDatabaseUrl } from './lib/ownerDatabaseUrl';

function arg(name: string): string | undefined {
    const index = process.argv.indexOf(`--${name}`);

    return index === -1 ? undefined : process.argv[index + 1];
}

async function main() {
    const email = arg('email')?.toLowerCase();
    const skipConfirm = process.argv.includes('--yes');

    if (!email) {
        console.error('Missing required --email');
        process.exit(1);
    }

    const connectionString = resolveAppDatabaseUrl();
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

    try {
        const account = await prisma.account.findUnique({ where: { email } });

        // Unlike the login route, this names the failure. The account-existence
        // oracle protection exists to stop anonymous probing; an operator with
        // database credentials needs to know they mistyped the address.
        if (!account) {
            console.error(`\nNo account with email '${email}'.\n`);
            process.exit(1);
        }

        // Blast radius, resolved before anything is written so the operator can
        // see what they are about to do.
        const identities = await prisma.$queryRaw<{ tenant_slug: string; tenant_name: string }[]>`
            SELECT * FROM calendry_internal.account_identities(${account.id})
        `;
        const liveSessions = await prisma.authSession.count({
            where: { accountId: account.id, revokedAt: null, expiresAt: { gt: new Date() } },
        });

        console.log(`\nAccount   ${account.email} (${account.id})`);
        console.log(`Tenants   ${identities.map((i) => i.tenant_slug).join(', ') || '(none)'}`);
        console.log(`Sessions  ${liveSessions} active — all will be revoked, in every tenant`);
        console.log('Effect    new one-time password, and the account must change it at next login\n');

        if (!skipConfirm) {
            // Retyping the address, not y/n: the realistic accident here is
            // resetting the wrong account, which a reflexive "y" does not catch.
            const rl = createInterface({ input: process.stdin, output: process.stdout });
            const answer = await rl.question(`Type the email to confirm (${email}): `);

            rl.close();

            if (answer.trim().toLowerCase() !== email) {
                console.error('\nDoes not match. Nothing was changed.\n');
                process.exit(1);
            }
        }

        const newPassword = randomBytes(12).toString('base64url');
        const passwordHash = await hashPassword(newPassword);

        // One transaction: a reset that sets the password but fails to revoke
        // sessions is worse than one that does neither.
        const revoked = await prisma.$transaction(async (tx) => {
            await tx.account.update({
                where: { id: account.id },
                data: { passwordHash, mustChangePassword: true },
            });

            // Sessions hang off account_id, so this reaches every tenant the
            // account acts in — not just the one it was last used in.
            const result = await tx.authSession.updateMany({
                where: { accountId: account.id, revokedAt: null },
                data: { revokedAt: new Date() },
            });

            return result.count;
        });

        const record = {
            ts: new Date().toISOString(),
            action: 'account.password_reset',
            accountId: account.id,
            email: account.email,
            tenants: identities.map((i) => i.tenant_slug),
            sessionsRevoked: revoked,
            mustChangePassword: true,
            operator: `${userInfo().username}@${hostname()}`,
            via: 'cli:reset-password',
        };

        console.log(`\nReset complete. ${revoked} session(s) revoked across ${identities.length} tenant(s).`);
        console.log(`\n  One-time password: ${newPassword}`);
        console.log('  Shown once. The account must change it at next sign-in.\n');

        // Structured line for redirection into a real log sink. Deliberately not
        // a database table: the operator running this can rewrite any table in
        // this database, so a local audit row is not tamper-evident against the
        // one actor it audits. stdout to an external collector is honest about
        // where the trust boundary actually is.
        console.log(`AUDIT ${JSON.stringify(record)}`);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);

        if (/Unable to start a transaction|Can't reach database server|ECONNREFUSED|ENOTFOUND/i.test(message)) {
            console.error(
                `\nCould not reach the database at ${describeTarget(connectionString)}.\n`
                + '  - Running?  docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db\n'
                + '  - Reachable from here? See DATABASE_URL_HOST in .env.example.\n',
            );
        } else {
            console.error(`\nReset failed, nothing was changed: ${message}\n`);
        }

        process.exit(1);
    } finally {
        await prisma.$disconnect();
    }
}

await main();
