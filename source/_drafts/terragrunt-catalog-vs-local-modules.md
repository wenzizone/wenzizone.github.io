---
title: 模块要不要拆成独立的 Catalog 仓库？
date: 2026-07-24 09:30:00
tags: [terragrunt, terraform, iac, oci, oke]
categories: Devops
description: '结合 Gruntwork 的 infrastructure-catalog 范式，分析我们 OKE Terraform 模块目前"本地相对路径 + 同仓库"的复用方式，以及什么信号出现才值得升级成独立仓库 + git ref 版本化。'
---

上一篇讲了我们的三层 `include` 结构，其中提到一句话没展开：`terraform.source = "../modules//oke-cluster"` 是本地相对路径，模块代码和使用它的六七个环境挤在同一个仓库里，没有任何版本隔离。这篇就聊这一件事：这样到底行不行，什么时候该改。

---

## 1. 现状：两个不同层次的"复用"

先把现状说清楚，容易被混在一起的是两个不同层次的复用。

**Terraform module 层**，`oke/modules/oke-cluster/main.tf` 内部其实已经在做模块组合，而且已经是版本化的：

```hcl
module "naming" {
  source  = "cloudposse/label/null"
  ...
}

module "oke" {
  source  = "oracle-terraform-modules/oke/oci"
  ...
}

module "karpenter_iam" {
  source = "../oke-karpenter-iam"
  ...
}
```

`cloudposse/label/null` 和 `oracle-terraform-modules/oke/oci` 都来自 Terraform Registry，天然带版本号（可以在 `source` 后面加 `version` 约束），升级、锁版本都是现成的机制。真正没有版本化的是本地那个 `../oke-karpenter-iam`——它和 `oke-cluster` 本身一样，都只是仓库里的相对路径。

**Terragrunt unit 层**，六七个 `oke-*` 环境全部这样引用：

```hcl
terraform {
  source = "../modules//oke-cluster"
}
```

也就是说，只要改一次 `oke/modules/oke-cluster`，下一次任何环境 `plan`，看到的都是同一份新代码——没有环境可以"暂时不升级"，也没有办法只给某一个环境试运行新版本。

## 2. Gruntwork 的 catalog 模式

