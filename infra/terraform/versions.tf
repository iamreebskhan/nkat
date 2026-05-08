terraform {
  required_version = ">= 1.9.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.70"
    }
    datadog = {
      source  = "DataDog/datadog"
      version = "~> 3.50"
    }
  }

  # Backend config supplied at `terraform init` via -backend-config; never
  # in git so the bucket + key + DynamoDB lock table can be rotated without
  # a code change.
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      Project     = "billing-rules-platform"
      Environment = var.env
      ManagedBy   = "terraform"
      Compliance  = "hipaa"
    }
  }
}

# Datadog provider — credentials read from env (DD_API_KEY +
# DD_APP_KEY) by the runner; not stored in tfvars.
provider "datadog" {
  api_url = "https://api.datadoghq.com/"
}
