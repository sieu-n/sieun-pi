-- usage.model_calls: one row per model call from every host and client (store.md section 5 in ~/work/usage-one-source).
-- Users and grants are not here: the box owner makes usage_writer and grants grafana_ro on prod-clickhouse (c146).

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
    INDEX thread_bf thread TYPE bloom_filter(0.01) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(collected_at)
PARTITION BY toYYYYMM(call_at)
ORDER BY (host, client, call_at, row_id)
TTL toDate(call_at) + INTERVAL 5 YEAR
SETTINGS non_replicated_deduplication_window = 1000;