Gruntwork 的 [terragrunt-infrastructure-catalog-example](https://github.com/gruntwork-io/terragrunt-infrastructure-catalog-example) 提供了另一种做法：把可复用的基础设施模式放进一个独立的 catalog 仓库，内部再分三层——

- `modules/`：最底层的 OpenTofu/Terraform 代码（比如一个 ASG、一个 RDS）；
- `units/`：给模块包一层 Terragrunt 配置（业务逻辑、依赖声明）；
- `stacks/`：把多个 units 编排成一套完整方案。

而消费方（"live" 仓库）不再用相对路径，是这样引用的：

```hcl
terraform {
  source = "git::git@github.com:acme/terragrunt-infrastructure-catalog//units/lambda-service?ref=v1.0.0"
}
```

`ref` 参数锁死一个具体的 git 版本（tag 或 commit），不同 live 仓库、甚至同一个仓库里的不同环境，都可以按自己的节奏引用不同版本——这正是本地相对路径给不了的东西。

值得一提的是，真要建一个 catalog 仓库并不需要一上来就手写所有引用路径。Terragrunt 自带两个命令，专门用来"试用"一个 catalog：

```bash
# 在 root.hcl 里配置好 catalog { urls = [...] } 之后
mkdir -p live/non-prod/us-east-1/my-lambda-service
cd live/non-prod/us-east-1/my-lambda-service
terragrunt catalog
```

`terragrunt catalog` 会弹出一个终端交互界面，列出这个 catalog 仓库里所有能用的组件，选中后按 `S` 就能直接把对应的 `terragrunt.hcl` 脚手架生成到当前目录。如果已经知道要哪个组件，`terragrunt scaffold` 可以跳过交互界面直接生成：

```bash
terragrunt scaffold git::git@github.com:acme/terragrunt-infrastructure-catalog//modules/lambda-service
```

这两个命令的意义在于：评估"要不要建 catalog"这件事本身成本很低——不需要先把仓库结构定死，可以先建一个只有几个 module 的 catalog 仓库，本地 `terragrunt catalog` 试跑一下引用体验，觉得顺手了再逐步往里面搬东西。

## 3. 两种方式怎么选

| | 本地相对路径（我们现在的做法） | 独立 catalog + git ref |
|---|---|---|
| 改动生效范围 | 立即影响全部 6~7 个环境 | 按环境各自锁定版本，可以灰度 |
| PR 原子性 | 模块改动和环境改动能在一个 PR 里一起审 | 拆成两个仓库两次提交，审查链路更长 |
| 回滚成本 | revert 一次 commit，全部环境一起回滚 | 改回旧的 `ref` 版本号，单环境可单独回滚 |
| 适合的团队规模 | 个人 / 小团队，变更节奏统一、能互相知会 | 多团队共用同一套模块，需要独立发布节奏和审批 |

我们目前的场景更接近左边一栏：改 `oke-cluster` 的人和用它的人是同一拨人，六七个环境的变更也基本是连续几天内一起推完的，没有出现"这个环境这周不能动、那个环境急着升级"的情况。硬要现在拆出独立仓库，多出来的版本管理成本大概率比它解决的问题更麻烦。

这本质上是"单仓库（monorepo）vs 多仓库（polyrepo）"的取舍，catalog-example 仓库自己的文档里就有一段很中肯的对比，值得搬过来对照我们的场景：

单仓库（我们现在的 `oke/modules` + 六七个环境同仓库）的优势——**全局改动更容易**（一次严重安全漏洞修复或统一升级 Terraform 版本，一个 commit 就能覆盖所有环境）、**搜索方便**（不用切多个仓库就能全文搜到所有模块代码）、**CI 简单**（所有代码一起测试、一起验证，不会出现"模块新版本发布了但没人知道"这种滞后集成问题）。

多仓库（独立 catalog + git ref）的优势——**变更隔离更彻底**（改 A 模块不用担心影响 B 模块）、**每个仓库的测试更快更独立**、**每次发布对应的改动范围更清晰**。但代价是**全局改动变麻烦**（一次跨模块的改动要开好几个仓库的 PR）、**没有依赖管理机制**（容易遇到"钻石依赖"式的版本冲突）、**初始化更慢**（每个仓库的依赖都要独立拉取一遍）。

这组权衡没有标准答案，取决于团队规模和变更节奏，不是"多仓库天然更先进"。

## 4. 什么信号出现才真正该拆

不是"环境多"本身就该拆，而是下面几件事真的发生了才值得：

1. **改模块的人和用模块的人分开了**——比如平台组维护 `oke-cluster`，业务组各自决定什么时候升级，双方节奏不一致；
2. **需要按环境锁定不同版本做灰度**——比如新 Kubernetes 版本先在 `oke-test-us-ashburn`/`oke-qa-us-ashburn` 验证几周，确认没问题才推广到 `prod-us-ashburn` 系列，而不是所有环境永远用同一份代码的最新状态；
3. **模块要被这个仓库以外的项目复用**——比如新起一条产品线也要建 OKE 集群，且维护者不是同一批人。

这三条我们目前一条都还没真正触发。

## 5. 如果要走，一个成本更低的中间态

如果哪天真的开始靠近上面这些信号，不需要一步到位把整个仓库拆开，可以先只给 `oke/modules/oke-cluster` 打 git tag（比如 `modules/oke-cluster/v1.0.0`），让改动节奏最独立的那一两个环境（比如线上最敏感的 `oke-prod-us-ashburn`）先试着改成：

```hcl
terraform {
  source = "git::<repo-url>//oke/modules/oke-cluster?ref=modules/oke-cluster/v1.0.0"
}
```

先验证 `ref` 版本引用在我们这套 backend/CI 环境下是否顺畅（比如私有仓库鉴权、`.terragrunt-cache` 缓存刷新逻辑），再决定要不要把模块整体搬到独立仓库、给其余环境也切过去。这样即使中途发现不划算，回退成本也很低——改回本地相对路径就行，不涉及拆仓库这种大动作。

---

即便不拆分仓库，环境数量本身继续增多，还会带来另一种复杂度：环境之间如果真的存在资源依赖（不只是配置继承），传统 `dependency` 块要手写相对路径，模块一挪目录，所有引用者都得跟着改。这正是 Terragrunt Stacks 想解决的问题，也是下一篇的主题——顺带还会聊到我们仓库里两个一直没被用上的配置文件。
