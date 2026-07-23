---
title: Terragrunt Stacks 尝鲜，以及仓库里两个从来没被引用的配置文件
date: 2026-07-25 09:30:00
tags: [terragrunt, terraform, iac, oci, oke]
categories: Devops
description: '从 Gruntwork 的 stacks-example 出发，介绍 terragrunt.stack.hcl 能解决什么问题，并顺手揪出我们仓库里 account.hcl / region.hcl 两个从未被 include 过的孤儿文件。'
---

系列前三篇分别讲了 Terragrunt 的基本理念、三层 `include` 结构、模块要不要拆成独立 catalog。这一篇聊 Terragrunt 相对比较新的一个特性——Stacks，以及在核实它到底解决什么问题的过程中，顺手在自己仓库里挖出的一个小发现。

---

## 1. 传统 `dependency` 写法的隐藏成本

我们目前的 `oke-*` 和 `vcn-*` 是分开的顶层目录，彼此之间没有显式声明依赖——`oke-prod-us-ashburn-2` 复用哪个 VCN，是靠环境级 `terragrunt.hcl` 里手填一个现成的 `vcn_id` 做到的：

```hcl
locals {
  vcn_id = "ocid1.vcn.oc1.iad.aaaaaaaa..." # prod-us-ashburn
}
```

这在今天够用，因为 VCN 是提前手动规划好、很少变的资源。但如果哪天想让 Terragrunt 真正理解"这个 OKE 集群依赖那个 VCN 的输出"，就得用 `dependency` 块：

```hcl
dependency "vcn" {
  config_path = "../../vcn-prod-us-ashburn"
}

inputs = {
  vcn_id = dependency.vcn.outputs.vcn_id
}
```

问题在于 `config_path` 是手写的相对路径。目录一旦挪动（哪怕只是改个名字），所有引用它的 `dependency` 块都要跟着改，而且没有编译期检查，改漏了只会在 `plan` 时报错。环境数量一多，这类相对路径会越写越长、越写越脆弱。

## 2. Stacks 想解决什么

