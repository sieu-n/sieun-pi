-- The virev query MCP's ClickHouse read layer: database q, two settings profiles and two users.
-- crawler-api's /api/query routes (apps/crawler-v3/src/http/routes/query.py) pick the user by the
-- X-Query-Tier header. Design: apps/llm-wiki/content/sessions/2026/10/16/0652-virev-query-mcp-short/report.md,
-- contract: apps/llm-wiki/content/sessions/2026/10/16/0843-virev-query-mcp-build/data/contract.md.
-- Applied with apply_query_mcp.py, which fills the placeholders and sends this file on ssh stdin:
--   __STANDARD_PW__  the password in QUERY_STANDARD_CLICKHOUSE_URL (apps/crawler-v3/.env.<tier>)
--   __FULL_PW__      the password in QUERY_FULL_CLICKHOUSE_URL (apps/crawler-v3/.env.<tier>)
--   __NET__          the tier's Docker bridge, where crawler-api runs (prod 10.81.0.0/24, staging 10.82.0.0/24)
-- Idempotent: a rerun converges to the same profiles, users, views and grants.
-- readonly = 1 CONST refuses INSERT, DDL, SET and every settings change, including a SETTINGS clause,
-- and with no CREATE TEMPORARY TABLE grant a table function such as url() or postgresql() is refused too.
-- The limit numbers come from system.query_log on prod, 2026-10-10 to 2026-10-15, 144,023 SELECTs of
-- the app user virev (apps/llm-wiki/content/sessions/2026/10/16/0513-virev-query-mcp/data/ours.md, 4.1).

CREATE SETTINGS PROFILE IF NOT EXISTS mcp_standard;
ALTER SETTINGS PROFILE mcp_standard SETTINGS
    readonly = 1 CONST,
    allow_ddl = 0 CONST,
    allow_introspection_functions = 0 CONST,
    max_execution_time = 10 CONST,          -- app query p99 6.34 s
    max_memory_usage = 1073741824 CONST,    -- 1 GiB, app query p99 538 MiB
    max_bytes_to_read = 2147483648 CONST,   -- 2 GiB, app query p99 617 MiB
    max_result_rows = 1000 CONST,           -- app result p99 500 rows
    output_format_json_quote_64bit_integers = 0 CONST,  -- crawler-api returns counts as JSON numbers
    local_filesystem_read_method = 'pread' CONST;       -- see the note below

-- Both profiles read local disk with pread in the query's own threads, not through the server's shared reader
-- pool. On prod on 2026-10-24 from 03:45Z, Grafana's 7-day otel_logs scans held that pool on the HDD: grafana_ro
-- queries waited 20,500 to 45,000 s of SynchronousReadWait per 15 min, against 300 to 1,700 s before. The
-- follower-bucket sql read the by_followers projection but stopped at standard's 10 s after 27K to 344K of its
-- 2.05M rows, with 8.5 to 12.3 s of SynchronousReadWait and 2 to 12 ms of disk read time (system.query_log,
-- 04:10Z to 04:49Z). The same hour a prod A/B of one cold read took 0.27 to 0.30 s with pread and 5.9 to 21.3 s
-- through the pool (Crawler ops).

CREATE SETTINGS PROFILE IF NOT EXISTS mcp_full;
ALTER SETTINGS PROFILE mcp_full SETTINGS
    readonly = 1 CONST,
    allow_ddl = 0 CONST,
    allow_introspection_functions = 0 CONST,
    max_execution_time = 30 CONST,          -- app query max 19.3 s; grafana_ro's cap is 30 s
    max_memory_usage = 4294967296 CONST,    -- 4 GiB, twice the app query max 1.92 GiB
    max_bytes_to_read = 34359738368 CONST,  -- 32 GiB, above the app query max 27.1 GiB
    max_result_rows = 10000 CONST,          -- 20x the app result p99 500; grafana_ro p99 591
    output_format_json_quote_64bit_integers = 0 CONST,
    local_filesystem_read_method = 'pread' CONST;

CREATE USER IF NOT EXISTS query_standard IDENTIFIED WITH sha256_password BY '__STANDARD_PW__' HOST IP '__NET__';
ALTER USER query_standard IDENTIFIED WITH sha256_password BY '__STANDARD_PW__' HOST IP '__NET__'
    DEFAULT DATABASE q SETTINGS PROFILE 'mcp_standard';
CREATE USER IF NOT EXISTS query_full IDENTIFIED WITH sha256_password BY '__FULL_PW__' HOST IP '__NET__';
ALTER USER query_full IDENTIFIED WITH sha256_password BY '__FULL_PW__' HOST IP '__NET__'
    DEFAULT DATABASE q SETTINGS PROFILE 'mcp_full';

CREATE DATABASE IF NOT EXISTS q ENGINE = Atomic COMMENT 'Read-only views over crawler-v3 published tables for the query MCP';

