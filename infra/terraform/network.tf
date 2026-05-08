/**
 * VPC + subnets across the configured AZs. Public subnets for the ALB only;
 * everything else (ECS tasks, RDS, NAT egress) lives in private subnets.
 *
 * Flow logs enabled to CloudWatch — required for the SOC 2 + HIPAA audit
 * trail on every network conversation in/out of the VPC.
 */
locals {
  az_count = length(var.availability_zones)

  # /16 → /20 public subnets (4096 IPs each), /18 private subnets (16384 IPs each).
  public_subnet_cidrs = [
    for i in range(local.az_count) :
    cidrsubnet(var.vpc_cidr, 4, i)
  ]
  private_subnet_cidrs = [
    for i in range(local.az_count) :
    cidrsubnet(var.vpc_cidr, 2, i + 1)
  ]
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = "br-${var.env}-vpc" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "br-${var.env}-igw" }
}

resource "aws_subnet" "public" {
  count                   = local.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = local.public_subnet_cidrs[count.index]
  availability_zone       = var.availability_zones[count.index]
  map_public_ip_on_launch = true
  tags                    = { Name = "br-${var.env}-public-${var.availability_zones[count.index]}" }
}

resource "aws_subnet" "private" {
  count             = local.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = local.private_subnet_cidrs[count.index]
  availability_zone = var.availability_zones[count.index]
  tags              = { Name = "br-${var.env}-private-${var.availability_zones[count.index]}" }
}

resource "aws_eip" "nat" {
  count  = local.az_count
  domain = "vpc"
  tags   = { Name = "br-${var.env}-nat-eip-${count.index}" }
}

resource "aws_nat_gateway" "this" {
  count         = local.az_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "br-${var.env}-nat-${count.index}" }
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = { Name = "br-${var.env}-public-rt" }
}

resource "aws_route_table_association" "public" {
  count          = local.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "private" {
  count  = local.az_count
  vpc_id = aws_vpc.this.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.this[count.index].id
  }
  tags = { Name = "br-${var.env}-private-rt-${count.index}" }
}

resource "aws_route_table_association" "private" {
  count          = local.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private[count.index].id
}

# Flow logs (CloudWatch) — required by SOC 2 + HIPAA evidence collection.
resource "aws_cloudwatch_log_group" "vpc_flow" {
  name              = "/br/${var.env}/vpc-flow"
  retention_in_days = 365
  kms_key_id        = aws_kms_key.logs.arn
}

resource "aws_iam_role" "vpc_flow" {
  name               = "br-${var.env}-vpc-flow-logs"
  assume_role_policy = data.aws_iam_policy_document.vpc_flow_assume.json
}

data "aws_iam_policy_document" "vpc_flow_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["vpc-flow-logs.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "vpc_flow" {
  role = aws_iam_role.vpc_flow.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Action = [
        "logs:CreateLogStream",
        "logs:PutLogEvents",
        "logs:DescribeLogStreams",
        "logs:DescribeLogGroups",
      ]
      Resource = "${aws_cloudwatch_log_group.vpc_flow.arn}:*"
    }]
  })
}

resource "aws_flow_log" "this" {
  iam_role_arn    = aws_iam_role.vpc_flow.arn
  log_destination = aws_cloudwatch_log_group.vpc_flow.arn
  traffic_type    = "ALL"
  vpc_id          = aws_vpc.this.id
}
