---
name: Host-side spend caps
description: Why an untrusted runner's model spending must be capped by rewriting its requests, not by measuring them.
---

A spend limit enforced against code you do not control has to hold even when
that code is hostile. Measurement alone never gets there. Four things are
required, and the first three were each found missing in review after the
previous one was fixed:

1. **Reserve before dispatch, settle after.** Counting usage on the way back
   leaves a window where many simultaneous calls all pass the same "not over
   yet" check. Hold an estimate while a call is in flight; replace it with the
   measured figure when the response lands.
2. **Rewrite the request, do not merely size it.** A single call declaring a
   million output tokens against a small budget still gets forwarded if you
   only estimate it. Clamp the ceiling down to what is left and let the model
   server — outside the sandbox — enforce it.
3. **Whatever you charged for is what you must forward.** Capping a multiplier
   for your own arithmetic while forwarding the caller's original value is the
   same bypass in a different field. Normalise *every* field that can raise the
   cost (both spellings of the output limit, `n`, `best_of`) and write the
   normalised values back into the body. Treat presence, not numeric type, as
   the trigger — a string slips past a `typeof` check and is honoured by the
   server.
4. **Never let one call reserve the whole budget.** Clamping to "all remaining
   tokens" makes concurrent siblings fail with 429s over a shortage that exists
   only on paper. Clamp to the model's own per-response ceiling as well.

**Why:** the container is the security boundary, but the boundary has no
opinion about money. If the host's accounting can be argued with by the thing
being metered, the operator's hardware is the one paying for the argument.

**How to apply:** whenever a host component meters an untrusted client's calls
to a paid or expensive resource. Also: say plainly in the docs what is *not*
guaranteed. Bytes are not tokens, so the prompt side stays an estimate; that is
a bounded, self-correcting error, but it is not a token-exact cap and must not
be advertised as one.