-- Each view runs as its definer (the admin user that applies this file), so the query users
-- need SELECT on q.* only and never see crawler.*. Ops tables (proxy, token, engage, job and
-- meter tables) have no view here.
-- The crawler's snapshot tables, one account and one content table per platform: counters and text per
-- read, keyed by the platform's own ids (src/events/snapshots.py). Instagram's posts are in a monthly and a
-- daily table since 2026-10-25, and q.instagram_content_snapshots reads the Merge table over both. The latest
-- value is argMax(<column>, observed_at) over the key; a read that carried no text has NULL text, and the arrays
-- come from the newest row whose caption is not NULL. snapshot_entity_counts holds the account and post
-- counts per platform (a distinct-count sketch, about 0.3% off), and enrichment_accounts maps an enriched
-- profile (entity_enrichment_latest's entity_id) to its platform account ids, as text.
CREATE OR REPLACE VIEW q.instagram_account_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.instagram_account_snapshots AS reads
COMMENT 'For followers, following or posts_count over time (daily followers, growth, a follower history), read q.instagram_account_days, not this view: a GROUP BY toDate(observed_at) here reads every snapshot of every part and can pass the tier''s time limit. This view holds every read of an Instagram account, keyed by Instagram''s own account_id, with followers, following, posts_count, handle, full_name, biography, category and external_url at observed_at. Read it for the text columns or for one read''s exact time, and filter by account_id.';
-- One row per Instagram account per UTC day it was read, with the day's newest followers, following and posts_count,
-- from crawler.instagram_account_days (apps/crawler-v3/src/events/post_state.py), which a view on the account
-- snapshot insert keeps. Each counter is post_state.LATEST: under 2^64 means no read that day showed it. The GROUP BY
-- merges rows that merges have not joined yet, so no read needs FINAL, and a filter on account_id and day reaches the
-- sort key (account_id, day) through it. The table is not partitioned and its parts are compact, so an account costs
-- one file open and one granule per part.
-- measured: prod 2026-11-10 10:57Z, a customer's 40 days of daily followers for 5 accounts from
-- q.instagram_account_snapshots read 115 granules of 26 parts in 365 reads and stopped at standard's 10 s; cold
-- reads of 5 other accounts took 4.5 to 4.8 s at 24 parts, 90 file opens and 104 to 111 reads, and 5 more
-- accounts of the 8-part crawler.instagram_account_state took 1.1 s at 12 opens and 21 reads. On a 26.3.9.8 rig of 13.4M snapshots the same
-- read of this view opened 5 files for 5 parts where the snapshots opened 28 for 7.
CREATE OR REPLACE VIEW q.instagram_account_days DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT account_id, day,
    if(max(followers) < bitShiftLeft(toUInt128(1), 64), NULL,
        toUInt64(bitAnd(max(followers), toUInt128('18446744073709551615')))) AS followers,
    if(max(following) < bitShiftLeft(toUInt128(1), 64), NULL,
        toUInt64(bitAnd(max(following), toUInt128('18446744073709551615')))) AS following,
    if(max(posts_count) < bitShiftLeft(toUInt128(1), 64), NULL,
        toUInt64(bitAnd(max(posts_count), toUInt128('18446744073709551615')))) AS posts_count
FROM crawler.instagram_account_days
GROUP BY account_id, day
COMMENT 'One row per Instagram account per UTC day it was read: the day''s newest followers, following and posts_count (NULL when no read that day showed it), keyed by Instagram''s own account_id. Read follower growth and any per-day history here, never from q.instagram_account_snapshots, which holds every read and takes many times longer. Filter by account_id (= or IN) and by day, for example WHERE account_id IN (...) AND day >= today() - 40 ORDER BY account_id, day. A day with no read has no row.';
CREATE OR REPLACE VIEW q.instagram_content_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.instagram_content_snapshots_all;
CREATE OR REPLACE VIEW q.tiktok_account_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.tiktok_account_snapshots;
CREATE OR REPLACE VIEW q.tiktok_content_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.tiktok_content_snapshots;
CREATE OR REPLACE VIEW q.youtube_account_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.youtube_account_snapshots;
CREATE OR REPLACE VIEW q.youtube_content_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.youtube_content_snapshots;
CREATE OR REPLACE VIEW q.linkedin_account_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.linkedin_account_snapshots;
CREATE OR REPLACE VIEW q.linkedin_content_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.linkedin_content_snapshots;
CREATE OR REPLACE VIEW q.facebook_account_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.facebook_account_snapshots;
CREATE OR REPLACE VIEW q.facebook_content_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.facebook_content_snapshots;
CREATE OR REPLACE VIEW q.xiaohongshu_account_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.xiaohongshu_account_snapshots;
CREATE OR REPLACE VIEW q.xiaohongshu_content_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.xiaohongshu_content_snapshots;
CREATE OR REPLACE VIEW q.douyin_account_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.douyin_account_snapshots;
CREATE OR REPLACE VIEW q.douyin_content_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.douyin_content_snapshots;
CREATE OR REPLACE VIEW q.snapshot_entity_counts DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.snapshot_entity_counts;
CREATE OR REPLACE VIEW q.enrichment_accounts DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.enrichment_accounts;
-- The views over the observation tables, their _latest views and profile_enriched are gone: the crawler
-- stops writing those tables in land B. A view holds no rows, so dropping one loses no data.
DROP VIEW IF EXISTS q.instagram_profile_latest;
DROP VIEW IF EXISTS q.instagram_content_latest;
DROP VIEW IF EXISTS q.tiktok_profile_latest;
DROP VIEW IF EXISTS q.tiktok_content_latest;
DROP VIEW IF EXISTS q.youtube_profile_latest;
DROP VIEW IF EXISTS q.youtube_content_latest;
DROP VIEW IF EXISTS q.linkedin_profile_latest;
DROP VIEW IF EXISTS q.linkedin_content_latest;
DROP VIEW IF EXISTS q.facebook_profile_latest;
DROP VIEW IF EXISTS q.facebook_content_latest;
DROP VIEW IF EXISTS q.xiaohongshu_profile_latest;
DROP VIEW IF EXISTS q.xiaohongshu_content_latest;
DROP VIEW IF EXISTS q.douyin_profile_latest;
DROP VIEW IF EXISTS q.douyin_content_latest;
DROP VIEW IF EXISTS q.profile_latest;
DROP VIEW IF EXISTS q.content_latest;
DROP VIEW IF EXISTS q.profile_observations;
DROP VIEW IF EXISTS q.content_observations;
DROP VIEW IF EXISTS q.profile_enriched;
CREATE OR REPLACE VIEW q.entity_enrichment_latest DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.entity_enrichment_latest;
-- The census account, post and post-count tables are copied into the snapshot tables and dropped
-- by the one-time census text copy: q.instagram_account_snapshots and
-- q.instagram_content_snapshots carry their text.
DROP VIEW IF EXISTS q.instagram_census_accounts;
DROP VIEW IF EXISTS q.instagram_census_posts;
DROP VIEW IF EXISTS q.instagram_census_post_metrics;
CREATE OR REPLACE VIEW q.brand_tagged_post_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.brand_tagged_post_snapshots;
CREATE OR REPLACE VIEW q.meta_ad_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.meta_ad_snapshots;
CREATE OR REPLACE VIEW q.meta_advertiser_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.meta_advertiser_snapshots;
-- meta_ad_snapshots replaced both, and the schema bootstrap dropped their tables.
DROP VIEW IF EXISTS q.meta_ad_observations;
DROP VIEW IF EXISTS q.meta_ad_lifetimes;
CREATE OR REPLACE VIEW q.tiktok_shop_product_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.tiktok_shop_product_snapshots;
CREATE OR REPLACE VIEW q.tiktok_shop_seller_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.tiktok_shop_seller_snapshots;
CREATE OR REPLACE VIEW q.tiktok_shop_sku_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.tiktok_shop_sku_snapshots;
CREATE OR REPLACE VIEW q.tiktok_shop_video_product_snapshots DEFINER = CURRENT_USER SQL SECURITY DEFINER AS SELECT * FROM crawler.tiktok_shop_video_product_snapshots;

-- q.instagram_post_counts was a table that a refreshable view rebuilt whole once a day, 4.30B rows from 5.03B
-- state rows in 26,142 s on prod on 11-03 (query 39ac05f8). Its posts and followers now come from the state tables
-- at read time (the view below), so only this per-account table is rebuilt each night. A post's counters live in
-- crawler.instagram_post_state and change in place as MVs fold each snapshot insert in, and a whole-index question
-- reads this table instead: per account, its posts and the sums of their latest likes, comments and plays, with the
-- account's latest followers joined when the table is built. It is rebuilt whole, because a merge of only the day's
-- changed posts needs each one's old counts, and reading those reads every granule. measured: prod 2026-11-03, 2,443
-- of the 2,478 8192-row granules of post_state in one account range held a post read that day (87.5% of 1024-row
-- granules). Rebuilding only the accounts read since the last pass reads the same granules: on prod on 11-04 about
-- 24.0M of the 223.4M accounts with posts got a post read, and at 22.7 posts per account an 8192-row granule spans
-- about 360 accounts. A full pass on prod (11-04 seed) read 5.24B rows in 11,928 s with 4,418 CPU-seconds.
DROP VIEW IF EXISTS q.instagram_post_counts_refresh;
CREATE TABLE IF NOT EXISTS q.instagram_account_post_counts
(
    account_id UInt64 COMMENT 'the account''s Instagram id, instagram_accounts.ig_id' CODEC(Delta(8), ZSTD(1)),
    followers UInt32 COMMENT 'the account''s latest follower count when the table was built, 0 when unknown' CODEC(Delta(4), ZSTD(1)),
    posts UInt32 COMMENT 'the account''s posts' CODEC(T64, ZSTD(1)),
    likes_posts UInt32 COMMENT 'its posts with a visible like count' CODEC(T64, ZSTD(1)),
    likes_sum UInt64 COMMENT 'the sum of those posts'' latest likes' CODEC(T64, ZSTD(1)),
    comments_posts UInt32 COMMENT 'its posts with a visible comment count' CODEC(T64, ZSTD(1)),
    comments_sum UInt64 COMMENT 'the sum of those posts'' latest comments' CODEC(T64, ZSTD(1)),
    plays_posts UInt32 COMMENT 'its posts with a play count' CODEC(T64, ZSTD(1)),
    plays_sum UInt64 COMMENT 'the sum of those posts'' latest plays' CODEC(T64, ZSTD(1)),
    likes_median_state AggregateFunction(quantileTDigest(0.5), UInt32)
        COMMENT 'quantileTDigestMerge(0.5)(likes_median_state) is the median of the latest likes over any set of accounts'
        CODEC(ZSTD(1))
)
ENGINE = MergeTree
ORDER BY (followers, account_id);
-- One row per follower count per part with the sums a follower-bucket question uses, so a GROUP BY over any function
-- of followers with only these aggregates reads the projection and not every account. measured: on a 26.3.9.8 rig
-- of 40M posts and 727,834 accounts (2026-11-04) the bucket sql read 205,510 projection rows and gave the same
-- posts, avg likes and likes per follower per bucket as the old per-post table, with the median within 0.1%.
ALTER TABLE q.instagram_account_post_counts ADD PROJECTION IF NOT EXISTS by_followers
    (
        SELECT followers, count(), sum(posts), sum(likes_posts), sum(likes_sum), sum(likes_sum / followers),
            quantileTDigestMerge(0.5)(likes_median_state), sum(comments_posts), sum(comments_sum),
            sum(comments_sum / followers), sum(plays_posts), sum(plays_sum), min(followers), max(followers)
        GROUP BY followers
    );
ALTER TABLE q.instagram_account_post_counts MODIFY COMMENT 'One row per Instagram account with posts: followers, posts, and the sums of its posts'' latest likes, comments and plays, keyed by Instagram''s own ids and sorted by followers. Rebuilt once a day at 00:00 UTC from crawler.instagram_post_state and crawler.instagram_account_state, so counts are up to a day old. For post counts, averages and follower buckets read q.instagram_follower_counts, which holds this table''s sums per follower count in one small part. Read accounts and medians here, never from q.instagram_post_counts, which aggregates every post per read: the number of posts is sum(posts) (also for followers > N), avg likes is sum(likes_sum) / sum(likes_posts), avg likes per follower is sum(likes_sum / followers) / sum(likes_posts) with followers > 0, the median likes is quantileTDigestMerge(0.5)(likes_median_state), and top accounts are ORDER BY followers DESC LIMIT n. A GROUP BY over followers or any function of it answers from a pre-aggregated projection when it uses only count(), sum(posts), sum(likes_posts), sum(likes_sum), sum(likes_sum / followers), quantileTDigestMerge(0.5)(likes_median_state), sum(comments_posts), sum(comments_sum), sum(comments_sum / followers), sum(plays_posts), sum(plays_sum), min(followers) and max(followers).';

-- A ClickHouse start stops this view (metal-refresh.xml), because with no Keeper it forgot its last refresh and
-- rebuilt the table within minutes of every start; the hourly host unit virev-q-refresh starts it again once no
-- part of the table was written since 00:00 UTC, so a restart costs no pass and the table keeps one a day.
-- The CREATE makes the view empty, and the MODIFY QUERY below sets its query on every apply, so a changed query
-- reaches a server where the view already exists. A MODIFY QUERY starts no refresh: on 26.3.9.8 the view kept
-- its last and next refresh times.
CREATE MATERIALIZED VIEW IF NOT EXISTS q.instagram_account_post_counts_refresh
REFRESH EVERY 24 HOUR TO q.instagram_account_post_counts EMPTY AS
SELECT * FROM q.instagram_account_post_counts;
-- FINAL merges each post's state rows in key order, so the GROUP BY account_id runs in order and holds one account at
-- a time, and the pass reads only the key and counter columns (first_posted_at, 18.2 GB of post_state's 88.9 GB on
-- prod, stays unread). Each counter is post_state.LATEST: under 2^64 means no read showed it, and the low 64 bits
-- are the value. likes and comments are capped to UInt32 as q.instagram_post_counts caps them.
-- measured: staging 2026-11-04 01:50Z, 78.5M post_state rows: 87.0 s, 80.4M rows read, 48.5 CPU-seconds, 111 MiB,
-- 1.25 GiB read from disk, against the old pass's 408.9 s, 179 CPU-seconds, 2.20 GiB and 74.2M rows written
-- (system.query_log). On prod one account range of 10.0M posts (0.21% of post_state) took 7.1 CPU-seconds and
-- 220 MiB of disk reads with 2 threads.
-- The join is a partial_merge join, which sorts the accounts side in blocks and spills it to disk, so its memory
-- stays flat as accounts grow: the hash join of the old pass held 93.4M accounts and failed with code 241 at 17 GiB
-- on prod on 2026-10-23.
-- One thread, so a pass holds about one core and leaves the rest to Postgres. measured: with 8 threads the old pass
-- took prod's idle cores from 4.3 to 0.6-0.9 of 72 while Meta walks fell from 414 to 259 a minute (2026-10-26,
-- node-exporter, Crawler ops).
ALTER TABLE q.instagram_account_post_counts_refresh MODIFY QUERY
SELECT p.account_id AS account_id, toUInt32(least(ifNull(a.followers, 0), 4294967295)) AS followers,
    p.posts AS posts, p.likes_posts AS likes_posts, p.likes_sum AS likes_sum, p.comments_posts AS comments_posts,
    p.comments_sum AS comments_sum, p.plays_posts AS plays_posts, p.plays_sum AS plays_sum,
    p.likes_median_state AS likes_median_state
