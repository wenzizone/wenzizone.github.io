---
title: Terragrunt Stacks 与 Infrastructure-Live：account/region 分层与自动依赖解析
date: 2026-07-25 09:00:00
tags: [terragrunt, terraform, iac]
categories: Devops
cover: /images/terragrunt/terragrunt-stacks-explained.png
description: '照着 Gruntwork 官方的 terragrunt-infrastructure-live-stacks-example 仓库，讲清楚 account/region/resources 分层约定、terragrunt.stack.hcl 的 values/autoinclude 机制。'
---

上一篇讲了 Infrastructure-Catalog——一堆经过验证的可复用基础设施模式，用 `modules/units/stacks` 组织，靠 git tag 版本化。但 catalog 只回答"能部署什么"，不回答"实际部署了什么"。后者是 **Infrastructure-Live** 仓库的职责，这一篇照着 Gruntwork 官方的 [terragrunt-infrastructure-live-stacks-example](https://github.com/gruntwork-io/terragrunt-infrastructure-live-stacks-example) 讲。

![Terragrunt Stacks: The Modern Art of Infrastructure as Code (IaC) Management](/images/terragrunt/terragrunt-stacks-explained.png)

---

## 1. Infrastructure-Live 与 Infrastructure-Catalog 的分工

官方的定义很直接：

> An `infrastructure-live` repository is a Gruntwork best practice for managing your "live" infrastructure. That is, the infrastructure that is actually provisioned, as opposed to infrastructure patterns that *can* be provisioned.

两个仓库配合的方式是：catalog 仓库里维护通用的 module/unit 模式，live 仓库里只放"引用 catalog 里哪个版本、传了什么参数"这些跟具体环境相关的配置，不直接写 Terraform/OpenTofu 代码。

## 2. account → region → resources 分层

Live 仓库推荐按这个层级组织目录：

```
account
 └ region
    └ resources
```

- **account**：对应一个云账号（比如 `non-prod`、`prod`）；
- **region**：对应一个云区域（比如 `us-east-1`）；
- **resources**：具体要管理的资源（比如 `stateful-lambda-service`）。

这个层级天然对齐了账号和区域的认证边界，也方便按账号/区域划分"爆炸半径"。如果一个团队在同一个云账号里管理多个环境（dev/staging/prod），可以在 region 下面再加一层 environment：

```
account
 └ region
    └ environment
       └ resources
```

官方还提到一个 `_global` 目录的约定，用来管理"跨 region/environment 共享"的资源（比如账号级的 IAM 用户、region 级的 Route 53 记录）：

```
account
 ├ _global
 │  └ resources
 └ region
    ├ _global
    │  └ resources
    └ environment
       └ resources
```

## 3. account.hcl / region.hcl：怎么被 root.hcl 读取

`non-prod/account.hcl` 和 `non-prod/us-east-1/region.hcl` 各自只放一段 `locals`：

```hcl
# non-prod/account.hcl
locals {
  account_name   = "non-prod"
  aws_account_id = get_env("EX_NON_PROD_ACCOUNT_ID")
}
```

```hcl
# non-prod/us-east-1/region.hcl
locals {
  aws_region = "us-east-1"
}
```

关键在 `root.hcl` 怎么把这两个文件的值"捞"出来用——注意这里不是 `include`，而是 `read_terragrunt_config()`：

```hcl
locals {
  account_vars = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  region_vars  = read_terragrunt_config(find_in_parent_folders("region.hcl"))

  account_name = local.account_vars.locals.account_name
  account_id   = local.account_vars.locals.aws_account_id
  aws_region   = local.region_vars.locals.aws_region
}

generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "aws" {
  region = "${local.aws_region}"
  allowed_account_ids = ["${local.account_id}"]
}
EOF
}

remote_state {
  backend = "s3"
  config = {
    bucket = "${get_env("EX_BUCKET_PREFIX", "")}terragrunt-example-tf-state-${local.account_name}-${local.aws_region}"
    key    = "${path_relative_to_include()}/tf.tfstate"
    region = local.aws_region
  }
}
```

`include` 是用来合并一份完整 Terragrunt 单元配置的；而 `account.hcl`/`region.hcl` 只是"一堆共享 locals 的容器"，用 `read_terragrunt_config()` 单独读出来、按需取字段，语义上更准确。

## 4. `terragrunt.stack.hcl`：把多个 unit 编排成一个 stack

一个 stack 文件用 `unit` 块声明每个要一起管理的组件。以 `non-prod/us-east-1/stateful-lambda-service/terragrunt.stack.hcl` 为例（简化版）：

```hcl
locals {
  name = "stateful-lambda-service-dev"
}

unit "db" {
  source = "github.com/xxx/terragrunt-infrastructure-catalog//units/dynamodb-table"
  path   = "db"
  values = {
    version       = "main"
    name          = "${local.name}-db"
    hash_key      = "Id"
    hash_key_type = "S"
  }
}

unit "role" {
  source = "github.com/xxx/terragrunt-infrastructure-catalog//units/lambda-iam-role-to-dynamodb"
  path   = "roles/lambda-iam-role-to-dynamodb"
  values = {
    version = "main"
    name    = "${local.name}-role"
  }
  autoinclude {
    dependency "dynamodb_table" {
      config_path  = unit.db.path
      mock_outputs = { arn = "arn:aws:dynamodb:us-east-1:123456789012:table/example-table" }
    }
  }
}

unit "lambda_service" {
  source = "github.com/xxx/terragrunt-infrastructure-catalog//units/js-lambda-stateful-service"
  path   = "service"
  values = {
    version    = "main"
    name       = local.name
    runtime    = "nodejs22.x"
    source_dir = "./src"
    handler    = "index.handler"
  }
  autoinclude {
    dependency "role" {
      config_path  = unit.role.path
      mock_outputs = { arn = "arn:aws:iam::123456789012:role/lambda-iam-role-to-dynamodb" }
    }
    dependency "dynamodb_table" {
      config_path  = unit.db.path
      mock_outputs = { name = "dynamodb-table" }
    }
  }
}
```

两个关键机制：

- **`values` 是独立于 `inputs` 的一条通道**：`unit` 块里写的 `values`，会被对应 unit 自己的 `terragrunt.hcl` 以 `values.name`、`values.runtime` 这样的写法读取——上一篇 `lambda-iam-role-to-dynamodb` 那个 unit 里的 `values.name` 就是这么来的。
- **`autoinclude` + `dependency` + `unit.x.path`**：`role` 依赖 `db`，`lambda_service` 依赖 `role` 和 `db`，这些依赖关系直接写在 stack 文件里，`config_path = unit.db.path` 会自动解析出 `db` 这个 unit 生成到的实际目录，不用手算相对路径（比如 `../../db`）——`db`/`role` 挪了目录，引用会自动跟着变。`mock_outputs` 让 `plan` 阶段依赖还没创建时也能顺利跑通。这是 "stack dependencies" 特性，**Terragrunt v1.1.0 及以上默认开启**。

## 5. 怎么跑起来

在 stack 目录下：

```bash
cd non-prod/us-east-1/stateful-lambda-service
terragrunt run --all --non-interactive plan
terragrunt run --all --non-interactive apply
```

`run --all` 会先根据 `terragrunt.stack.hcl` 里声明的依赖关系生成一个 DAG，按正确顺序（`db` → `role` → `lambda_service`）执行。跑完之后，可以用 `terragrunt stack output` 一次性看到整个 stack 里所有 unit 的输出，按 "stack → unit → 输出名" 的层级组织：

```bash
$ terragrunt stack output
role = { arn = "arn:aws:iam::...:role/stateful-lambda-service-dev-role" }
db = { arn = "arn:aws:dynamodb:...:table/stateful-lambda-service-dev-db" }
lambda_service = { function_url = "https://xxx.lambda-url.us-east-1.on.aws/" }
```

---

Infrastructure-Catalog 负责沉淀可复用模式，Infrastructure-Live 用 account/region 分层 + Stacks 负责把这些模式实际部署、管理依赖关系——这一套放在一起，是 Gruntwork 官方推荐的"能撑住任何规模"的组织方式。听起来很完整，最后一篇回到我们自己的 OKE 仓库，看看这些模式具体套上去，能用上几分、哪些暂时还用不上。
