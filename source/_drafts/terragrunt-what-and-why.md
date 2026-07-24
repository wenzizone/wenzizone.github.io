---
title: Terragrunt 是什么，为什么要用它——从一个最小例子开始
date: 2026-07-23 09:00:00
tags: [terragrunt, terraform, iac]
categories: Devops
cover: /images/terragrunt/terragrunt-what-and-why.png
description: '面向 Terragrunt 新手的入门篇：讲清楚它解决的具体问题、module/unit/stack 三个核心术语，并动手跑一个不需要云账号的最小例子。'
---

这是一个 Terragrunt 系列的第一篇。后面两篇会照着 Gruntwork 官方的两个示例仓库，讲 Infrastructure-Catalog（可复用模式怎么组织、怎么版本化）和 Infrastructure-Live + Stacks（account/region 分层、自动依赖解析）这些进阶话题；最后一篇回到我们自己维护的 OCI OKE 集群 Terraform 仓库，看这些模式实际落地能用上几分。但在那之前，先花一篇讲清楚 Terragrunt 到底是什么、解决什么问题——这样后面每一篇里的设计选择，才有地方"挂"。

![Terragrunt 入门指南：从重复劳动到优雅管理](/images/terragrunt/terragrunt-what-and-why.png)

---

## 1. 先说清楚它解决的问题

如果你已经会用 Terraform/OpenTofu，通常会在多个环境（dev/test/prod）之间遇到几件重复的事：

1. **backend 和 provider 配置要在每个环境目录里抄一遍。** 这些配置几乎不随环境变化，但纯 Terraform 没有"全局共享一份配置"的机制，只能复制粘贴。
2. **同一份模块代码，不同环境只是参数不同。** 你要么维护一堆 `dev.tfvars`/`prod.tfvars`，要么用 Terraform Workspace——但 Workspace 共享同一份 state 文件的后端配置，环境之间隔离得并不彻底，出错代价也更高。
3. **环境之间有依赖时，apply 顺序得靠人记。** 比如先建好网络，再建依赖网络的集群，Terraform 本身不知道"先跑哪个目录"，全靠人肉维护一份操作手册。

Terragrunt 自己的定位说得很直接：

> Terragrunt is a thin wrapper for Terraform/OpenTofu that provides extra tools for working with multiple modules, remote state, and locking.

它不是替代 Terraform，而是在外面包一层——负责"多个模块怎么组织、状态怎么管理、加锁"这些 Terraform 本身不管的事，帮你把上面三个问题解决掉。

## 2. 三个必须先分清楚的术语

Terragrunt 官方文档里反复出现三个词，不先分清楚，后面看任何示例都会觉得绕：

- **module（模块）**：纯 Terraform/OpenTofu 代码，比如一个定义了"如何创建一台虚拟机"的 `.tf` 文件集合。它不知道自己会被部署几次、部署到哪个环境。
- **unit（单元）**：一个包含 `terragrunt.hcl` 的目录，对应**一份独立的 state**。它通过 `terraform.source` 指向某个 module，并通过 `inputs` 传入这次部署specific 的参数。可以理解成"某个 module 在某个具体环境下的一次实例化"。
- **stack（堆栈）**：一组需要放在一起管理的 unit，典型例子是"一整个环境"——比如一个 dev 环境可能同时需要一个网络 unit、一个数据库 unit、一个应用 unit，这三个 unit 合起来就是一个 stack。

一句话总结这三层关系：**module 是"怎么造"，unit 是"造一个出来"，stack 是"一组要一起造的东西"。**

## 3. 安装

最简单的方式是用 [mise](https://mise.jdx.dev/) 统一管理 Terragrunt 和 OpenTofu/Terraform 的版本：

```bash
# 安装 mise 之后
mise use terragrunt opentofu
```

也可以直接参考 [Terragrunt 官方安装文档](https://terragrunt.gruntwork.io/docs/getting-started/install/) 下载对应平台的二进制。

## 4. 动手跑一个最小例子

不需要连接任何云账号，本地就能把整个流程跑一遍。先建一个纯 Terraform 的 module，只做一件事：把一个字符串原样输出。

```
live-demo/
├── modules/
│   └── shared/
│       ├── variables.tf
│       └── outputs.tf
└── foo/
    └── terragrunt.hcl
```

`modules/shared/variables.tf`：

```hcl
variable "content" {
  type = string
}
```

`modules/shared/outputs.tf`：

```hcl
output "content" {
  value = var.content
}
```

`foo/terragrunt.hcl`（这就是一个 unit）：

```hcl
terraform {
  source = "../modules/shared"
}

inputs = {
  content = "Hello from foo"
}
```

进入 `foo` 目录跑一下：

```bash
cd live-demo/foo
terragrunt apply
```

这一步 Terragrunt 实际上帮你做了这几件事：

1. 把 `../modules/shared` 的内容拷贝到一个临时目录（`.terragrunt-cache`）；
2. 把 `inputs` 里的键值对转换成 Terraform 变量，自动完成 `terraform init`；
3. 调用真正的 `terraform`/`tofu` 二进制在这个临时目录里执行 `apply`。

也就是说，**你完全不需要手动跑 `terraform init`**——只要目录里有一份（哪怕是空的）`terragrunt.hcl`，Terragrunt 就会在需要的时候自动初始化。

## 5. 几个最常用的命令

| 命令 | 作用 |
|---|---|
| `terragrunt plan` / `apply` / `destroy` | 对当前目录（单个 unit）执行 |
| `terragrunt run --all plan` / `apply` | 对当前目录下所有子目录里的 unit 一起执行，会按依赖关系自动排序 |
| `terragrunt output` | 查看当前 unit 的输出值 |

如果你的仓库里有多个 unit（比如上面例子里再加一个 `bar/terragrunt.hcl`），在 `live-demo` 根目录跑 `terragrunt run --all apply`，Terragrunt 会把 `foo` 和 `bar` 都跑一遍——如果它们之间有 `dependency` 声明依赖关系，还会自动按正确顺序执行。

---

这个例子只有一个 unit，还没有体现出 Terragrunt 真正的价值——它是在"有很多个 unit、彼此有共享配置、有依赖关系"的时候才开始发挥作用的。下一篇开始看 Gruntwork 官方的 Infrastructure-Catalog 范式，看看可复用的基础设施模式该怎么组织。
