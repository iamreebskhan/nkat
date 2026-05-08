/**
 * Postgres 16 Multi-AZ + parameter group + 35-day automated backups.
 * pgvector is supplied by RDS as of pg16.x; the migration enables it.
 *
 * Master credentials are auto-generated and stored in Secrets Manager;
 * the app role gets its own password via a per-role secret rotated by the
 * existing routine in `RUNBOOKS/break-glass.md`.
 */

resource "aws_db_subnet_group" "this" {
  name       = "br-${var.env}-rds"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_db_parameter_group" "this" {
  name   = "br-${var.env}-pg16"
  family = "postgres16"

  parameter {
    name  = "log_statement"
    value = "ddl"
  }
  parameter {
    name  = "log_min_duration_statement"
    value = "2000"  # log queries slower than 2s
  }
  # pgvector + citext are auto-available from the pg16 image; CREATE EXTENSION
  # happens in db/migrations/0001_init.sql.
}

resource "aws_secretsmanager_secret" "db_master_password" {
  name        = "br-${var.env}-db-master"
  kms_key_id  = aws_kms_key.secrets.arn
  description = "RDS master password (rotated via Secrets Manager)."
}

resource "aws_secretsmanager_secret" "db_app_password" {
  name        = "br-${var.env}-db-app"
  kms_key_id  = aws_kms_key.secrets.arn
  description = "Per-app-role password. App role has NOBYPASSRLS."
}

# BREAKGLASS Postgres role (BYPASSRLS). Used ONLY by:
#   - The tenant-deletion executor (scripts/execute-tenant-deletions.ts)
#   - Manual ops investigation (audited, time-bounded)
#
# The connection URL is composed at task launch from this password +
# the RDS endpoint; the script refuses to start unless the connected
# role's pg_roles.rolbypassrls is true.
resource "aws_secretsmanager_secret" "db_breakglass_url" {
  name        = "br-${var.env}-db-breakglass-url"
  kms_key_id  = aws_kms_key.secrets.arn
  description = "Full postgres:// URL using the BREAKGLASS role. Use only by tenant-deletion executor + audited ops."

  # Recovery window 7 days because rotating this kills the executor.
  recovery_window_in_days = 7
}

resource "aws_secretsmanager_secret" "ama_license" {
  name        = "br-${var.env}-ama-license"
  kms_key_id  = aws_kms_key.secrets.arn
  description = "AMA CPT license token."
}

resource "aws_secretsmanager_secret" "cms_coverage" {
  name        = "br-${var.env}-cms-coverage"
  kms_key_id  = aws_kms_key.secrets.arn
  description = "CMS Coverage API token."
}

resource "aws_db_instance" "this" {
  identifier        = "br-${var.env}-pg16"
  engine            = "postgres"
  engine_version    = "16.4"
  instance_class    = var.db_instance_class
  allocated_storage     = var.db_allocated_storage_gb
  max_allocated_storage = var.db_allocated_storage_gb * 4
  storage_type          = "gp3"
  storage_encrypted     = true
  kms_key_id            = aws_kms_key.rds.arn

  multi_az                  = var.env == "prod"
  db_subnet_group_name      = aws_db_subnet_group.this.name
  parameter_group_name      = aws_db_parameter_group.this.name
  vpc_security_group_ids    = [aws_security_group.rds.id]
  publicly_accessible       = false
  deletion_protection       = var.env == "prod"
  performance_insights_enabled = true
  performance_insights_kms_key_id = aws_kms_key.rds.arn
  backup_retention_period   = 35
  backup_window             = "06:00-07:00"
  maintenance_window        = "sun:07:30-sun:08:30"
  copy_tags_to_snapshot     = true
  enabled_cloudwatch_logs_exports = ["postgresql"]

  username = "admin"
  manage_master_user_password = true

  # pgvector extension is loaded by the application migration, not here.
}
