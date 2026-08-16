-- ---------------------------------------------------------------------------
-- offering.allow_online — may the solver place this Offering in a virtual Room?
-- ---------------------------------------------------------------------------
--
-- The proto's Offering carries `allow_online`, and the app had no equivalent.
-- Without it the only honest value to send is false, which silently disables
-- online scheduling entirely: the solver would never place anything in a
-- virtual Room, and the three online-related constraints (OnlineOnsiteSameDay,
-- MaxOnlineShare, MinimizeOnline) would be transmitted but could never bind.
--
-- Online delivery is modelled as a virtual Room rather than a flag on the
-- Session (TAXONOMY.md §2), so this is NOT "is this session online" — it is
-- permission for the solver to choose a virtual Room when placing it. An
-- in-person exam should leave it false; a lecture that could run either way
-- sets it true.
--
-- Defaults to false: the conservative direction. A tenant opting an Offering
-- into online delivery is a decision someone makes, not one a migration makes
-- on their behalf.

SET search_path = public;

ALTER TABLE "offering"
    ADD COLUMN "allow_online" BOOLEAN NOT NULL DEFAULT false;
