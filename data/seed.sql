BEGIN;
CREATE TABLE daily_metrics (
  date TEXT NOT NULL,
  region TEXT NOT NULL,
  channel TEXT NOT NULL,
  revenue REAL NOT NULL CHECK (revenue >= 0),
  orders INTEGER NOT NULL CHECK (orders >= 0),
  visitors INTEGER NOT NULL CHECK (visitors >= 0),
  PRIMARY KEY (date, region, channel)
);

WITH RECURSIVE
  days(n, date) AS (
    VALUES(0, date('2026-08-26', '-89 days'))
    UNION ALL SELECT n + 1, date(date, '+1 day') FROM days WHERE n < 89
  ),
  regions(region, r) AS (VALUES('华东', 1.20), ('华北', 1.00), ('华南', 1.10), ('西部', 0.75)),
  channels(channel, c) AS (VALUES('自然流量', 1.00), ('广告', 1.30), ('会员', 0.85))
INSERT INTO daily_metrics(date, region, channel, revenue, orders, visitors)
SELECT
  date,
  region,
  channel,
  round((7200 + n * 28 + (n % 7) * 310) * r * c, 2),
  cast((95 + n % 13 + (n % 7) * 3) * r * c AS integer),
  cast((1680 + (n % 11) * 41 + (n % 7) * 53) * r * c AS integer)
FROM days CROSS JOIN regions CROSS JOIN channels;

CREATE INDEX idx_daily_metrics_date ON daily_metrics(date);
CREATE INDEX idx_daily_metrics_region ON daily_metrics(region);
CREATE INDEX idx_daily_metrics_channel ON daily_metrics(channel);
COMMIT;
