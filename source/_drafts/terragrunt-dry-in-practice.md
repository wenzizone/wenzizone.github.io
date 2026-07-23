---
title: Terragrunt 三层 include：我们是怎么在 OKE 的 Terraform 配置里做到 DRY 的
date: 2026-07-23 16:20:00
tags: [terragrunt, terraform, iac, oci, oke]
categories: Devops
description: '以实际的 OKE Terraform 仓库为例，讲清楚 Terragrunt 的 root / 项目级 / 环境级三层 include 结构，以及 inputs 合并、generate、remote_state 这几个核心机制。'
---

上一篇讲了 Terragrunt 要解决的问题和 module/unit/stack 这几个术语，用的是一个本地空跑的最小例子。这一篇换成真实场景：我们在 OCI 上维护了七八个 OKE 集群（`oke-prod-us-ashburn`、`oke-prod-us-ashburn-2`、`oke-prod-ap-singapore-1`、`oke-qa-us-ashburn`、`oke-test-us-ashburn`……），每个集群一份独立的 unit / state，但 backend 配置、provider 设置、一大半集群参数的默认值都是一模一样的。如果用纯 Terraform，这意味着每个环境目录下都得抄一份 `backend.tf`、一份 `provider.tf`，改一个默认值要在 N 个目录里重复改 N 遍——这篇记录我们实际用的三层 include 结构，以及背后几个容易忽略的机制。

对应到我们的仓库，`oke/oke-prod-us-ashburn-2/` 就是一个 unit。目前我们仓库里"stack"这一层还只是靠目录组织隐式表达的（一个环境 = 一个 `oke-xxx` 目录 + 对应的 `vcn-xxx` 目录），并没有用到 Terragrunt 官方的 Stacks 语法——这个放到系列第四篇再展开。

---

## 1. 三层目录结构总览

先看整体骨架：

```
Terraform/
├── root.hcl                       # 全局唯一：backend + remote_state
├── oke/
│   ├── terragrunt.hcl             # 项目级：OKE 所有环境共享的默认值
│   ├── modules/
│   │   └── oke-cluster/           # 实际 Terraform 模块代码
│   ├── oke-prod-us-ashburn-2/
│   │   └── terragrunt.hcl         # 环境级：这个集群独有的配置
│   ├── oke-test-us-ashburn/
│   │   └── terragrunt.hcl
│   └── ...（其余五个环境同构）
```

三层分别对应：**仓库级**（唯一一份）、**产品线级**（`oke/` 这一整条产品线共享）、**环境级**（每个集群自己的差异）。下面按层拆开讲。

## 2. 第一层：`root.hcl`，只管 backend 和版本

`root.hcl` 放在仓库根目录，靠 `generate` 块生成 `backend.tf`/`versions.tf`，并声明 `remote_state`：

```hcl
remote_state {
  backend = "s3"
  config = {
    bucket = "devops-terraform-stats"
    key    = "infra/${path_relative_to_include()}/terraform.tfstate"
    region = "us-ashburn-1"
    endpoints = {
      s3 = "https://<namespace>.compat.objectstorage.us-ashburn-1.oraclecloud.com"
    }
    skip_region_validation      = true
    skip_credentials_validation = true
    ...
  }
}
```

这里最值得注意的是 `key` 里的 `path_relative_to_include()`：它会自动算出当前 unit 相对于 `root.hcl` 所在目录的路径，拼成 state 的 key。也就是说，`oke-prod-us-ashburn-2` 这个 state 的 key 会自动变成 `infra/oke/oke-prod-us-ashburn-2/terraform.tfstate`，完全不需要在每个环境的 `terragrunt.hcl` 里手写 key——新增一个环境目录，state 路径自动就位，不会因为手滑漏改 key 而导致两个环境共用同一份 state。

每个 unit 找 `root.hcl` 的方式是：

```hcl
include "root" {
  path = find_in_parent_folders("root.hcl")
}
```

`find_in_parent_folders()` 会从当前目录一路往上找，直到找到 `root.hcl` 为止——因为它是全仓库唯一的一份，"往上找"永远不会找错。

## 3. 第二层：`oke/terragrunt.hcl`，产品线级默认值

这一层定义的是"一个 OKE 集群默认长什么样"：

