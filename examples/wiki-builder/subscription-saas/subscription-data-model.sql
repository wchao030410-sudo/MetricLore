CREATE TABLE subscription_daily (
  snapshot_date DATE NOT NULL,
  account_id TEXT NOT NULL,
  plan_id TEXT NOT NULL,
  subscription_status TEXT NOT NULL,
  monthly_recurring_revenue NUMERIC NOT NULL,
  PRIMARY KEY (snapshot_date, account_id, plan_id)
);

