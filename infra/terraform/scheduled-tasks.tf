/**
 * Scheduled tasks. Each is an ECS-RunTask invocation triggered by an
 * EventBridge schedule. The task uses the same image as the API service
 * but with a different command (the script entrypoint).
 *
 * We use ECS-RunTask (not Lambda) so the scripts share the API's runtime
 * config (Secrets Manager bindings, VPC, RDS access) without a separate
 * deploy artifact. Cost: ~$0.005 per minute of run-time per task; the
 * reconciler runs ~30s daily.
 */

# IAM role EventBridge assumes when invoking RunTask.
data "aws_iam_policy_document" "events_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["events.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "events_runtask" {
  name               = "br-${var.env}-events-runtask"
  assume_role_policy = data.aws_iam_policy_document.events_assume.json
}

data "aws_iam_policy_document" "events_runtask" {
  statement {
    actions   = ["ecs:RunTask"]
    resources = ["${aws_ecs_task_definition.api.arn_without_revision}:*"]
    condition {
      test     = "ArnLike"
      variable = "ecs:cluster"
      values   = [aws_ecs_cluster.this.arn]
    }
  }
  statement {
    actions   = ["iam:PassRole"]
    resources = [aws_iam_role.ecs_task.arn, aws_iam_role.ecs_exec.arn]
  }
}

resource "aws_iam_role_policy" "events_runtask" {
  role   = aws_iam_role.events_runtask.id
  policy = data.aws_iam_policy_document.events_runtask.json
}

# Reconciler — every 10 minutes.
resource "aws_cloudwatch_event_rule" "billing_reconcile" {
  name                = "br-${var.env}-billing-reconcile"
  description         = "Billing reconciler — refetch subscriptions whose invoice events lack a follow-up subscription event."
  schedule_expression = "rate(10 minutes)"
  state               = var.env == "prod" ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "billing_reconcile" {
  rule      = aws_cloudwatch_event_rule.billing_reconcile.name
  target_id = "ecs-reconcile-billing"
  arn       = aws_ecs_cluster.this.arn
  role_arn  = aws_iam_role.events_runtask.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.api.arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"
    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.ecs.id]
      assign_public_ip = false
    }
  }

  input = jsonencode({
    containerOverrides = [{
      name    = "api"
      command = ["node", "-e", "require('ts-node/register'); require('./scripts/reconcile-billing.ts');"]
    }]
  })
}

# Signup-attempt cleanup — once daily at 13:00 UTC.
resource "aws_cloudwatch_event_rule" "signup_expire" {
  name                = "br-${var.env}-signup-expire"
  description         = "Expire pending signup_attempt rows past 24h and reclaim orphaned orgs."
  schedule_expression = "cron(0 13 * * ? *)"
  state               = var.env == "prod" ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "signup_expire" {
  rule      = aws_cloudwatch_event_rule.signup_expire.name
  target_id = "ecs-signup-expire"
  arn       = aws_ecs_cluster.this.arn
  role_arn  = aws_iam_role.events_runtask.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.api.arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"
    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.ecs.id]
      assign_public_ip = false
    }
  }

  input = jsonencode({
    containerOverrides = [{
      name    = "api"
      command = ["node", "-e", "require('ts-node/register'); require('./scripts/expire-signup-attempts.ts');"]
    }]
  })
}

# Billing emails — once daily at 12:30 UTC (08:30 ET, before most billing
# admins start their day). Sends trial-ending + dunning notifications.
resource "aws_cloudwatch_event_rule" "billing_emails" {
  name                = "br-${var.env}-billing-emails"
  description         = "Daily trial-ending + dunning email orchestrator."
  schedule_expression = "cron(30 12 * * ? *)"
  state               = var.env == "prod" ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "billing_emails" {
  rule      = aws_cloudwatch_event_rule.billing_emails.name
  target_id = "ecs-billing-emails"
  arn       = aws_ecs_cluster.this.arn
  role_arn  = aws_iam_role.events_runtask.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.api.arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"
    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.ecs.id]
      assign_public_ip = false
    }
  }

  input = jsonencode({
    containerOverrides = [{
      name    = "api"
      command = ["node", "-e", "require('ts-node/register'); require('./scripts/send-billing-emails.ts');"]
    }]
  })
}

# Email retry — every 15 minutes, picks up `email_send` rows in `failed`
# whose `next_retry_at <= now()`. Bounded to 100 rows/run.
resource "aws_cloudwatch_event_rule" "email_retry" {
  name                = "br-${var.env}-email-retry"
  description         = "Retry failed email_send rows with exponential backoff."
  schedule_expression = "rate(15 minutes)"
  state               = var.env == "prod" ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "email_retry" {
  rule      = aws_cloudwatch_event_rule.email_retry.name
  target_id = "ecs-email-retry"
  arn       = aws_ecs_cluster.this.arn
  role_arn  = aws_iam_role.events_runtask.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.api.arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"
    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.ecs.id]
      assign_public_ip = false
    }
  }

  input = jsonencode({
    containerOverrides = [{
      name    = "api"
      command = ["node", "-e", "require('ts-node/register'); require('./scripts/retry-failed-emails.ts');"]
    }]
  })
}