FROM
(
    SELECT account_id, toUInt32(count()) AS posts, toUInt32(count(likes)) AS likes_posts, toUInt64(ifNull(sum(likes), 0)) AS likes_sum,
        toUInt32(count(comments)) AS comments_posts, toUInt64(ifNull(sum(comments), 0)) AS comments_sum,
        toUInt32(count(plays)) AS plays_posts, toUInt64(ifNull(sum(plays), 0)) AS plays_sum,
        quantileTDigestStateIf(0.5)(assumeNotNull(likes), isNotNull(likes)) AS likes_median_state
    FROM
    (
        SELECT account_id,
            if(likes < bitShiftLeft(toUInt128(1), 64), NULL,
                toUInt32(least(bitAnd(likes, toUInt128('18446744073709551615')), 4294967295))) AS likes,
            if(comments < bitShiftLeft(toUInt128(1), 64), NULL,
                toUInt32(least(bitAnd(comments, toUInt128('18446744073709551615')), 4294967295))) AS comments,
            if(plays < bitShiftLeft(toUInt128(1), 64), NULL, toUInt64(bitAnd(plays, toUInt128('18446744073709551615')))) AS plays
        FROM crawler.instagram_post_state FINAL
    )
    GROUP BY account_id
) AS p
LEFT JOIN
(
    SELECT account_id,
        if(max(followers) < bitShiftLeft(toUInt128(1), 64), NULL,
            toUInt64(bitAnd(max(followers), toUInt128('18446744073709551615')))) AS followers
    FROM crawler.instagram_account_state
    GROUP BY account_id
) AS a ON p.account_id = a.account_id
SETTINGS optimize_aggregation_in_order = 1, join_algorithm = 'partial_merge', max_threads = 1;

