# Verification record

What has actually been proven about this codebase, and how. Written down because "158 tests pass"
is a much weaker claim than it sounds — during this build, three tests were found to pass for the
wrong reason, and one whole feature was proven untested by deleting it and watching nothing break.

## Mutation testing — 2026-08-03

A passing test proves nothing unless it can fail. Each safety property below was verified by
deliberately breaking the implementation and confirming a test caught it. Every mutation was
checked to have actually applied before its result was trusted, and the working tree was restored
and re-verified (158 passing) afterwards.

| Property | Mutation applied | Result |
|---|---|---|
| Signup and approval emails are really sent | `sendBatch` short-circuited to never call the provider | Tests **failed** — guarded |
| A 2xx with a short `data` array is not treated as success | Payload-length check disabled | Tests **failed** — guarded |
| A recipient left `pending` by a crash is retried | Retry query made to treat `pending` as already sent | Tests **failed** — guarded |
| A trade can only be claimed once | `claimDraft`'s `status = 'draft'` relaxed to `!= 'cancelled'` | Tests **failed** — guarded |
| An unsubscribed/bounced address can rejoin | Resubscribe reset replaced with `DO NOTHING` | Tests **failed** — guarded |
| A stalled broadcast is resumed by the cron | Sweep loop made to iterate nothing | Tests **failed** — guarded |

Earlier in the build, the same technique confirmed three more: the Telegram callback chat-ID
allowlist, the ordering of the edge rate limiter ahead of the DNS lookup, and the `"by"` → Buy
fallback never overriding an explicit direction.

## Verified against reality, not mocks

- **Whisper accepts Telegram's audio format.** Real speech was synthesised, encoded to genuine
  Ogg/Opus (Telegram's actual voice-note format), and sent to the live Workers AI binding. It
  returned `Eurodollar by at 1.0850, stop loss 1.0800, take profit 1.0900.`
  That single check found three parser defects that 103 passing tests had missed — because every
  test fixture until then was text we had written ourselves. `tests/parse.test.ts` now contains
  that exact transcript as a regression test.
- **The signup form works end to end.** Driven in a real browser against a running `wrangler dev`,
  with the outgoing request body captured to confirm the honeypot field is present and empty.
- **D1 accepts the atomic statements the design depends on** — `UPDATE ... WHERE id IN (SELECT ...
  LIMIT ?) RETURNING ...`, and `batch()` as a single transaction.

## Known limits of this verification

- **Concurrency is argued, not demonstrated.** The draft-supersession race is closed by running
  both statements in one `db.batch()`, which Cloudflare documents as a single transaction. The
  local test runtime cannot force two real requests to interleave, so the test is a same-process
  regression guard. Firing genuinely concurrent requests at a deployed instance and asserting
  exactly one surviving draft is worth doing once before go-live.
- **Nothing has been deployed.** Every check above ran locally or against the Workers AI API. The
  first real deployment is still ahead — see `SETUP.md`.
- **No real subscriber has ever been emailed.** `DRY_RUN` has been on throughout.

## If you change something here

Do not adjust a failing test to match your implementation. Several tests in this repo exist
because they caught a real bug, and the comments say which. If you add a safety property, prove it
the same way: break the implementation, watch the test fail, restore it.