# Cleanup — daily at 11:00 UTC. Reclaims expired idempotency_record rows
# and email_send rows older than 90d (excluding `failed` rows which the
# retry surface owns).
resource "aws_cloudwatch_event_rule" "cleanup_expired" {
  name                = "br-${var.env}-cleanup-expired"
  description         = "Daily cleanup of expired idempotency + old email_send rows."
  schedule_expression = "cron(0 11 * * ? *)"
  state               = var.env == "prod" ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "cleanup_expired" {
  rule      = aws_cloudwatch_event_rule.cleanup_expired.name
  target_id = "ecs-cleanup-expired"
  arn       = aws_ecs_cluster.this.arn
  role_arn  = aws_iam_role.events_runtask.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.api.arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"
    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.ecs.id]
      assign_public_ip = false
    }
  }

  input = jsonencode({
    containerOverrides = [{
      name    = "api"
      command = ["node", "-e", "require('ts-node/register'); require('./scripts/cleanup-expired-records.ts');"]
    }]
  })
}

# Webhook delivery worker — every 2 minutes. Scans `webhook_delivery`
# rows ready for dispatch + drains them through WebhookService. Two
# concurrent workers are safe (SELECT FOR UPDATE SKIP LOCKED).
resource "aws_cloudwatch_event_rule" "webhooks_deliver" {
  name                = "br-${var.env}-webhooks-deliver"
  description         = "Drain webhook_delivery rows whose ready_at has elapsed."
  schedule_expression = "rate(2 minutes)"
  state               = var.env == "prod" ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "webhooks_deliver" {
  rule      = aws_cloudwatch_event_rule.webhooks_deliver.name
  target_id = "ecs-webhooks-deliver"
  arn       = aws_ecs_cluster.this.arn
  role_arn  = aws_iam_role.events_runtask.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.api.arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"
    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.ecs.id]
      assign_public_ip = false
    }
  }

  input = jsonencode({
    containerOverrides = [{
      name    = "api"
      command = ["node", "-e", "require('ts-node/register'); require('./scripts/deliver-webhooks.ts');"]
    }]
  })
}

# Renewal-motion — once daily at 14:00 UTC (08:00 CT, before the workday).
resource "aws_cloudwatch_event_rule" "renewal_motion" {
  name                = "br-${var.env}-renewal-motion"
  description         = "Daily CSM renewal-motion: post Slack alerts for subscriptions in the 60-day notice window."
  schedule_expression = "cron(0 14 * * ? *)"
  state               = var.env == "prod" ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "renewal_motion" {
  rule      = aws_cloudwatch_event_rule.renewal_motion.name
  target_id = "ecs-renewal-motion"
  arn       = aws_ecs_cluster.this.arn
  role_arn  = aws_iam_role.events_runtask.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.api.arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"
    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.ecs.id]
      assign_public_ip = false
    }
  }

  input = jsonencode({
    containerOverrides = [{
      name    = "api"
      command = ["node", "-e", "require('ts-node/register'); require('./scripts/renewal-motion.ts');"]
    }]
  })
}

# Tenant data deletion executor — once per day. Reads
# `tenant_deletion_request` rows whose 30-day grace has passed and
# wipes that tenant's data. Runs as the BREAKGLASS Postgres role
# (separate task definition with the breakglass DATABASE_URL injected
# via Secrets Manager). MSA § 7 deletion-within-30-days commitment.
resource "aws_cloudwatch_event_rule" "tenant_deletion_executor" {
  name                = "br-${var.env}-tenant-deletion-executor"
  description         = "Process tenant_deletion_request rows whose grace window has passed (MSA § 7)."
  schedule_expression = "cron(0 13 * * ? *)" # 13:00 UTC daily — well after cleanup_expired @ 11:00
  state               = var.env == "prod" ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "tenant_deletion_executor" {
  rule      = aws_cloudwatch_event_rule.tenant_deletion_executor.name
  target_id = "ecs-tenant-deletion-executor"
  arn       = aws_ecs_cluster.this.arn
  role_arn  = aws_iam_role.events_runtask.arn

  ecs_target {
    # Reuses the api task definition. The deletion script reads
    # BREAKGLASS_DATABASE_URL plumbed in via ecs.tf secrets list +
    # rds.tf db_breakglass_url secret. The script refuses to start
    # unless the connected role's pg_roles.rolbypassrls = true.
    task_definition_arn = aws_ecs_task_definition.api.arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"
    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.ecs.id]
      assign_public_ip = false
    }
  }

  input = jsonencode({
    containerOverrides = [{
      name    = "api"
      command = ["node", "-e", "require('ts-node/register'); require('./scripts/execute-tenant-deletions.ts');"]
    }]
  })
}

# DSAR auto-expiry — once daily. Flips overdue DSAR rows to
# `expired` and inserts a `privacy.dsar_auto_expired` audit row,
# our SOC 2 evidence that we tracked the 45-day SLA.
resource "aws_cloudwatch_event_rule" "dsar_expire" {
  name                = "br-${var.env}-dsar-expire"
  description         = "Auto-expire DSAR rows past their 45-day + 7-day grace SLA."
  schedule_expression = "cron(0 14 * * ? *)" # 14:00 UTC
  state               = var.env == "prod" ? "ENABLED" : "DISABLED"
}

resource "aws_cloudwatch_event_target" "dsar_expire" {
  rule      = aws_cloudwatch_event_rule.dsar_expire.name
  target_id = "ecs-dsar-expire"
  arn       = aws_ecs_cluster.this.arn
  role_arn  = aws_iam_role.events_runtask.arn

  ecs_target {
    task_definition_arn = aws_ecs_task_definition.api.arn
    launch_type         = "FARGATE"
    platform_version    = "LATEST"
    network_configuration {
      subnets          = aws_subnet.private[*].id
      security_groups  = [aws_security_group.ecs.id]
      assign_public_ip = false
    }
  }

  input = jsonencode({
    containerOverrides = [{
      name    = "api"
      command = ["node", "-e", "require('ts-node/register'); require('./scripts/expire-dsar.ts');"]
    }]
  })
}