-- One row per follower count with the sums of q.instagram_account_post_counts' accounts at that count, so a
-- follower-bucket, post-count or average question reads one small part. The rollup's projection by_followers holds
-- the same sums, but once per part, and the rollup keeps the parts its refresh wrote: the refresh swaps its new
-- table in with merges cancelled, and they stay off until the server restarts.
-- measured: prod 2026-11-10, the rollup held 21 parts from 01:29Z on, the bucket example read 2,087,035 projection
-- rows in 261 granules and took 2.6 to 5.4 s cold (system.query_log), and its only merges under the final name began
-- at the server starts of 11-08 07:11:24Z and 11-09 21:29:06Z (system.part_log). The rollup held 549,535 follower
-- counts over 270,296,829 accounts. On a local 26.3.9.8 rig OPTIMIZE FINAL on a refreshed table answered code 236,
-- "Cancelled merging parts".
-- The median state stays in the rollup only: quantileTDigestMergeState does not match the projection, so a pass that
-- copied it would read every account (EXPLAIN on the rig: 745 of 745 granules, against 258 without it).
CREATE TABLE IF NOT EXISTS q.instagram_follower_counts
(
    followers UInt32 COMMENT 'a follower count, 0 for accounts whose followers are unknown',
    accounts UInt64 COMMENT 'the accounts with posts at this follower count',
    posts UInt64 COMMENT 'their posts',
    likes_posts UInt64 COMMENT 'their posts with a visible like count',
    likes_sum UInt64 COMMENT 'the sum of those posts'' latest likes',
    likes_per_follower_sum Float64 COMMENT 'the sum over accounts of likes_sum / followers',
    comments_posts UInt64 COMMENT 'their posts with a visible comment count',
    comments_sum UInt64 COMMENT 'the sum of those posts'' latest comments',
    comments_per_follower_sum Float64 COMMENT 'the sum over accounts of comments_sum / followers',
    plays_posts UInt64 COMMENT 'their posts with a play count',
    plays_sum UInt64 COMMENT 'the sum of those posts'' latest plays'
)
ENGINE = MergeTree
ORDER BY followers;
ALTER TABLE q.instagram_follower_counts MODIFY COMMENT 'One row per follower count: the Instagram accounts with posts that have exactly that many followers, and the sums of their posts'' latest likes, comments and plays. It holds every account of q.instagram_account_post_counts, rebuilt from it each hour, so counts are up to a day old. Read whole-index questions here: a follower bucket is a GROUP BY over any function of followers, the number of posts is sum(posts) (also for followers > N), the number of accounts is sum(accounts), avg likes is sum(likes_sum) / sum(likes_posts), and avg likes per follower is sum(likes_per_follower_sum) / sum(likes_posts) with followers > 0. For single accounts, top accounts and median likes read q.instagram_account_post_counts.';

-- The pass reads the rollup's projection, not its accounts, and the CREATE makes the view empty, as the rollup's does.
-- Every row goes in as one block, so each pass writes one part: bytes 0 switches the size trigger off and the row
-- trigger sits far above the row count. measured: local 26.3.9.8 rig, 6M accounts in 22 parts with 1,208,286
-- follower counts: the default block sizes wrote 2 parts, both at 0 wrote 114, and these wrote 1.
-- It runs each hour with no start-up stop, because a pass reads only the projection.
CREATE MATERIALIZED VIEW IF NOT EXISTS q.instagram_follower_counts_refresh
REFRESH EVERY 1 HOUR TO q.instagram_follower_counts EMPTY AS
SELECT * FROM q.instagram_follower_counts;
ALTER TABLE q.instagram_follower_counts_refresh MODIFY QUERY
SELECT a.followers AS followers, count() AS accounts, sum(a.posts) AS posts, sum(a.likes_posts) AS likes_posts,
    sum(a.likes_sum) AS likes_sum, sum(a.likes_sum / a.followers) AS likes_per_follower_sum,
    sum(a.comments_posts) AS comments_posts, sum(a.comments_sum) AS comments_sum,
    sum(a.comments_sum / a.followers) AS comments_per_follower_sum,
    sum(a.plays_posts) AS plays_posts, sum(a.plays_sum) AS plays_sum