```hcl
locals {
  cluster_type       = "enhanced"
  kubernetes_version = "v1.34.2"
  cni_type           = "npn"          # 默认使用 OCI 原生 VCN 网络
  create_karpenter_iam = false

  cluster_addons = {
    "CertManager"             = {},
    "KubernetesMetricsServer" = {},
  }
}

inputs = {
  cluster_type       = local.cluster_type
  kubernetes_version = local.kubernetes_version
  cni_type           = local.cni_type
  cluster_addons     = local.cluster_addons
  ...
}
```

同时它还用 `generate` 块生成了两份跟 OKE 强相关、但环境之间完全不需要差异化的文件——provider 版本约束和 provider 本身（OKE 有些资源要用 home region 的 client，所以这里声明了两个 `oci` provider，其中一个带 `alias = "home"`）：

```hcl
generate "provider" {
  path      = "provider.tf"
  if_exists = "overwrite_terragrunt"
  contents  = <<EOF
provider "oci" {
  auth                = "APIKey"
  config_file_profile = "DEFAULT"
  region              = var.region
}

provider "oci" {
  auth                = "APIKey"
  config_file_profile = "DEFAULT"
  region              = var.home_region
  alias               = "home"
}
EOF
}
```

有个细节容易被问到：为什么找 `root.hcl` 用 `find_in_parent_folders()`，找项目级配置却用写死的相对路径 `../terragrunt.hcl`？

```hcl
include "project" {
  path = "../terragrunt.hcl"
}
```

因为 `root.hcl` 是全仓库唯一的、任何产品线都该继承同一份，"往上找"永远安全；而项目级配置是**跟着产品线走**的——仓库里除了 `oke/` 还有 `vcn/`、`kafka_cluster/` 等其他产品线，各自都有一份 `terragrunt.hcl`。如果项目级 include 也用 `find_in_parent_folders("terragrunt.hcl")`，一旦目录嵌套关系变化，很可能悄悄找到别的产品线的配置文件而不自知。写死相对路径虽然"不够 DRY"，但换来的是明确、可预期。

## 4. 第三层：环境级 `terragrunt.hcl`，只写差异

到了具体某个环境，比如 `oke-prod-us-ashburn-2`，`terragrunt.hcl` 里只需要写这个集群和别人不一样的地方：

```hcl
include "root" {
  path = find_in_parent_folders("root.hcl")
}
include "project" {
  path = "../terragrunt.hcl"
}

locals {
  environment = "prod"
  name        = "prod-us-ashburn-2"

  # 覆盖项目级默认的 cni_type = "npn"
  cni_type          = "flannel"
  pod_subnet_create = false
}

inputs = {
  environment       = local.environment
  name              = local.name
  cni_type          = local.cni_type
  pod_subnet_create = local.pod_subnet_create
  ...
}

terraform {
  source = "../modules//oke-cluster"
}
```

`inputs` 的合并规则很直接：多层 include 进来的 `inputs` 会按"根 → 项目 → 环境"的顺序合并，**同名 key 由更靠下的一层覆盖**。上面例子里 `cni_type` 在项目级默认是 `npn`（OCI 原生 VCN 网络），到了这个环境被显式覆盖成 `flannel`（因为这个集群复用了另一个集群已经存在的 VCN，走的是 overlay 网络）。要注意这个覆盖是整体替换，不是逐字段的深度合并——比如 `worker_pools` 这种 map，环境级只要声明了，就是完整替换掉项目级的同名值（如果项目级根本没声明 `worker_pools`，那就是环境级独有）。

`terraform.source = "../modules//oke-cluster"` 里的双斜杠也值得解释一下：双斜杠**之前**的部分（`../modules`）是 Terragrunt 会整体处理（本地路径直接引用，远程 source 则会整体拉取/拷贝到 `.terragrunt-cache`）的范围，双斜杠**之后**的部分（`oke-cluster`）才是真正要 apply 的子目录。这个写法和引用远程 git 仓库时的 `git::https://xxx//modules/foo` 语法是一致的——这也是我们下一篇要聊的话题：这份模块代码目前就放在同一个仓库里、用本地相对路径引用，完全没有版本化，这在什么情况下该改、又该怎么改。

---

这套三层结构跑了小半年，日常改配置、加环境都很顺手。但它也留了两个没解决的问题：一是模块代码和使用它的六七个环境挤在同一个仓库里、靠相对路径引用，没有任何版本隔离；二是"stack"这层目前纯粹靠目录命名约定表达，环境一多，配置会越来越分散。这两个问题分别对应 Terragrunt 生态里的 catalog 模式和 Stacks 特性，是系列第三、四篇的主题。
