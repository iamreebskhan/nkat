# Terraform — Production Infra Skeleton

Minimal, reviewable Terraform that stands up the **prod** environment per
`docs/RUNBOOKS/production-cutover.md`. The skeleton is intentionally not a
turnkey one-button deploy; it forces a human to read what they're applying
when they go live with HIPAA-protected data.

## Layout

```
infra/terraform/
  README.md                 # this file
  versions.tf               # required_providers + required_version
  variables.tf              # all inputs (no hard-coded values)
  network.tf                # VPC + subnets + NAT + flow logs
  security.tf               # IAM roles, KMS keys, security groups
  rds.tf                    # Postgres 16 Multi-AZ + parameter group + backups
  ecs.tf                    # cluster, task def, service, ALB, ACM
  bedrock.tf                # VPC endpoint + IAM grants
  secrets.tf                # Secrets Manager entries (values read from tfvars)
  observability.tf          # CloudWatch alarms + Datadog forwarder Lambda
  outputs.tf
```

## Why no `prod.tfvars` checked in

The values that distinguish prod from stage (account ID, hosted-zone ID,
domain names, contact emails, secret ARNs) are sensitive enough that we
keep them in 1Password + a one-time-fill on plan/apply. CI does not auto-
apply Terraform; humans do, with secondary review.

## Apply procedure

1. Auth into the prod AWS account via SSO (NOT a long-lived access key).
2. `terraform init -backend-config=prod.s3.tfbackend` (the backend config
   itself lives in 1Password — never in git).
3. `terraform plan -var-file=prod.tfvars -out=plan.bin`
4. Secondary engineer reviews `terraform show plan.bin`.
5. `terraform apply plan.bin` once review is signed off in PR.
6. Tag the Terraform state with the release SHA + cutover ticket.

## What's deliberately NOT here

- App-level migrations (those live in `db/migrations/`).
- Seed data (lives in `db/seed/`).
- App container builds (CI publishes images; Terraform consumes the tag).
- Stage env (uses a parallel module set with cheaper instance classes).

The goal of this skeleton is to be **readable on day one**, not exhaustive.
We expand it as we hit real production needs (WAF, Shield Advanced,
Inspector continuous scanning) post-cutover.
