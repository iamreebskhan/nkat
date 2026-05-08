/**
 * VPC endpoint for Bedrock — keeps model invocations on the AWS backbone
 * instead of egressing through NAT to the public internet. Reduces latency
 * + sensitive-traffic exposure + NAT cost.
 */
resource "aws_vpc_endpoint" "bedrock" {
  vpc_id              = aws_vpc.this.id
  service_name        = "com.amazonaws.${var.region}.bedrock-runtime"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = aws_subnet.private[*].id
  security_group_ids  = [aws_security_group.ecs.id]
  private_dns_enabled = true
}