Gruntwork 的 [terragrunt-infrastructure-live-stacks-example](https://github.com/gruntwork-io/terragrunt-infrastructure-live-stacks-example) 引入了 `terragrunt.stack.hcl`，用 `unit` 块声明一组要一起管理的资源。比如它的 `stateful-lambda-service` 这个 stack，里面声明了三个 unit（Lambda 函数、DynamoDB 表、IAM 角色），其中 `lambda_service` 这个 unit 长这样（贴的是简化后的版本）：

```hcl
unit "lambda_service" {
  source = "github.com/xxx/terragrunt-infrastructure-catalog//units/js-lambda-stateful-service"
  path   = "service"

  values = {
    name       = local.name
    runtime    = "nodejs22.x"
    source_dir = "./src"
    handler    = "index.handler"
  }

  autoinclude {
    dependency "role" {
      config_path = unit.role.path
      mock_outputs = {
        arn = "arn:aws:iam::123456789012:role/lambda-iam-role-to-dynamodb"
      }
    }
    dependency "dynamodb_table" {
      config_path = unit.db.path
      mock_outputs = { name = "dynamodb-table" }
    }
  }
}
```

两个关键机制：

- **`values` 属性**：这里写的每一项，在 `js-lambda-stateful-service` 这个 unit 自己的 `terragrunt.hcl` 里，直接以 `values.name`、`values.runtime` 这样的写法读取——不是我们熟悉的 `include` + `inputs` 合并，而是 Stacks 专用的一条独立通道，由 stack 文件把配置"喂"给它编排的 unit。
- **`autoinclude` 块里的 `dependency`**：`config_path = unit.role.path` 直接引用同一个 stack 文件里另一个 unit（`role`）的路径，不用手算相对路径——`role`/`db` 这两个 unit 挪了目录，`unit.role.path`/`unit.db.path` 会自动跟着变。这是 "stack dependencies" 特性，Terragrunt **v1.1.0 及以上默认开启**，版本更早的话用不了这个写法。

它推荐的目录层级是 account → region → resource 三层，比如：

```
non-prod/
  └ us-east-1/
      └ stateful-lambda-service/
prod/
  └ us-east-1/
      └ stateful-lambda-service/
```

这套层级天然对齐云账号和 region 的边界，方便按账号做鉴权隔离、按 region 做爆炸半径隔离。

## 3. 一个意外的发现：两个孤儿配置文件

在核实"account/region 分层"这部分的时候，翻了一遍仓库，发现我们其实已经有对应的文件：

```
accounts/default/account.hcl     # tenancy_id、compartment_id
regions/us-ashburn-1/region.hcl  # region、availability_domains
```

内容看起来就是为账号级、区域级共享配置准备的。但是全仓库 `grep -rn "region.hcl\|account.hcl"` 搜下来，除了这两个文件自己，没有任何一处 `include` 或 `find_in_parent_folders` 引用它们：

```bash
$ grep -rn "region.hcl\|account.hcl" --include="*.hcl"
# 只匹配到 account.hcl / region.hcl 自身，没有任何 include 语句引用
```

也就是说，这两个文件是彻底的孤儿——写好了，但从来没接进任何 `include` 链。对照着看，`oke/terragrunt.hcl` 里实际用的是这样一段：

```hcl
locals {
  tenancy_id     = get_env("TF_VAR_tenancy_id", "ocid1.tenancy.oc1..aaaa...")
  compartment_id = get_env("TF_VAR_compartment_id", "ocid1.tenancy.oc1..aaaa...")
}
```

跟 `account.hcl` 里的 `tenancy_id`/`compartment_id` 是同样的值，但走的是完全独立的一份 `get_env()` 定义，两边并没有真正共享。合理的猜测是：当初规划过完整的 account → region → env 三层分层，写了 `account.hcl`/`region.hcl` 起了个头，但后来觉得当时环境数量还不需要这么重的结构，就在项目级 `terragrunt.hcl` 里直接用 `get_env()` 兜底把值写死了，两个文件留在原地没人再动过。

## 4. 怎么处理这两个文件

两个选项：

- **选项 A：删掉。** 目前 7 个左右的 `oke-*`/`vcn-*` 环境都在同一个 tenancy 下，`get_env()` 兜底默认值这种做法足够用，强行套账号/区域分层反而多一层抽象。
- **选项 B：真正接进配置读取链。** 注意这里不适合用 `include`——`include` 块是用来合并一份完整 Terragrunt 单元配置（`inputs`/`generate`/`remote_state` 等）的，而 `account.hcl`/`region.hcl` 只是"一堆共享 locals 的容器"，并不是一个独立的 unit。stacks-example 自己 `root.hcl` 里的实际写法是用 `read_terragrunt_config()` 单独读出来，取需要的字段：

```hcl
locals {
  account_vars = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  region_vars  = read_terragrunt_config(find_in_parent_folders("region.hcl"))

  tenancy_id = local.account_vars.locals.tenancy_id
  region     = local.region_vars.locals.region
}
```

  照这个模式，在 `oke/terragrunt.hcl` 里把重复定义的 `tenancy_id`/`compartment_id`/`region` 换成从 `account.hcl`/`region.hcl` 读取，让"文件存在"和"文件被用到"对上号。

倾向选 B——这一步成本很低，只是把已经写好、内容也没错的值真正接进去，不需要等到决定"要不要上 Stacks"才顺带做。留着两个看起来在用、实际没用的配置文件，对后面接手的人（包括未来的自己）是个陷阱：以为改 `account.hcl` 就能生效，改了半天却发现哪个环境都没变化。

## 5. Stacks 现在值不值得上

结论偏保守：暂时不引入。

现在的环境数量（`oke-*` 六七个、`vcn-*` 五六个）和依赖复杂度还没到位——真正的资源依赖目前都是靠提前规划好的固定 CIDR/OCID 手动避免冲突，而不是需要 Terragrunt 帮忙解析的动态依赖图；手写相对路径的成本目前也还可控。Stacks 相对来说还是一个较新的、仍在快速演进的特性，贸然引入的复杂度收益比现阶段并不划算。

真正该重新评估的信号是：①环境之间出现了必须靠 `dependency` 显式声明的真实资源依赖（不再是手填现成 ID 就能应付）；②需要支撑多 tenancy（多账号）场景，account/region 分层从"锦上添花"变成刚需。到了那个时候，`accounts/`、`regions/` 这两个目录（如果选项 B 先把它们接进了 include 链）反而是现成的起点，不用从零开始规划。

---

四篇写完，回头看这套 Terragrunt 用法的脉络其实很清晰：先搞懂 module/unit/stack 这几个概念解决"为什么需要它"，三层 `include` 解决配置重复的问题，本地相对路径模块解决"够用就好"的复用问题，Stacks 和 account/region 分层则是留给"环境规模再上一个台阶"时候的选项——按需引入，而不是一上来就照抄最复杂的那套模板。
