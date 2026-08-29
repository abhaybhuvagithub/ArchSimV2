terraform {
  required_version = ">= 1.5"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.region
}

variable "region" {
  type    = string
  default = "us-east-1"
}

variable "tags" {
  type    = map(string)
  default = { owner = "platform", env = "prod" }
}

variable "app_replicas" {
  type        = number
  default     = 6
  description = "Set from the environment tfvars — deliberately dynamic, to exercise Mode B degradation."
}

# ── network ────────────────────────────────────────────────────────────────
# Structural resources. ArchSim renders the estate without modelling these as
# queueing stations, and re-emits them byte for byte.

resource "aws_vpc" "main" {
  cidr_block           = "10.0.0.0/16"
  enable_dns_hostnames = true
  tags                 = var.tags
}

resource "aws_subnet" "private" {
  count             = 3
  vpc_id            = aws_vpc.main.id
  cidr_block        = cidrsubnet(aws_vpc.main.cidr_block, 8, count.index)
  availability_zone = data.aws_availability_zones.available.names[count.index]
  tags              = var.tags
}

resource "aws_security_group" "app" {
  name   = "app-sg"
  vpc_id = aws_vpc.main.id

  # A dynamic block: exactly the kind of thing a naive HCL evaluator gets wrong
  # and a regenerating emitter destroys. Neither happens here.
  dynamic "ingress" {
    for_each = [443, 8080]
    content {
      from_port   = ingress.value
      to_port     = ingress.value
      protocol    = "tcp"
      cidr_blocks = ["10.0.0.0/16"]
    }
  }
}

# ── edge ───────────────────────────────────────────────────────────────────

resource "aws_lb" "main" {
  name               = "checkout-alb"
  internal           = false
  load_balancer_type = "application"
  subnets            = aws_subnet.private[*].id
  tags               = var.tags
}

resource "aws_lb_target_group" "app" {
  name     = "checkout-tg"
  port     = 8080
  protocol = "HTTP"
  vpc_id   = aws_vpc.main.id
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.main.arn
  port              = 443
  protocol          = "HTTPS"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

# ── compute ────────────────────────────────────────────────────────────────

resource "aws_instance" "checkout" {
  # This count is a literal, so Mode B can read it and the emitter can patch it.
  count         = 6
  ami           = "ami-0abcdef1234567890"
  instance_type = "m6i.xlarge"
  subnet_id     = aws_subnet.private[count.index % 3].id

  user_data = <<-EOT
    #!/bin/bash
    echo "a heredoc, to prove the parser survives one"
    systemctl start checkout
  EOT

  tags = merge(var.tags, { Name = "checkout" })
}

resource "aws_lb_target_group_attachment" "checkout" {
  count            = 6
  target_group_arn = aws_lb_target_group.app.arn
  target_id        = aws_instance.checkout[count.index].id
  port             = 8080
}

# A worker whose replica count is *not* a literal. Mode B shows it as 1× with a
# badge rather than inventing a number; Mode A resolves it exactly.
resource "aws_instance" "fulfilment" {
  count         = var.app_replicas
  ami           = "ami-0abcdef1234567890"
  instance_type = "m6i.large"
  subnet_id     = aws_subnet.private[0].id
  tags          = var.tags
}

resource "aws_lambda_function" "checkout_hook" {
  function_name = "checkout-hook"
  role          = aws_iam_role.lambda.arn
  handler       = "index.handler"
  runtime       = "nodejs20.x"
  memory_size   = 512
  timeout       = 30

  environment {
    variables = {
      DATABASE_URL = aws_db_instance.main.endpoint
      QUEUE_URL    = aws_sqs_queue.orders.url
    }
  }
}

resource "aws_iam_role" "lambda" {
  name               = "checkout-hook-role"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

# ── data ───────────────────────────────────────────────────────────────────

resource "aws_db_instance" "main" {
  identifier           = "checkout-db"
  engine               = "postgres"
  engine_version       = "16.3"
  instance_class       = "db.r6g.xlarge"
  allocated_storage    = 200
  multi_az             = true
  db_subnet_group_name = aws_db_subnet_group.main.name
  skip_final_snapshot  = false
  tags                 = var.tags
}

resource "aws_db_subnet_group" "main" {
  name       = "checkout-db-subnets"
  subnet_ids = aws_subnet.private[*].id
}

resource "aws_elasticache_replication_group" "sessions" {
  replication_group_id = "checkout-sessions"
  description          = "session cache"
  node_type            = "cache.r6g.large"
  num_cache_clusters   = 2
  engine               = "redis"
}

resource "aws_sqs_queue" "orders" {
  name                       = "orders"
  visibility_timeout_seconds = 60
  tags                       = var.tags
}

resource "aws_s3_bucket" "receipts" {
  bucket = "checkout-receipts-prod"
  tags   = var.tags
}

# ── outputs ────────────────────────────────────────────────────────────────

output "alb_dns_name" {
  value = aws_lb.main.dns_name
}
