/**
 * The default solver budget: one declaration, read by both sides.
 *
 * WHY `shared/` AND NOT A LITERAL IN THE ROUTE
 * --------------------------------------------
 * Two consumers must agree and previously only claimed to:
 *
 *   server/api/solver/runs/index.post.ts   the default when a caller sends none
 *   ScheduleSolverControl.vue              what the advanced disclosure shows
 *
 * The toolbar's comment said it was "seeded from the route's own defaults", but
 * nothing enforced that — they were two `50_000` literals that happened to
 * match. Raising one without the other would have been invisible in exactly the
 * worst way: the route's default would improve, every run started from the
 * toolbar would keep sending the old value explicitly, and the disclosure would
 * describe a budget no plain click ever used.
 *
 * WHY THE MOVE BUDGET IS 5,000,000
 * --------------------------------
 * Measured, not guessed — `bench large-university` (27,136 placements, an
 * instance two orders of magnitude larger than any real tenant here) at three
 * budgets, one seed, release build:
 *
 *   budget    wall      iterations   objective      violations   improvements
 *   50,000    263 ms            21   181,624,576           558             19
 *   2,000,000 861 ms           879   113,233,336           378            759
 *   5,000,000 1.88 s         2,181    83,214,288           299          1,656
 *
 * At 50,000 the search barely runs: 66% of the wall time is CONSTRUCTION and
 * LNS gets 16%, and the objective curve moves from 181,624,864 to 181,624,576 —
 * a 0.0002% improvement over the whole run. With `COOLING = 0.999` applied once
 * per iteration, 21 iterations leaves the temperature at 0.999^21 ≈ 0.98, so
 * the annealing schedule never reaches the exploitation phase it exists for.
 *
 * 5,000,000 is chosen over 2,000,000 because it is not yet into diminishing
 * returns: the second half of that run still improves the objective from
 * 108,293,148 to 83,214,288, and it ends 26% better with 21% fewer violations
 * for one extra second.
 *
 * WHY THE WALL BUDGET STAYS 10 SECONDS
 * ------------------------------------
 * It is the safety cap, not the operating limit, and raising the move budget is
 * what keeps it that way. Only a `move_budget` (or `converged`) termination is
 * reproducible — a wall-clock run is not, because how many moves fit in a
 * second is not a property of the input (CLAUDE.md, "Determinism"). So the
 * move budget must be the one that BINDS, and 1.88 s against a 10 s cap leaves
 * 5.3x headroom: the default still terminates on moves on hardware five times
 * slower than this machine.
 *
 * Small instances never reach it at all. The stagnation limit is
 * `200 + 20 x placements`, so a real tenant's ~276-placement term converges out
 * long before five million moves are spent.
 */
export const DEFAULT_MAX_MOVES = 5_000_000;

/** Backstop only — see above. Whichever budget is hit first ends the run. */
export const DEFAULT_MAX_WALL_MILLIS = 10_000;
