variable "env" {
  description = "Environment name (prod | stage)."
  type        = string
  validation {
    condition     = contains(["prod", "stage"], var.env)
    error_message = "env must be prod or stage"
  }
}

variable "region" {
  description = "AWS region. Production runs in us-east-1; DR target is us-west-2."
  type        = string
  default     = "us-east-1"
}

variable "vpc_cidr" {
  description = "VPC CIDR block. Use a /16 to leave room for sub-environments."
  type        = string
  default     = "10.20.0.0/16"
}

variable "availability_zones" {
  description = "AZs to span subnets across (must be ≥3 for RDS Multi-AZ + ECS spread)."
  type        = list(string)
}

variable "db_instance_class" {
  description = "RDS instance class. Prod = db.r6g.large; stage = db.t4g.medium."
  type        = string
}

variable "db_allocated_storage_gb" {
  description = "Initial RDS storage in GB. Autoscaling enabled separately."
  type        = number
  default     = 100
}

variable "ecs_task_cpu" {
  description = "Fargate task CPU units. 2048 = 2 vCPU."
  type        = number
}

variable "ecs_task_memory" {
  description = "Fargate task memory in MB. Must satisfy CPU/mem combination rules."
  type        = number
}

variable "ecs_service_min_count" {
  description = "Autoscaling floor for the API service."
  type        = number
  default     = 3
}

variable "ecs_service_max_count" {
  description = "Autoscaling ceiling for the API service."
  type        = number
  default     = 20
}

variable "domain_name" {
  description = "Apex domain for the API + app, e.g. example.com."
  type        = string
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone ID where the api + app records are created."
  type        = string
}

variable "acm_cert_arn" {
  description = "ACM cert ARN covering api.<domain> and app.<domain>. Created out-of-band so DNS validation can complete before apply."
  type        = string
}

variable "bedrock_model_ids" {
  description = "Bedrock model IDs the task role is permitted to invoke."
  type        = list(string)
  default     = ["anthropic.claude-3-5-sonnet-20241022-v2:0"]
}

variable "datadog_api_key_secret_arn" {
  description = "Pre-existing Secrets Manager ARN holding the Datadog API key."
  type        = string
}

variable "alert_email" {
  description = "SNS subscription target for high-priority CloudWatch alarms (PagerDuty integration consumes the topic in parallel)."
  type        = string
}

# OIDC SSO (optional). Leave the URL + client id blank to keep the
# backend in dev_header mode; setting both enables /v1/auth/sso/start
# and the frontend's SSO button via /v1/auth/mode.
variable "oidc_authorization_url" {
  description = "OIDC authorization endpoint, e.g. https://idp.example.com/oauth2/authorize. Empty disables SSO."
  type        = string
  default     = ""
}
variable "oidc_client_id" {
  description = "OIDC client id."
  type        = string
  default     = ""
}
variable "oidc_redirect_uri" {
  description = "OIDC redirect URI registered with the IdP, e.g. https://api.example.com/v1/auth/sso/callback."
  type        = string
  default     = ""
}
variable "oidc_scope" {
  description = "OIDC scopes to request."
  type        = string
  default     = "openid profile email"
}