FROM q.instagram_account_post_counts AS a
GROUP BY a.followers
SETTINGS min_insert_block_size_rows = 1000000000, min_insert_block_size_bytes = 0;
-- A deploy that makes the view or changes its query fills the table at once and not at the next full hour.
SYSTEM REFRESH VIEW q.instagram_follower_counts_refresh;

-- One row per Instagram post with its latest likes, comments and plays and its account's latest followers, read live
-- from crawler.instagram_post_state and crawler.instagram_account_state (apps/crawler-v3/src/events/post_state.py),
-- which views on every Instagram snapshot table keep at one row per post and per account once their merges catch up.
-- Each GROUP BY merges a post's or an account's rows that merges have not joined yet, so no read needs FINAL. Both
-- ids are Instagram's own (instagram_accounts.ig_id and instagram_content.ig_post_id); q_pg.creators carries ig_id for
-- the join. A counter is NULL when no read of the post showed it (hidden likes, plays on a photo), and followers is 0
-- when no read of the account showed it. The decode is the one the daily table's refresh ran, so the rows are the same.
-- A filter on account_id (= or IN, a subquery included) reaches both primary keys through the GROUP BYs and the join.
-- measured: staging 2026-11-04, 78.5M post_state rows on HDD, EXPLAIN indexes = 1: one account read 7 of 9,592 post
-- granules and 6 of 236 account granules, 86K rows in 0.16 to 0.92 s cold (p50 0.35 s); 300 accounts read 902 of
-- 9,592 granules, 5.0M to 9.1M rows, in 3.3 to 9.4 s, nearly all of it HDD seeks. The daily table this replaces was
-- sorted by followers, so the same one-account read scanned 70.3M of its 74.2M rows on staging and about 4.1B on prod.
-- measured: prod 2026-11-04, 4.84B post_state rows in 181 parts: one account read 110 to 127 of 590,587 post granules
-- and 11 of 39,554 account granules, 0.69M to 0.75M rows in 3.3 to 3.4 s at max_threads 2, most of it disk reads. An
-- account has a granule in nearly every part, so the read time follows the part count, not the account's posts.
-- A read with no account_id filter aggregates every post (4.8B state rows on prod) and stops at the tier's limits,
-- so counts, follower buckets and top accounts read q.instagram_account_post_counts.
CREATE OR REPLACE VIEW q.instagram_post_counts DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT p.account_id AS account_id, p.content_id AS content_id, p.posted_at AS posted_at, p.likes AS likes,
    p.comments AS comments, p.plays AS plays, toUInt32(least(ifNull(a.followers, 0), 4294967295)) AS followers
FROM
(
    SELECT account_id, content_id,
        nullIf(tupleElement(min(first_posted_at), 'at'), toDateTime(0, 'UTC')) AS posted_at,
        if(max(likes) < bitShiftLeft(toUInt128(1), 64), NULL,
            toUInt32(least(bitAnd(max(likes), toUInt128('18446744073709551615')), 4294967295))) AS likes,
        if(max(comments) < bitShiftLeft(toUInt128(1), 64), NULL,
            toUInt32(least(bitAnd(max(comments), toUInt128('18446744073709551615')), 4294967295))) AS comments,
        if(max(plays) < bitShiftLeft(toUInt128(1), 64), NULL,
            toUInt64(bitAnd(max(plays), toUInt128('18446744073709551615')))) AS plays
    FROM crawler.instagram_post_state
    GROUP BY account_id, content_id
) AS p
LEFT JOIN
(
    SELECT account_id,
        if(max(followers) < bitShiftLeft(toUInt128(1), 64), NULL,
            toUInt64(bitAnd(max(followers), toUInt128('18446744073709551615')))) AS followers
    FROM crawler.instagram_account_state
    GROUP BY account_id
) AS a ON p.account_id = a.account_id
COMMENT 'One row per Instagram post (latest known likes, comments, plays) with the posting account''s latest followers (0 when unknown), keyed by Instagram''s own ids and read live from the crawler''s per-post state. Filter by account_id (= or IN, a subquery included): the filter reaches the post and account keys, so a read touches only those accounts'' posts. A read with no account_id filter aggregates every post and stops at the tier''s limits; for post counts, follower buckets and the accounts with the most followers read q.instagram_account_post_counts.';

-- q.instagram_posts stops refreshing. Its table stays until land B drops it with the observation tables,
-- and the REVOKE below hides it from both query users, so no one reads a frozen copy.
DROP VIEW IF EXISTS q.instagram_posts_refresh;

-- Per-account engagement, from q.instagram_post_counts. Its GROUP BY keys on account_id, so a filter on account_id
-- reaches both state tables' keys through it and the posts view: on staging on 2026-11-04 (EXPLAIN indexes = 1) three
-- accounts read 15 of 9,591 post granules and 8 of 236 account granules, 128K to 193K rows in 0.57 to 1.79 s, and
-- one account 86K rows in 0.21 to 0.47 s. With no account filter it aggregates every post, past both tiers' limits on
-- prod, so filter by account_id or an IN list of accounts. Postgres agent_read.ig_engagement aggregates all of
-- instagram_content on every read, because Postgres cannot push an account filter into its GROUP BY: 53.9 s
-- over 14.4M rows on staging (EXPLAIN ANALYZE, 2026-10-18), past query_ro's 30 s statement_timeout.
-- agent_read.creators no longer joins it: since f8873ee36d it reads the same columns per account through
-- ix_instagram_content_recent_stats.
-- ClickHouse holds no is_video, so posts and reels count together here; q_pg.creator_posts has is_video.
-- engagement_rate is the profile doc's rate (apps/crawler-v3/src/index/sync/content_stats.py), which
-- agent_read.creators has read since b8104af03: median likes plus 3 times median comments of the account's newest
-- 240 posts (RECENT_CONTENT_STATS_WINDOW in apps/crawler-v3/src/catalog/tuning.py), over followers, in percent.
-- The mean of every post read 1295% on staging on 2026-10-30 for a 22.5K-follower account whose only 3 visible
-- like counts held one 868K-like photo, where the app showed 12.6%. Every engagement view below uses the same
-- formula. A NULL counter is unknown and skipped, so the rate is NULL when no post in the window shows a like
-- count or followers are 0, never 0. quantileExactInclusive interpolates as Postgres percentile_cont does.
-- Postgres breaks a posted_at tie on its own row id, which ClickHouse does not hold, so a tie here keeps the lower
-- content_id. engagement_posts counts the window's posts with a visible like count.
-- To read creators from q_pg.creators, pick them with account_id IN (SELECT toUInt64OrZero(ig_id) FROM q_pg.creators
-- WHERE ...), which the filter carries to both keys; a plain JOIN on it aggregates every post first.
CREATE OR REPLACE VIEW q.instagram_engagement DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT account_id, post_count, avg_likes, avg_comments, avg_plays, last_posted_at, followers,
    if(followers > 0, round((median_likes + 3 * ifNull(median_comments, 0)) / followers * 100, 3), NULL)
        AS engagement_rate,
    median_likes, median_comments, engagement_posts
