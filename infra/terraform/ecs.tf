/**
 * ECS Fargate cluster + ALB + service for the API. Image tag is supplied
 * via -var=image_tag at apply time; CI publishes images to ECR but does
 * NOT auto-trigger this apply.
 */

variable "image_uri" {
  description = "Full ECR URI + tag of the API image, e.g. 123.dkr.ecr.us-east-1.amazonaws.com/billing-rules-api:abc123."
  type        = string
}

resource "aws_ecs_cluster" "this" {
  name = "br-${var.env}"
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_cloudwatch_log_group" "api" {
  name              = "/br/${var.env}/api"
  retention_in_days = var.env == "prod" ? 30 : 7
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_ecs_task_definition" "api" {
  family                   = "br-${var.env}-api"
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  cpu                      = var.ecs_task_cpu
  memory                   = var.ecs_task_memory
  execution_role_arn       = aws_iam_role.ecs_exec.arn
  task_role_arn            = aws_iam_role.ecs_task.arn

  container_definitions = jsonencode([
    {
      name      = "api"
      image     = var.image_uri
      essential = true
      portMappings = [{ containerPort = 3000, hostPort = 3000, protocol = "tcp" }]
      environment = [
        { name = "NODE_ENV",     value = var.env },
        { name = "AWS_REGION",   value = var.region },
        { name = "PORT",         value = "3000" },
        # OIDC SSO (optional). Set both URL + client id to enable.
        # Leaving these unset makes /v1/auth/sso/start return 503 and
        # the frontend's LoginPage hides the SSO button via /v1/auth/mode.
        { name = "OIDC_AUTHORIZATION_URL", value = var.oidc_authorization_url },
        { name = "OIDC_CLIENT_ID",         value = var.oidc_client_id },
        { name = "OIDC_REDIRECT_URI",      value = var.oidc_redirect_uri },
        { name = "OIDC_SCOPE",             value = var.oidc_scope },
      ]
      secrets = [
        { name = "DB_APP_PASSWORD",        valueFrom = aws_secretsmanager_secret.db_app_password.arn },
        # The deletion executor reuses this api task definition + reads
        # this URL only when invoked via scripts/execute-tenant-deletions.ts.
        # Regular API request handlers ignore it (they use DB_APP_PASSWORD).
        { name = "BREAKGLASS_DATABASE_URL", valueFrom = aws_secretsmanager_secret.db_breakglass_url.arn },
        { name = "AMA_LICENSE_TOKEN",      valueFrom = aws_secretsmanager_secret.ama_license.arn },
        { name = "CMS_COVERAGE_TOKEN",     valueFrom = aws_secretsmanager_secret.cms_coverage.arn },
        { name = "DD_API_KEY",             valueFrom = var.datadog_api_key_secret_arn },
      ]
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.api.name
          awslogs-region        = var.region
          awslogs-stream-prefix = "api"
        }
      }
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"require('http').get('http://localhost:3000/health',(r)=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 30
      }
    },
  ])
}

resource "aws_lb" "this" {
  name               = "br-${var.env}-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = aws_subnet.public[*].id
  drop_invalid_header_fields = true
}

resource "aws_lb_target_group" "api" {
  name        = "br-${var.env}-api-tg"
  port        = 3000
  protocol    = "HTTP"
  vpc_id      = aws_vpc.this.id
  target_type = "ip"

  health_check {
    path                = "/health"
    matcher             = "200"
    interval            = 30
    timeout             = 5
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.this.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"
  certificate_arn   = var.acm_cert_arn

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.api.arn
  }
}

resource "aws_ecs_service" "api" {
  name            = "br-${var.env}-api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.ecs_service_min_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = aws_subnet.private[*].id
    security_groups = [aws_security_group.ecs.id]
    assign_public_ip = false
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3000
  }

  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200

  lifecycle {
    ignore_changes = [task_definition] # CI/CD updates this; TF skeleton sets only the initial value
  }

  depends_on = [aws_lb_listener.https]
}

resource "aws_appautoscaling_target" "api" {
  max_capacity       = var.ecs_service_max_count
  min_capacity       = var.ecs_service_min_count
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "br-${var.env}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60.0
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
