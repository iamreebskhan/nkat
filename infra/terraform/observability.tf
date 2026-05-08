/**
 * CloudWatch alarms wired to an SNS topic. PagerDuty integrates by
 * subscribing the topic's HTTPS endpoint; humans subscribe email/SMS
 * for redundancy.
 */
resource "aws_sns_topic" "alarms" {
  name              = "br-${var.env}-alarms"
  kms_master_key_id = aws_kms_key.logs.arn
}

resource "aws_sns_topic_subscription" "email" {
  topic_arn = aws_sns_topic.alarms.arn
  protocol  = "email"
  endpoint  = var.alert_email
}

resource "aws_cloudwatch_metric_alarm" "api_5xx" {
  alarm_name          = "br-${var.env}-api-5xx"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "HTTPCode_Target_5XX_Count"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  statistic           = "Sum"
  threshold           = 10
  alarm_description   = "API 5xx > 10/min over 5 min — page on-call."
  alarm_actions       = [aws_sns_topic.alarms.arn]
  ok_actions          = [aws_sns_topic.alarms.arn]
  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "api_p95_latency" {
  alarm_name          = "br-${var.env}-api-p95-latency"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "TargetResponseTime"
  namespace           = "AWS/ApplicationELB"
  period              = 60
  extended_statistic  = "p95"
  threshold           = 3.0
  alarm_description   = "API p95 latency > 3s over 5 min — investigate."
  alarm_actions       = [aws_sns_topic.alarms.arn]
  dimensions = {
    LoadBalancer = aws_lb.this.arn_suffix
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_cpu" {
  alarm_name          = "br-${var.env}-rds-cpu"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 5
  metric_name         = "CPUUtilization"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 90
  alarm_description   = "RDS CPU > 90% sustained — investigate."
  alarm_actions       = [aws_sns_topic.alarms.arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.id
  }
}

resource "aws_cloudwatch_metric_alarm" "rds_connections" {
  alarm_name          = "br-${var.env}-rds-connections"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DatabaseConnections"
  namespace           = "AWS/RDS"
  period              = 60
  statistic           = "Average"
  threshold           = 200
  alarm_description   = "RDS connection count high — PgBouncer pool sizing or run-away ECS task."
  alarm_actions       = [aws_sns_topic.alarms.arn]
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.this.id
  }
}