FROM
(
    SELECT account_id,
        toUInt32(count()) AS post_count,
        avgOrNull(likes) AS avg_likes,
        avgOrNull(comments) AS avg_comments,
        avgOrNull(plays) AS avg_plays,
        max(posted_at) AS last_posted_at,
        max(followers) AS followers,
        groupArraySorted(240)((-toInt64(ifNull(posted_at, toDateTime(0, 'UTC'))), content_id, likes, comments))
            AS recent,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.3, recent)) AS median_likes,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.4, recent)) AS median_comments,
        toUInt32(arrayCount(p -> isNotNull(p.3), recent)) AS engagement_posts
    FROM q.instagram_post_counts
    GROUP BY account_id
) AS w
COMMENT 'One row per Instagram account with posts, keyed by its Instagram id: post count, average likes, comments and plays (a NULL counter skipped), last post time, followers, engagement_rate (median likes plus 3 times median comments of the newest 240 posts, over followers, in percent; NULL when no post in that window shows a like count or followers are unknown), median_likes, median_comments and engagement_posts (the posts in that window with a visible like count; rank by engagement_rate only where engagement_posts is 3 or more). Filter by account_id (= or IN): the filter reaches the post and account keys, and a read with no account filter aggregates every post and stops at the tier''s limits. To read creators from q_pg.creators, filter account_id IN (SELECT toUInt64OrZero(ig_id) FROM q_pg.creators WHERE ...).';

-- Per-account TikTok engagement, read straight from the snapshot tables. Both GROUP BYs key on account_id, the
-- first column of each table's sort key, so a filter on account_id reaches both reads: on staging on 2026-10-27
-- EXPLAIN indexes = 1 with account_id = 107955 read 4 of 800 content granules and 6 of 50 account granules.
-- With no account filter it reads every snapshot: 246.2M content rows, 3.4 GB on prod (2026-10-27), past
-- mcp_standard's 2 GiB, so filter by account or by an IN list of accounts.
-- Join q_pg.tiktok_creators on toUInt64OrZero(tiktok_id) = account_id.
CREATE OR REPLACE VIEW q.tiktok_engagement DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT c.account_id AS account_id, c.post_count AS post_count, c.avg_likes AS avg_likes,
    c.avg_comments AS avg_comments, c.avg_plays AS avg_plays, c.last_posted_at AS last_posted_at,
    toUInt64(ifNull(a.followers, 0)) AS followers,
    if(followers > 0, round((c.median_likes + 3 * ifNull(c.median_comments, 0)) / followers * 100, 3), NULL)
        AS engagement_rate,
    c.median_likes AS median_likes, c.median_comments AS median_comments, c.engagement_posts AS engagement_posts
FROM
(
    SELECT account_id, toUInt32(count()) AS post_count, avgOrNull(likes) AS avg_likes,
        avgOrNull(comments) AS avg_comments, avgOrNull(plays) AS avg_plays, max(posted_at) AS last_posted_at,
        groupArraySorted(240)((-toInt64(ifNull(posted_at, toDateTime(0, 'UTC'))), content_id, likes, comments))
            AS recent,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.3, recent)) AS median_likes,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.4, recent)) AS median_comments,
        toUInt32(arrayCount(p -> isNotNull(p.3), recent)) AS engagement_posts
    FROM
    (
        SELECT account_id, content_id, max(posted_at) AS posted_at, argMax(likes, observed_at) AS likes,
            argMax(comments, observed_at) AS comments, argMax(plays, observed_at) AS plays
        FROM crawler.tiktok_content_snapshots
        GROUP BY account_id, content_id
    )
    GROUP BY account_id
) AS c
LEFT JOIN
(
    SELECT account_id, argMax(followers, observed_at) AS followers
    FROM crawler.tiktok_account_snapshots
    GROUP BY account_id
) AS a ON c.account_id = a.account_id
COMMENT 'One row per TikTok account with videos, keyed by its TikTok id: video count, average likes, comments and plays (a NULL counter skipped), last video time, followers, engagement_rate (median likes plus 3 times median comments of the newest 240 posts, over followers, in percent; NULL when no post in that window shows a like count or followers are unknown), median_likes, median_comments and engagement_posts (the posts in that window with a visible like count; rank by engagement_rate only where engagement_posts is 3 or more). Filter by account_id, because a read over every account passes the read budget. Join q_pg.tiktok_creators on toUInt64OrZero(tiktok_id) = account_id.';

-- Per-account Douyin engagement, the TikTok view's twin over the Douyin snapshot tables, keyed by sec_uid: the
-- same GROUP BYs on account_id, the first sort-key column, so filter by account_id. Douyin answers play_count 0
-- for nearly every post and the crawler stores that as NULL, so avg_plays is usually NULL.
-- Join q_pg.douyin_creators on sec_uid = account_id.
CREATE OR REPLACE VIEW q.douyin_engagement DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT c.account_id AS account_id, c.post_count AS post_count, c.avg_likes AS avg_likes,
    c.avg_comments AS avg_comments, c.avg_plays AS avg_plays, c.last_posted_at AS last_posted_at,
    toUInt64(ifNull(a.followers, 0)) AS followers,
    if(followers > 0, round((c.median_likes + 3 * ifNull(c.median_comments, 0)) / followers * 100, 3), NULL)
        AS engagement_rate,
    c.median_likes AS median_likes, c.median_comments AS median_comments, c.engagement_posts AS engagement_posts
