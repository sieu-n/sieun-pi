# Replay of the two api-portal jump checks, 11-28

The owner asked on 11-28 in #1124-cost-management (p52, p54) that duties surface a jump in one part, because a PostHog sync cost up to $80 a day for 11 days while its duty read only a total. This file holds the replay that picked the numbers in `portal-status-board.ts` (d6, `FUNCTION_JUMP_TIMES`) and `customer-api-failures.ts` (d4, `JUMP_TIMES`, `JUMP_FLOOR`).

To regenerate it, run `node --import tsx scripts/duties/portal-jumps-replay.ts 21` from `legacy/prime/user-history`. The stored d4 and d6 run files only start on 11-26, so the replay reads the sources: Vercel's billing charges of 40 days and the keyed calls in prod ClickHouse `product.usage_events`, which start on 11-07.

## d6 function_time_jump, picked at 2 times

Each row is one Vercel billing day of `auto-sns-api` (08:00Z to 08:00Z), its billed instance hours and the median of the 7 days before it.

| Billing day | Hours | Median of 7 before | Times | At 2 | At 3 |
|---|---|---|---|---|---|
| 10-27 | 14.31 | 9.02 | 1.59 | | |
| 11-01 | 6.91 | 4.91 | 1.41 | | |
| 11-08 | 21.93 | 5.64 | 3.89 | jump | jump |
| 11-19 | 1.95 | 1.23 | 1.58 | | |
| 11-23 | 2.91 | 0.85 | 3.42 | jump | jump |
| 11-24 | 5.69 | 0.85 | 6.69 | jump | jump |
| 11-25 | 17.30 | 0.85 | 20.35 | jump | jump |
| 11-26 | 18.58 | 1.95 | 9.54 | jump | jump |
| 11-27 | 7.94 | 2.91 | 2.73 | jump | |

The 23 other days from 10-28 to 11-22 read 0.18 to 1.29 times. At 2 the check flags the six raised days, including 11-27, when the CRM job polls were still the biggest line at 7.94 h, under the 8 h line. At 3 it misses 11-27. The highest normal day read 1.59 times, so 2 leaves room.

## d4 org_operation_jumps, picked at 3 times with floors of 1000 calls and 20 5xx

Each pair is one org and one operation over every org's keyed calls, less `org_test_` orgs and one-run proof orgs whose id ends in a 13-digit time. A day with no row counts 0 in the 7-day median.

| UTC day | Pairs read | Jumps | What flagged |
|---|---|---|---|
| 11-14 | 365 | 0 | |
| 11-15 | 367 | 0 | |
| 11-16 | 359 | 1 | A customer's instagram.web_profile_info at 1,061 calls against a median of 28. |
| 11-17 | 373 | 5 | A customer's first YouTube use at 1,425 to 4,035 calls on four operations, and a new pair with 26 5xx. |
| 11-18 | 423 | 0 | |
| 11-19 | 435 | 0 | |
| 11-20 | 269 | 2 | crawl.fetch 5xx at 48 against 9, and YouTube shorts 5xx at 46 against 0 (step p26). |
| 11-21 | 266 | 3 | search.google 5xx at 119 against 36, crawl.fetch and YouTube shorts 5xx. |
| 11-22 | 264 | 3 | Instagram 5xx at 409 and 57 from 0, during the proxy lapse. |
| 11-23 | 427 | 3 | Instagram 5xx at 598, 556 and 159 from 0. |
| 11-24 | 508 | 2 | The health probe's 1,439 Instagram reads a day from 0, and 22 d2 search.google 5xx. |
| 11-25 | 520 | 5 | The websearch parity run's 4,699 searches and 2,440 fetches, 1,353 of them 5xx, and the health probe. |
| 11-26 | 544 | 5 | The CRM's 6,804 crawl.web_scraping_api calls with 114 5xx, the health probe and two small 5xx pairs. |
| 11-27 | 542 | 4 | The CRM's 14,638 jobs.results polls, 13,408 job starts and 12,512 web scrapes with 628 5xx. |

The times barely matter for calls, because every call jump but one came from a median of 0, so 3, 5 and 10 flag the same pairs. The floor decides it. At 500 calls the check also flags a customer's 841 Instagram reads on 11-23, and at 2000 it misses the health probe.

For 5xx the times matter. One customer's search.google reads 24 to 59 5xx every day, between 0.7 and 2.5 times its median, so 3 keeps that quiet and still flags its 119 on 11-21. A floor of 50 misses YouTube shorts' 46 on 11-20, and a floor of 5 flags 20 to 57 pairs a day from 11-20 to 11-23.

The 23 min GeoNode outage on 11-27 from 15:47Z gave no pair more than 9 5xx answers, so this daily check does not flag it. The hourly alert `api-portal-customer-calls-failing` paged it at 15:55Z.
