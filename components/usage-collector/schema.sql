-- usage.model_calls holds one row per model call from every host and chat client, for the Usage pages of the Prime
-- chat and sw factory. sieun-pi's components/usage-collector runs on each box, reads each client's own usage records
-- and posts rows to devbox-push.virev.ai/usage/model_calls (config/caddy/obs.Caddyfile), which inserts them as
-- usage_writer (config/clickhouse/obs-users.sql). Grafana reads them as grafana_ro (grafana-ro-prod.sql).
-- host, client and session name where each call ran, so a page can split by them. source_key is
-- '<client>:<host>:<source id>', the same string on every rerun of the collector, and ReplacingMergeTree keeps one row
-- per (host, client, row_id) with the newest collected_at, so readers use FINAL. call_at stays out of ORDER BY, so a
-- key resent with another call_at still folds into one row; the minmax index on call_at lets a time range skip
-- granules. ReplacingMergeTree folds rows only within one partition, so call_at must not change for a key across a
-- month edge: the collectors take it from the source record, never from the collection time. A resent identical
-- block is dropped at insert time by non_replicated_deduplication_window and the collector's insert_deduplication_token.
-- The TTL keeps 5 years from the call's day, because the Usage pages show history the owner reads and the table grows
-- by about 1 GB a year (the store plan's estimate), so a short TTL would cut numbers he sees.
-- sieun-pi components/usage-collector/schema.sql is the same table for the collector's test rig; change both together.
-- No deploy applies this file, because its CREATE DATABASE needs the container admin (ops/bin/schema-drift.mjs
-- HAND_FILES). apply_obs_users.py prod sends it before obs-users.sql, as the admin, and it is idempotent.

CREATE DATABASE IF NOT EXISTS usage;

CREATE TABLE IF NOT EXISTS usage.model_calls
(
    -- '<client>:<host>:<source id>', the same string on every rerun of the collector
    source_key            String CODEC(ZSTD(1)),
    row_id                UInt64 MATERIALIZED cityHash64(source_key),
    call_at               DateTime64(3, 'UTC') CODEC(Delta(8), ZSTD(1)),
    host                  LowCardinality(String),
    client                LowCardinality(String),
    agent                 LowCardinality(String) DEFAULT '',
    thread                String DEFAULT '' CODEC(ZSTD(1)),
    -- the thread's name when the call was collected, so a Usage page can name a thread without asking the client
    thread_name           String DEFAULT '' CODEC(ZSTD(1)),
    session               String DEFAULT '' CODEC(ZSTD(1)),
    provider              LowCardinality(String),
    model                 LowCardinality(String),
    account               LowCardinality(String) DEFAULT '',
    input_tokens          UInt32,
    output_tokens         UInt32,
    reasoning_tokens      UInt32 DEFAULT 0,
    cache_read_tokens     UInt32,
    cache_write_tokens    UInt32,
    cache_write_1h_tokens UInt32 DEFAULT 0,
    cost_input_usd        Decimal(18, 9),
    cost_output_usd       Decimal(18, 9),
    cost_cache_read_usd   Decimal(18, 9),
    cost_cache_write_usd  Decimal(18, 9),
    cost_usd              Decimal(18, 9) MATERIALIZED cost_input_usd + cost_output_usd + cost_cache_read_usd + cost_cache_write_usd,
    cost_source           LowCardinality(String),
    duration_ms           UInt32 DEFAULT 0,
    collected_at          DateTime64(3, 'UTC') DEFAULT now64(3),
    INDEX thread_bf thread TYPE bloom_filter(0.01) GRANULARITY 4,
    INDEX call_at_minmax call_at TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree(collected_at)
PARTITION BY toYYYYMM(call_at)
ORDER BY (host, client, row_id)
TTL toDate(call_at) + INTERVAL 5 YEAR
SETTINGS non_replicated_deduplication_window = 1000;