FROM
(
    SELECT account_id, toUInt32(count()) AS post_count, avgOrNull(likes) AS avg_likes,
        avgOrNull(comments) AS avg_comments, avgOrNull(plays) AS avg_plays, max(posted_at) AS last_posted_at,
        groupArraySorted(240)((-toInt64(ifNull(posted_at, toDateTime(0, 'UTC'))), content_id, likes, comments))
            AS recent,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.3, recent)) AS median_likes,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.4, recent)) AS median_comments,
        toUInt32(arrayCount(p -> isNotNull(p.3), recent)) AS engagement_posts
    FROM
    (
        SELECT account_id, content_id, max(posted_at) AS posted_at, argMax(likes, observed_at) AS likes,
            argMax(comments, observed_at) AS comments, argMax(plays, observed_at) AS plays
        FROM crawler.douyin_content_snapshots
        GROUP BY account_id, content_id
    )
    GROUP BY account_id
) AS c
LEFT JOIN
(
    SELECT account_id, argMax(followers, observed_at) AS followers
    FROM crawler.douyin_account_snapshots
    GROUP BY account_id
) AS a ON c.account_id = a.account_id
COMMENT 'One row per Douyin account with posts, keyed by its sec_uid: post count, average likes, comments and plays (a NULL counter skipped), last post time, followers, engagement_rate (median likes plus 3 times median comments of the newest 240 posts, over followers, in percent; NULL when no post in that window shows a like count or followers are unknown), median_likes, median_comments and engagement_posts (the posts in that window with a visible like count; rank by engagement_rate only where engagement_posts is 3 or more). Filter by account_id. Join q_pg.douyin_creators on sec_uid = account_id.';

-- Per-account YouTube engagement, the TikTok view's twin over the YouTube snapshot tables, keyed by channel_id: the same
-- GROUP BYs on account_id, the first sort-key column, so filter by account_id. avg_plays is the average view count.
-- Join q_pg.youtube_creators on channel_id = account_id.
CREATE OR REPLACE VIEW q.youtube_engagement DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT c.account_id AS account_id, c.post_count AS post_count, c.avg_likes AS avg_likes,
    c.avg_comments AS avg_comments, c.avg_plays AS avg_plays, c.last_posted_at AS last_posted_at,
    toUInt64(ifNull(a.followers, 0)) AS followers,
    if(followers > 0, round((c.median_likes + 3 * ifNull(c.median_comments, 0)) / followers * 100, 3), NULL)
        AS engagement_rate,
    c.median_likes AS median_likes, c.median_comments AS median_comments, c.engagement_posts AS engagement_posts
FROM
(
    SELECT account_id, toUInt32(count()) AS post_count, avgOrNull(likes) AS avg_likes,
        avgOrNull(comments) AS avg_comments, avgOrNull(plays) AS avg_plays, max(posted_at) AS last_posted_at,
        groupArraySorted(240)((-toInt64(ifNull(posted_at, toDateTime(0, 'UTC'))), content_id, likes, comments))
            AS recent,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.3, recent)) AS median_likes,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.4, recent)) AS median_comments,
        toUInt32(arrayCount(p -> isNotNull(p.3), recent)) AS engagement_posts
    FROM
    (
        SELECT account_id, content_id, max(posted_at) AS posted_at, argMax(likes, observed_at) AS likes,
            argMax(comments, observed_at) AS comments, argMax(plays, observed_at) AS plays
        FROM crawler.youtube_content_snapshots
        GROUP BY account_id, content_id
    )
    GROUP BY account_id
) AS c
LEFT JOIN
(
    SELECT account_id, argMax(followers, observed_at) AS followers
    FROM crawler.youtube_account_snapshots
    GROUP BY account_id
) AS a ON c.account_id = a.account_id
COMMENT 'One row per YouTube account with posts, keyed by its channel_id: post count, average likes, comments and plays (a NULL counter skipped), last post time, followers, engagement_rate (median likes plus 3 times median comments of the newest 240 posts, over followers, in percent; NULL when no post in that window shows a like count or followers are unknown), median_likes, median_comments and engagement_posts (the posts in that window with a visible like count; rank by engagement_rate only where engagement_posts is 3 or more). Filter by account_id. Join q_pg.youtube_creators on channel_id = account_id.';

-- Per-account Facebook engagement, the TikTok view's twin over the Facebook snapshot tables, keyed by facebook_user_id: the same
-- GROUP BYs on account_id, the first sort-key column, so filter by account_id. avg_plays is the average video view count, NULL for an account with no video reads.
-- Join q_pg.facebook_creators on facebook_user_id = account_id.
CREATE OR REPLACE VIEW q.facebook_engagement DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT c.account_id AS account_id, c.post_count AS post_count, c.avg_likes AS avg_likes,
    c.avg_comments AS avg_comments, c.avg_plays AS avg_plays, c.last_posted_at AS last_posted_at,
    toUInt64(ifNull(a.followers, 0)) AS followers,
    if(followers > 0, round((c.median_likes + 3 * ifNull(c.median_comments, 0)) / followers * 100, 3), NULL)
        AS engagement_rate,
    c.median_likes AS median_likes, c.median_comments AS median_comments, c.engagement_posts AS engagement_posts
FROM
(
    SELECT account_id, toUInt32(count()) AS post_count, avgOrNull(likes) AS avg_likes,
        avgOrNull(comments) AS avg_comments, avgOrNull(plays) AS avg_plays, max(posted_at) AS last_posted_at,
        groupArraySorted(240)((-toInt64(ifNull(posted_at, toDateTime(0, 'UTC'))), content_id, likes, comments))
            AS recent,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.3, recent)) AS median_likes,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.4, recent)) AS median_comments,
        toUInt32(arrayCount(p -> isNotNull(p.3), recent)) AS engagement_posts
    FROM
    (
        SELECT account_id, content_id, max(posted_at) AS posted_at, argMax(likes, observed_at) AS likes,
            argMax(comments, observed_at) AS comments, argMax(plays, observed_at) AS plays
        FROM crawler.facebook_content_snapshots
        GROUP BY account_id, content_id
    )
    GROUP BY account_id
) AS c
LEFT JOIN
(
    SELECT account_id, argMax(followers, observed_at) AS followers
    FROM crawler.facebook_account_snapshots
    GROUP BY account_id
) AS a ON c.account_id = a.account_id
COMMENT 'One row per Facebook account with posts, keyed by its facebook_user_id: post count, average likes, comments and plays (a NULL counter skipped), last post time, followers, engagement_rate (median likes plus 3 times median comments of the newest 240 posts, over followers, in percent; NULL when no post in that window shows a like count or followers are unknown), median_likes, median_comments and engagement_posts (the posts in that window with a visible like count; rank by engagement_rate only where engagement_posts is 3 or more). Filter by account_id. Join q_pg.facebook_creators on facebook_user_id = account_id.';

