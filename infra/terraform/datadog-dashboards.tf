/*
 * Datadog dashboards declared as Terraform — one source of truth, no
 * point-and-click drift, free PR review for monitoring changes.
 *
 * Two dashboards in this file:
 *
 *   1. "Billing Rules — API Health" — request rate, latency p50/p95/p99,
 *      error rate, rate-limit rejection rate, queue depth, DB pool
 *      utilization.
 *
 *   2. "Billing Rules — Domain Signals" — synthesis cache hit rate,
 *      hallucination eval pass rate, denial-event ingestion lag,
 *      Stripe rotation-secret hits, JWKS fetch latency.
 *
 * Tagged `service:billing-rules-api`. Filter widgets by env via the
 * dashboard-level template variable `$env`.
 */

resource "datadog_dashboard" "api_health" {
  title         = "Billing Rules — API Health (${var.env})"
  description   = "Request rate, latency, errors, rate-limit, DB. Managed by Terraform."
  layout_type   = "ordered"
  reflow_type   = "auto"
  is_read_only  = false
  notify_list   = []

  template_variable {
    name    = "env"
    default = var.env
    prefix  = "env"
  }

  # ---- Top row: golden signals ----
  widget {
    timeseries_definition {
      title       = "Requests / sec by endpoint (top 10)"
      show_legend = true
      legend_size = "auto"

      request {
        q            = "top(sum:trace.express.request.hits{service:billing-rules-api,$env} by {resource_name}.as_rate(), 10, 'mean', 'desc')"
        display_type = "line"
      }
    }
  }

  widget {
    timeseries_definition {
      title = "Latency p50 / p95 / p99 (overall)"
      request {
        q            = "p50:trace.express.request{service:billing-rules-api,$env}"
        display_type = "line"
        style { palette = "cool" }
      }
      request {
        q            = "p95:trace.express.request{service:billing-rules-api,$env}"
        display_type = "line"
      }
      request {
        q            = "p99:trace.express.request{service:billing-rules-api,$env}"
        display_type = "line"
        style { palette = "warm" }
      }
    }
  }

  widget {
    query_value_definition {
      title      = "5xx rate (last 5m)"
      precision  = 2
      autoscale  = true

      request {
        q          = "sum:trace.express.request.errors{service:billing-rules-api,$env}.as_count() / sum:trace.express.request.hits{service:billing-rules-api,$env}.as_count()"
        aggregator = "avg"

        conditional_formats {
          comparator = ">"
          value      = 0.01
          palette    = "white_on_red"
        }
        conditional_formats {
          comparator = ">"
          value      = 0.001
          palette    = "white_on_yellow"
        }
        conditional_formats {
          comparator = "<="
          value      = 0.001
          palette    = "white_on_green"
        }
      }
    }
  }

  # ---- Rate limit + auth ----
  widget {
    timeseries_definition {
      title = "Rate-limit 429s by scope"
      request {
        q            = "sum:billing_rules.rate_limit.rejected{$env} by {scope}.as_rate()"
        display_type = "bars"
      }
    }
  }

  widget {
    timeseries_definition {
      title = "JWKS fetch latency (p95)"
      request {
        q            = "p95:billing_rules.auth.jwks_fetch_ms{$env}"
        display_type = "line"
      }
    }
  }

  # ---- DB ----
  widget {
    timeseries_definition {
      title = "Postgres connection pool — in use vs idle"
      request {
        q            = "avg:postgres.connections.active{service:billing-rules-api,$env}"
        display_type = "line"
      }
      request {
        q            = "avg:postgres.connections.idle{service:billing-rules-api,$env}"
        display_type = "line"
      }
    }
  }

  widget {
    timeseries_definition {
      title = "Slowest queries (p95)"
      request {
        q            = "top(p95:postgres.queries.duration{service:billing-rules-api,$env} by {query_signature}, 10, 'mean', 'desc')"
        display_type = "line"
      }
    }
  }
}

