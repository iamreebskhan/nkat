output "vpc_id" {
  value = aws_vpc.this.id
}

output "rds_endpoint" {
  value     = aws_db_instance.this.endpoint
  sensitive = true
}

output "alb_dns_name" {
  value = aws_lb.this.dns_name
}

output "ecs_cluster_name" {
  value = aws_ecs_cluster.this.name
}

output "ecs_service_name" {
  value = aws_ecs_service.api.name
}

output "alarms_topic_arn" {
  value = aws_sns_topic.alarms.arn
}