-- Per-account LinkedIn engagement, the TikTok view's twin over the LinkedIn snapshot tables, keyed by canonical_urn: the same
-- GROUP BYs on account_id, the first sort-key column, so filter by account_id. LinkedIn shows no view counts, so avg_plays is NULL.
-- Join q_pg.linkedin_creators on canonical_urn = account_id.
CREATE OR REPLACE VIEW q.linkedin_engagement DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT c.account_id AS account_id, c.post_count AS post_count, c.avg_likes AS avg_likes,
    c.avg_comments AS avg_comments, c.avg_plays AS avg_plays, c.last_posted_at AS last_posted_at,
    toUInt64(ifNull(a.followers, 0)) AS followers,
    if(followers > 0, round((c.median_likes + 3 * ifNull(c.median_comments, 0)) / followers * 100, 3), NULL)
        AS engagement_rate,
    c.median_likes AS median_likes, c.median_comments AS median_comments, c.engagement_posts AS engagement_posts
FROM
(
    SELECT account_id, toUInt32(count()) AS post_count, avgOrNull(likes) AS avg_likes,
        avgOrNull(comments) AS avg_comments, avgOrNull(plays) AS avg_plays, max(posted_at) AS last_posted_at,
        groupArraySorted(240)((-toInt64(ifNull(posted_at, toDateTime(0, 'UTC'))), content_id, likes, comments))
            AS recent,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.3, recent)) AS median_likes,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.4, recent)) AS median_comments,
        toUInt32(arrayCount(p -> isNotNull(p.3), recent)) AS engagement_posts
    FROM
    (
        SELECT account_id, content_id, max(posted_at) AS posted_at, argMax(likes, observed_at) AS likes,
            argMax(comments, observed_at) AS comments, argMax(plays, observed_at) AS plays
        FROM crawler.linkedin_content_snapshots
        GROUP BY account_id, content_id
    )
    GROUP BY account_id
) AS c
LEFT JOIN
(
    SELECT account_id, argMax(followers, observed_at) AS followers
    FROM crawler.linkedin_account_snapshots
    GROUP BY account_id
) AS a ON c.account_id = a.account_id
COMMENT 'One row per LinkedIn account with posts, keyed by its canonical_urn: post count, average likes, comments and plays (a NULL counter skipped), last post time, followers, engagement_rate (median likes plus 3 times median comments of the newest 240 posts, over followers, in percent; NULL when no post in that window shows a like count or followers are unknown), median_likes, median_comments and engagement_posts (the posts in that window with a visible like count; rank by engagement_rate only where engagement_posts is 3 or more). Filter by account_id. Join q_pg.linkedin_creators on canonical_urn = account_id.';

-- Per-account Xiaohongshu engagement, the TikTok view's twin over the Xiaohongshu snapshot tables, keyed by user_id: the same
-- GROUP BYs on account_id, the first sort-key column, so filter by account_id. Xiaohongshu shows no view counts, so avg_plays is NULL.
-- Join q_pg.xiaohongshu_creators on user_id = account_id.
CREATE OR REPLACE VIEW q.xiaohongshu_engagement DEFINER = CURRENT_USER SQL SECURITY DEFINER AS
SELECT c.account_id AS account_id, c.post_count AS post_count, c.avg_likes AS avg_likes,
    c.avg_comments AS avg_comments, c.avg_plays AS avg_plays, c.last_posted_at AS last_posted_at,
    toUInt64(ifNull(a.followers, 0)) AS followers,
    if(followers > 0, round((c.median_likes + 3 * ifNull(c.median_comments, 0)) / followers * 100, 3), NULL)
        AS engagement_rate,
    c.median_likes AS median_likes, c.median_comments AS median_comments, c.engagement_posts AS engagement_posts
FROM
(
    SELECT account_id, toUInt32(count()) AS post_count, avgOrNull(likes) AS avg_likes,
        avgOrNull(comments) AS avg_comments, avgOrNull(plays) AS avg_plays, max(posted_at) AS last_posted_at,
        groupArraySorted(240)((-toInt64(ifNull(posted_at, toDateTime(0, 'UTC'))), content_id, likes, comments))
            AS recent,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.3, recent)) AS median_likes,
        arrayReduce('quantileExactInclusive(0.5)', arrayMap(p -> p.4, recent)) AS median_comments,
        toUInt32(arrayCount(p -> isNotNull(p.3), recent)) AS engagement_posts
    FROM
    (
        SELECT account_id, content_id, max(posted_at) AS posted_at, argMax(likes, observed_at) AS likes,
            argMax(comments, observed_at) AS comments, argMax(plays, observed_at) AS plays
        FROM crawler.xiaohongshu_content_snapshots
        GROUP BY account_id, content_id
    )
    GROUP BY account_id
) AS c
LEFT JOIN
(
    SELECT account_id, argMax(followers, observed_at) AS followers
    FROM crawler.xiaohongshu_account_snapshots
    GROUP BY account_id
) AS a ON c.account_id = a.account_id
COMMENT 'One row per Xiaohongshu account with posts, keyed by its user_id: post count, average likes, comments and plays (a NULL counter skipped), last post time, followers, engagement_rate (median likes plus 3 times median comments of the newest 240 posts, over followers, in percent; NULL when no post in that window shows a like count or followers are unknown), median_likes, median_comments and engagement_posts (the posts in that window with a visible like count; rank by engagement_rate only where engagement_posts is 3 or more). Filter by account_id. Join q_pg.xiaohongshu_creators on user_id = account_id.';

REVOKE ALL ON *.* FROM query_standard;
REVOKE ALL ON *.* FROM query_full;
GRANT SELECT ON q.* TO query_standard;
GRANT SELECT ON q.* TO query_full;
REVOKE SELECT ON q.instagram_posts FROM query_standard;
REVOKE SELECT ON q.instagram_posts FROM query_full;

SHOW GRANTS FOR query_standard;
SHOW GRANTS FOR query_full;
