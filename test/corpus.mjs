// The golden corpus.
//
// The round-trip claim — "we never destroy code we did not model" — is only
// worth making if something checks it against code that is *awkward*. So the
// corpus is generated deliberately hostile: CRLF line endings, tabs, unicode in
// comments, heredocs containing braces, `dynamic` blocks, nested objects,
// `for_each`, trailing whitespace, no trailing newline, provider blocks between
// resources.
//
// Every fixture is asserted byte-identical after an ingest→emit cycle with no
// edits, and byte-identical outside the edited line when one replica count is
// changed. That is the same discipline as ArchSim 1.x's suite, pointed at the
// failure mode that has killed every previous "visual Terraform".

export const HCL_CORPUS = [
  {
    name: 'plain',
    text: `resource "aws_instance" "web" {
  count         = 3
  instance_type = "m6i.large"
  ami           = "ami-1"
}
`,
  },
  {
    name: 'comments-around-count',
    text: `# The fleet size was decided in RFC-114 and should not be changed casually.
resource "aws_instance" "web" {
  # This number is load-bearing.
  count = 4 # do not change without asking the on-call

  instance_type = "m6i.large" // line comment, second style
  ami           = "ami-1"
}
`,
  },
  {
    name: 'crlf',
    text: 'resource "aws_instance" "web" {\r\n  count         = 2\r\n  instance_type = "m6i.large"\r\n  ami           = "ami-1"\r\n}\r\n',
  },
  {
    name: 'tabs-and-trailing-space',
    text: 'resource "aws_instance" "web" {\n\tcount = 5   \n\tinstance_type = "m6i.large"\t\n\tami = "ami-1"\n}\n',
  },
  {
    name: 'no-trailing-newline',
    text: `resource "aws_db_instance" "main" {
  identifier     = "db"
  engine         = "postgres"
  instance_class = "db.r6g.large"
  multi_az       = true
}`,
  },
  {
    name: 'unicode-comments',
    text: `# 這個資源是主要的資料庫 — ArchSim must not mangle these bytes
# émojis too: 🏗️ 🧱 ✂️
resource "aws_db_instance" "main" {
  identifier     = "db"
  instance_class = "db.r6g.xlarge"
  multi_az       = true
}
`,
  },
  {
    name: 'heredoc-with-braces',
    text: `resource "aws_instance" "web" {
  count = 2
  ami   = "ami-1"

  user_data = <<-EOT
    #!/bin/bash
    if [ -f /etc/config ]; then
      echo "{ braces } inside a heredoc"
    fi
  EOT

  instance_type = "m6i.large"
}
`,
  },
  {
    name: 'dynamic-block',
    text: `resource "aws_security_group" "app" {
  name = "app"

  dynamic "ingress" {
    for_each = [443, 8080, 9090]
    content {
      from_port = ingress.value
      to_port   = ingress.value
      protocol  = "tcp"
    }
  }
}

resource "aws_instance" "web" {
  count         = 6
  instance_type = "c6i.xlarge"
  ami           = "ami-1"
}
`,
  },
  {
    name: 'for-each-unresolvable',
    text: `variable "regions" {
  type = set(string)
}

resource "aws_instance" "web" {
  for_each      = var.regions
  instance_type = "m6i.large"
  ami           = "ami-1"
}
`,
  },
  {
    name: 'dynamic-count',
    text: `resource "aws_instance" "web" {
  count         = var.fleet_size * 2
  instance_type = "m6i.large"
  ami           = "ami-1"
}
`,
  },
  {
    name: 'nested-objects',
    text: `resource "aws_opensearch_domain" "search" {
  domain_name = "logs"

  cluster_config {
    instance_type  = "r6g.large.search"
    instance_count = 4

    zone_awareness_config {
      availability_zone_count = 3
    }
  }

  tags = {
    owner = "platform"
    tier  = "1"
  }
}
`,
  },
  {
    name: 'providers-between-resources',
    text: `terraform {
  required_version = ">= 1.5"
}

provider "aws" {
  region = "eu-west-1"
}

resource "aws_sqs_queue" "orders" {
  name = "orders"
}

provider "aws" {
  alias  = "dr"
  region = "eu-central-1"
}

resource "aws_instance" "web" {
  provider      = aws.dr
  count         = 2
  instance_type = "m6i.large"
  ami           = "ami-1"
}

output "queue_url" {
  value = aws_sqs_queue.orders.url
}
`,
  },
  {
    name: 'unmapped-resource',
    text: `resource "acme_widget" "thing" {
  size  = "large"
  color = "blue"
}

resource "aws_instance" "web" {
  count         = 1
  instance_type = "m6i.large"
  ami           = "ami-1"
}
`,
  },
  {
    name: 'block-comment',
    text: `/*
 * A block comment, which a naive line-based parser eats.
 * resource "aws_instance" "decoy" { count = 99 }
 */
resource "aws_instance" "web" {
  count         = 7
  instance_type = "m6i.large"
  ami           = "ami-1"
}
`,
  },
  {
    name: 'ecs-service',
    text: `resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.main.id
  desired_count   = 12
  task_definition = aws_ecs_task_definition.api.arn
  launch_type     = "FARGATE"
}
`,
  },
  {
    name: 'gcp',
    text: `resource "google_sql_database_instance" "main" {
  name             = "orders"
  database_version = "POSTGRES_15"

  settings {
    tier              = "db-custom-4-16384"
    availability_type = "REGIONAL"
  }
}

resource "google_redis_instance" "cache" {
  name           = "sessions"
  memory_size_gb = 5
}
`,
  },
  {
    name: 'azure',
    text: `resource "azurerm_postgresql_flexible_server" "main" {
  name                = "orders"
  sku_name            = "GP_Standard_D4s_v3"
  storage_mb          = 262144
  resource_group_name = "prod"
}
`,
  },
]

export const K8S_CORPUS = [
  {
    name: 'deployment-plain',
    text: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: api
  namespace: prod
spec:
  replicas: 3
  selector:
    matchLabels:
      app: api
  template:
    metadata:
      labels:
        app: api
    spec:
      containers:
        - name: api
          image: example/api:1.0.0
          resources:
            requests:
              cpu: "2"
`,
  },
  {
    name: 'multi-doc-with-comments',
    text: `# leading comment
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
  namespace: prod
data:
  MODE: "strict"
---
# a deployment, after a comment and a separator
apiVersion: apps/v1
kind: Deployment
metadata:
  name: worker
  namespace: prod
spec:
  replicas: 6
  selector:
    matchLabels:
      app: worker
  template:
    metadata:
      labels:
        app: worker
    spec:
      containers:
        - name: worker
          image: example/worker:2.1.0
`,
  },
  {
    name: 'statefulset-quoted',
    text: `apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: "orders"
  namespace: 'prod'
spec:
  serviceName: orders
  replicas: 2
  selector:
    matchLabels:
      app: orders
  template:
    metadata:
      labels:
        app: orders
    spec:
      containers:
        - name: postgres
          image: "postgres:16.3"
          resources:
            limits:
              cpu: "8"
              memory: 32Gi
`,
  },
  {
    name: 'inline-flow-maps',
    text: `apiVersion: apps/v1
kind: Deployment
metadata: {name: flow, namespace: prod, labels: {app: flow, tier: "2"}}
spec:
  replicas: 4
  selector: {matchLabels: {app: flow}}
  template:
    metadata: {labels: {app: flow}}
    spec:
      containers:
        - {name: flow, image: "example/flow:3.0.0"}
`,
  },
]
