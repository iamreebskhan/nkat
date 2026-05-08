/**
 * Datadog log forwarder. Subscribes the application + RDS + ALB log groups
 * to a Lambda that ships logs to Datadog HTTP intake. PHI scrubbing
 * happens both in-app (logger middleware) and again here as defense in
 * depth — the Lambda redacts SSN, MRN, member-id, and labelled patient
 * names before forwarding.
 *
 * The Lambda code lives in `infra/terraform/lambda/datadog-forwarder/`
 * and is built + zipped at apply time.
 */

data "aws_iam_policy_document" "dd_lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "dd_forwarder" {
  name               = "br-${var.env}-dd-forwarder"
  assume_role_policy = data.aws_iam_policy_document.dd_lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "dd_forwarder_basic" {
  role       = aws_iam_role.dd_forwarder.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "dd_forwarder" {
  statement {
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [var.datadog_api_key_secret_arn]
  }
  statement {
    actions   = ["kms:Decrypt"]
    resources = [aws_kms_key.secrets.arn, aws_kms_key.logs.arn]
  }
}

resource "aws_iam_role_policy" "dd_forwarder" {
  role   = aws_iam_role.dd_forwarder.id
  policy = data.aws_iam_policy_document.dd_forwarder.json
}

# Build the Lambda zip from local sources at apply time.
data "archive_file" "dd_forwarder" {
  type        = "zip"
  source_dir  = "${path.module}/lambda/datadog-forwarder"
  output_path = "${path.module}/.terraform/dd-forwarder.zip"
}

resource "aws_lambda_function" "dd_forwarder" {
  function_name    = "br-${var.env}-dd-forwarder"
  role             = aws_iam_role.dd_forwarder.arn
  runtime          = "nodejs20.x"
  handler          = "index.handler"
  filename         = data.archive_file.dd_forwarder.output_path
  source_code_hash = data.archive_file.dd_forwarder.output_base64sha256
  timeout          = 60
  memory_size      = 256
  reserved_concurrent_executions = 50

  environment {
    variables = {
      DD_SITE              = "datadoghq.com"
      DD_API_KEY_SECRET_ARN = var.datadog_api_key_secret_arn
      DD_SERVICE           = "billing-rules-${var.env}"
      DD_ENV               = var.env
    }
  }

  # PHI-bearing logs encrypted at rest in CloudWatch via KMS; the Lambda
  # decrypts under its own role to ship.
  kms_key_arn = aws_kms_key.logs.arn

  tracing_config { mode = "Active" }
}

resource "aws_lambda_permission" "allow_cw" {
  for_each      = toset([
    aws_cloudwatch_log_group.api.name,
    aws_cloudwatch_log_group.vpc_flow.name,
  ])
  statement_id  = "br-${var.env}-allow-${replace(each.value, "/", "-")}"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.dd_forwarder.function_name
  principal     = "logs.amazonaws.com"
  source_arn    = "arn:aws:logs:${var.region}:${data.aws_caller_identity.current.account_id}:log-group:${each.value}:*"
}

resource "aws_cloudwatch_log_subscription_filter" "api_to_dd" {
  name            = "br-${var.env}-api-to-dd"
  log_group_name  = aws_cloudwatch_log_group.api.name
  filter_pattern  = ""
  destination_arn = aws_lambda_function.dd_forwarder.arn
  depends_on      = [aws_lambda_permission.allow_cw]
}

data "aws_caller_identity" "current" {}
