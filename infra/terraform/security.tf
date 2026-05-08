/**
 * KMS keys + IAM + security groups.
 *
 * Three keys: one for RDS, one for logs, one for Secrets Manager. Separate
 * keys mean a key compromise is scoped, and per-key access policies are
 * easier to audit than one umbrella key.
 */

# --- KMS keys ---

resource "aws_kms_key" "rds" {
  description             = "br-${var.env} RDS encryption"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_key" "logs" {
  description             = "br-${var.env} CloudWatch + Datadog forwarder logs"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_kms_key" "secrets" {
  description             = "br-${var.env} Secrets Manager"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

# --- ECS task role (the in-task identity) ---

data "aws_iam_policy_document" "task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "ecs_task" {
  name               = "br-${var.env}-ecs-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

# Bedrock invoke (only the listed model IDs)
data "aws_iam_policy_document" "bedrock" {
  statement {
    actions   = ["bedrock:InvokeModel"]
    resources = [
      for m in var.bedrock_model_ids :
      "arn:aws:bedrock:${var.region}::foundation-model/${m}"
    ]
  }
}

resource "aws_iam_role_policy" "bedrock" {
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.bedrock.json
}

# Secrets Manager — the task can only read the secrets it needs.
data "aws_iam_policy_document" "secrets_read" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [
      aws_secretsmanager_secret.db_app_password.arn,
      aws_secretsmanager_secret.db_breakglass_url.arn,
      aws_secretsmanager_secret.ama_license.arn,
      aws_secretsmanager_secret.cms_coverage.arn,
      var.datadog_api_key_secret_arn,
    ]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn]
  }
}

resource "aws_iam_role_policy" "secrets_read" {
  role   = aws_iam_role.ecs_task.id
  policy = data.aws_iam_policy_document.secrets_read.json
}

# --- ECS task execution role (used by Fargate to pull image + push logs) ---

resource "aws_iam_role" "ecs_exec" {
  name               = "br-${var.env}-ecs-exec"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy_attachment" "ecs_exec_managed" {
  role       = aws_iam_role.ecs_exec.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# --- Security groups ---

resource "aws_security_group" "alb" {
  name   = "br-${var.env}-alb"
  vpc_id = aws_vpc.this.id

  ingress {
    description = "HTTPS from internet"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "ecs" {
  name   = "br-${var.env}-ecs"
  vpc_id = aws_vpc.this.id

  ingress {
    description     = "ALB → API"
    from_port       = 3000
    to_port         = 3000
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "rds" {
  name   = "br-${var.env}-rds"
  vpc_id = aws_vpc.this.id

  ingress {
    description     = "ECS task → Postgres"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ecs.id]
  }
}
