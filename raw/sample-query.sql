SELECT
  date,
  region,
  SUM(revenue) AS revenue
FROM daily_metrics
WHERE date >= '2026-08-01'
GROUP BY date, region;
