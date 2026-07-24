---
title: Terragrunt 的 Infrastructure-Catalog 模式：可复用基础设施怎么组织
date: 2026-07-24 09:00:00
tags: [terragrunt, terraform, iac]
categories: Devops
cover: /images/terragrunt/terragrunt-infrastructure-catalog-explained.png
description: '照着 Gruntwork 官方的 terragrunt-infrastructure-catalog-example 仓库，讲清楚 modules/units/stacks 三层组织方式、`terragrunt catalog`/`scaffold` 命令，以及 monorepo vs polyrepo 的权衡。'
---

系列第一篇讲了 module/unit/stack 这三个术语，用的是一个只有一个 unit 的最小例子。真实场景里，一个团队往往要维护几十上百种可复用的基础设施模式——数据库、消息队列、Lambda 服务、安全组……这些模式怎么组织、怎么让别人安全地复用，是 Terragrunt 生态里 **Infrastructure-Catalog** 这套约定要解决的问题。这一篇照着 Gruntwork 官方的 [terragrunt-infrastructure-catalog-example](https://github.com/gruntwork-io/terragrunt-infrastructure-catalog-example) 仓库讲。

![Terragrunt Infrastructure-Catalog 模式：可复用基础设施的组织艺术](/images/terragrunt/terragrunt-infrastructure-catalog-explained.png)

---

## 1. 什么是 Infrastructure-Catalog

按官方的定义：

> An infrastructure-catalog is a repository that contains the best practice infrastructure patterns you or your organization wants to use across your infrastructure estate. This is a Git repository that is vetted, and tested to reliably provision the infrastructure patterns you need.

翻译过来就是：一个专门存放"经过验证、测试过的可复用基础设施模式"的仓库，通常用语义化版本（SemVer）来管理，跟实际部署基础设施的仓库（Infrastructure-Live，下一篇讲）分开。

## 2. 三层组织：modules → units → stacks

这个仓库自己按三层组织内容：

- **`modules/`**：最底层，纯 OpenTofu/Terraform 代码，只管一件事。这个仓库里有 `ec2-asg-service`、`ecr-repository`、`ecs-fargate-service`、`iam-role`、`lambda-service`、`mysql`、`s3-bucket`、`sg`、`sg-rule`、`dynamodb-table` 等模块。
- **`units/`**：给 module 包一层 Terragrunt 配置，加上业务逻辑和依赖声明，让它能被系统化地部署。比如 `lambda-iam-role-to-dynamodb`、`lambda-stateful-service`、`dynamodb-table` 这些 unit。
- **`stacks/`**：把多个 unit 编排成一套完整方案，比如仓库里的 `ec2-asg-stateful-service` stack，一次性把 EC2 ASG 服务、负载均衡、MySQL 数据库都编排到位。

一个具体的 unit 长什么样？拿 `units/lambda-iam-role-to-dynamodb/terragrunt.hcl` 举例：

```hcl
include "root" {
  path = find_in_parent_folders("root.hcl")
}

terraform {
  source                 = "../..//modules/iam-role"
  update_source_with_cas = true
}

inputs = {
  name = values.name
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })
}
```

这里有个细节：`inputs` 里的 `values.name` 不是 `local.name`，而是 `values.name`——`values` 是当这个 unit 被某个 `terragrunt.stack.hcl` 编排时，由 stack 文件传进来的配置（下一篇细讲）。`update_source_with_cas = true` 是 Terragrunt 1.1 引入的属性，通过内容寻址存储（CAS）优化同仓库内相对路径引用的性能，属于比较新的特性。

## 3. 三种消费方式

### 手动引用固定版本

最直接的方式，在自己的 `terragrunt.hcl` 里写死一个 git 版本：

```hcl
terraform {
  source = "git::git@github.com:acme/terragrunt-infrastructure-catalog//units/lambda-service?ref=v1.0.0"
}
```

`ref` 锁定一个具体的 tag 或 commit，不同消费方可以按自己的节奏引用不同版本。

### `terragrunt catalog`：交互式浏览

先在 `root.hcl` 里配置好这个仓库的地址：

```hcl
catalog {
  urls = [
    "git::git@github.com:acme/terragrunt-infrastructure-catalog",
  ]
}
```

然后在想部署的目录下运行：

```bash
mkdir -p live/non-prod/us-east-1/my-lambda-service
cd live/non-prod/us-east-1/my-lambda-service
terragrunt catalog
```

会弹出一个终端交互界面，列出这个 catalog 仓库里所有能用的组件，用 `/` 搜索、`Enter` 选中、`S` 脚手架——直接把对应的 `terragrunt.hcl` 生成到当前目录。

### `terragrunt scaffold`：跳过交互直接生成

已经知道要哪个组件时，可以跳过 TUI：

```bash
terragrunt scaffold git::git@github.com:acme/terragrunt-infrastructure-catalog//modules/lambda-service
```

注意这里的双斜杠 `//`——用来指定仓库内要脚手架的具体路径。

这两个命令的意义在于：评估"要不要建一个 catalog"这件事本身成本很低，不需要一上来就把仓库结构定死，可以先放几个 module 进去，本地 `terragrunt catalog` 试跑一下引用体验。

## 4. Monorepo 还是 Polyrepo

这个仓库本身是一个 **monorepo**——modules/units/stacks 都在同一个仓库里。官方文档里有一段很中肯的权衡分析，值得完整搬过来：

**Monorepo 的优势**：
- **全局改动更容易**——一次严重安全漏洞修复或统一升级 Terraform 版本，一个 commit 就能覆盖全部组件；
- **搜索方便**——不用切多个仓库就能全文搜索所有代码；
- **CI 更简单**——所有代码一起测试、一起验证，不会出现"模块发新版本了但没人知道"这种滞后集成问题；
- **权限、PR 管理集中**——一个仓库一套流程。

**Monorepo 的代价**：
- **改动更难隔离**——改 A 模块的时候得想清楚会不会影响 B 模块；
- **测试时间只增不减**——仓库越大，每次提交都跑全量测试会越来越慢；
- **没有细粒度的依赖管理**——很难只针对某次改动影响到的组件做验证；
- **发版粒度是整个仓库**——哪怕只改了一个模块，打的 tag 也是全仓库的版本号。

**Polyrepo（一个组件一个仓库）** 优势和代价基本是上面的镜像：改动隔离彻底、测试更快，但全局改动要开很多个仓库的 PR，还容易碰上"钻石依赖"式的版本冲突。

官方的结论是：这组权衡没有标准答案，取决于团队的工具链和工作方式，选哪个都是合理的。

## 5. 发新版本的流程

改完 module 或 unit 代码后，官方推荐的流程很直接：

1. 在 `examples/` 目录写一个对应的最小示例，跑一遍 `tofu plan/apply/destroy` 确认能正常工作；
2. 更新 [Terratest](https://terratest.gruntwork.io/) 自动化测试（`test/` 目录），跑一遍确保没有回归；
3. 测试通过后 `git commit`，在仓库上打一个新的 release/tag（比如 `v0.0.2`）；
4. 消费方在自己 `terragrunt.hcl` 的 `source` 里把 `ref=` 改成新 tag，按自己的节奏升级。

---

这些 unit 既可以单独被引用，也可以被编排成一套完整方案一起管理——后者就是 Terragrunt **Stacks** 要解决的问题，也是下一篇的主题。