resource "datadog_dashboard" "domain_signals" {
  title        = "Billing Rules — Domain Signals (${var.env})"
  description  = "Synthesis cache, hallucination eval, denial ingestion, Stripe rotation."
  layout_type  = "ordered"
  reflow_type  = "auto"
  is_read_only = false

  template_variable {
    name    = "env"
    default = var.env
    prefix  = "env"
  }

  widget {
    timeseries_definition {
      title = "Synthesis cache hit rate"
      request {
        q            = "sum:billing_rules.synthesis.cache_hit{$env}.as_count() / (sum:billing_rules.synthesis.cache_hit{$env}.as_count() + sum:billing_rules.synthesis.cache_miss{$env}.as_count())"
        display_type = "line"
      }
    }
  }

  widget {
    timeseries_definition {
      title = "Synthesis cost ($) per hour"
      request {
        q            = "sum:billing_rules.synthesis.cost_usd{$env}.as_count()"
        display_type = "bars"
      }
    }
  }

  widget {
    query_value_definition {
      title     = "Hallucination eval pass rate (last 24h)"
      precision = 4

      request {
        q          = "sum:billing_rules.eval.pass{$env}.as_count() / sum:billing_rules.eval.run{$env}.as_count()"
        aggregator = "avg"

        conditional_formats {
          comparator = "<"
          value      = 0.95
          palette    = "white_on_red"
        }
        conditional_formats {
          comparator = ">="
          value      = 0.95
          palette    = "white_on_green"
        }
      }
    }
  }

  widget {
    timeseries_definition {
      title = "835 ERA ingestion lag (seconds)"
      request {
        q            = "max:billing_rules.era835.ingest_lag_sec{$env}"
        display_type = "area"
      }
    }
  }

  widget {
    timeseries_definition {
      title = "Stripe webhook — rotation-secret hits"
      request {
        q            = "sum:billing_rules.stripe.webhook_secret_index{$env} by {secret_index}.as_rate()"
        display_type = "bars"
      }
    }
  }

  widget {
    toplist_definition {
      title = "Top denial classes (CARC) last 24h by $ impact"
      request {
        q = "top(sum:billing_rules.denial.dollar_impact{$env} by {carc}, 10, 'sum', 'desc')"
      }
    }
  }
}

# ---- Monitors (alerts) ----

resource "datadog_monitor" "api_5xx_high" {
  name    = "Billing Rules — 5xx rate > 1% [${var.env}]"
  type    = "metric alert"
  message = <<-EOT
    5xx rate has exceeded 1% over a 5-minute window in ${var.env}.

    Runbook: https://internal.billing-rules.example/runbook/api-5xx
    @hipchat-billing-oncall
  EOT

  query = "avg(last_5m):sum:trace.express.request.errors{service:billing-rules-api,env:${var.env}}.as_count() / sum:trace.express.request.hits{service:billing-rules-api,env:${var.env}}.as_count() > 0.01"

  monitor_thresholds {
    warning  = 0.005
    critical = 0.01
  }

  notify_no_data    = false
  evaluation_delay  = 60
  require_full_window = false

  tags = ["service:billing-rules-api", "env:${var.env}", "team:platform"]
}

resource "datadog_monitor" "api_p95_latency" {
  name = "Billing Rules — p95 latency > 2s [${var.env}]"
  type = "metric alert"

  message = <<-EOT
    p95 latency has exceeded 2 seconds over a 10-minute window in ${var.env}.
    SLO budget: 2s.
  EOT

  query = "avg(last_10m):p95:trace.express.request{service:billing-rules-api,env:${var.env}} > 2000"

  monitor_thresholds {
    warning  = 1500
    critical = 2000
  }

  notify_no_data = false
  tags           = ["service:billing-rules-api", "env:${var.env}", "team:platform"]
}

resource "datadog_monitor" "hallucination_pass_rate_low" {
  name = "Billing Rules — hallucination eval pass rate < 95% [${var.env}]"
  type = "metric alert"

  message = <<-EOT
    Pass rate dropped below 95% over the last 24h. Auto-rollback may
    not have engaged if a flag flip happened off-deploy.
    @sre-billing
  EOT

  query = "avg(last_1d):sum:billing_rules.eval.pass{env:${var.env}}.as_count() / sum:billing_rules.eval.run{env:${var.env}}.as_count() < 0.95"

  monitor_thresholds {
    warning  = 0.97
    critical = 0.95
  }

  notify_no_data = false
  tags           = ["service:billing-rules-api", "env:${var.env}", "team:ai-safety"]
}

resource "datadog_monitor" "stripe_rotation_overrun" {
  name = "Billing Rules — Stripe rotation secret still in use [${var.env}]"
  type = "metric alert"

  message = <<-EOT
    The previous Stripe webhook signing secret is still authenticating
    requests > 24h after deploy. Either retire the rotation OR confirm
    the dashboard rotation hasn't completed.
  EOT

  query = "sum(last_1d):sum:billing_rules.stripe.webhook_secret_index{secret_index:1,env:${var.env}}.as_count() > 0"

  monitor_thresholds {
    critical = 0
  }

  notify_no_data = false
  tags           = ["service:billing-rules-api", "env:${var.env}", "team:platform"]
}
