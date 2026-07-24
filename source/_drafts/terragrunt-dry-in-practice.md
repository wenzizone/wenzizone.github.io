---
title: Terragrunt 三层 include：我们是怎么在 OKE 的 Terraform 配置里做到 DRY 的
date: 2026-07-26 09:00:00
tags: [terragrunt, terraform, iac, oci, oke]
categories: Devops
description: '系列收尾：用我们实际的 OKE Terraform 仓库作为案例，讲三层 include 结构怎么搭，再回头看 Infrastructure-Catalog 和 Stacks 这两套官方模式，套到我们这个规模不大的仓库上能用上几分。'
---

前面两篇分别照着 Gruntwork 官方的两个示例仓库，讲了 Infrastructure-Catalog（可复用模式怎么组织、怎么版本化）和 Infrastructure-Live + Stacks（account/region 分层、自动依赖解析）。这两套东西看着都很完整，但官方仓库里的例子终究是 Lambda、DynamoDB 这类抽象场景。这一篇是系列最后一篇，回到我们自己真实维护的 OCI OKE Terraform 仓库——先讲我们实际搭的三层 `include` 结构，再回头看前两篇讲的那些官方模式，套到我们这个规模不大的仓库上，能用上几分、哪些暂时还用不上。

我们在 OCI 上运营着好几个 OKE 集群，但目前只有 `oke-prod-us-ashburn-2` 这一个环境真正接入了 Terragrunt。这套三层 include 结构是照着"以后要扩展到更多环境"的预期搭的——backend 配置、provider 设置这些跟具体环境无关的东西，从一开始就不该跟这一个环境的目录绑死，不然真到了要加第二个环境的那天，还是得把这些配置从头抄一遍。

对应到我们的仓库，`oke/oke-prod-us-ashburn-2/` 是目前唯一真正在跑的一个 unit。`oke/` 目录下还留着一份 `oke-test-us-ashburn/terragrunt.hcl`，但还没有真正接入使用；其余几个 OKE 环境目前也都还没用上 Terragrunt，是纯 Terraform 直接引用 `oracle-terraform-modules/oke/oci` 这个 registry 模块，跟我们自己抽象出来的 `oke-cluster` 模块没有关系。

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
│   │   └── terragrunt.hcl         # 环境级：唯一真正在用的环境
│   ├── oke-test-us-ashburn/
│   │   └── terragrunt.hcl         # 写好了，还没真正接入使用
│   └── ...（其余环境目前还没用上 Terragrunt）
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

`terraform.source = "../modules//oke-cluster"` 里的双斜杠也值得解释一下：双斜杠**之前**的部分（`../modules`）是 Terragrunt 会整体处理（本地路径直接引用，远程 source 则会整体拉取/拷贝到 `.terragrunt-cache`）的范围，双斜杠**之后**的部分（`oke-cluster`）才是真正要 apply 的子目录。这个写法和引用远程 git 仓库时的 `git::https://xxx//modules/foo` 语法是一致的。

---

## 5. 回头看 Catalog 模式：我们用得上吗

`oke/modules/oke-cluster/main.tf` 内部其实已经在做模块组合，而且已经是版本化的：

```hcl
module "oke" {
  source  = "oracle-terraform-modules/oke/oci"
  ...
}

module "karpenter_iam" {
  source = "../oke-karpenter-iam"
  ...
}
```

`oracle-terraform-modules/oke/oci` 来自 Terraform Registry，天然带版本号；真正没有版本化的是本地那个 `../oke-karpenter-iam`。但更关键的是 **Terragrunt unit 层**——目前只有 `oke-prod-us-ashburn-2` 这一个环境引用 `oke-cluster`：

```hcl
terraform {
  source = "../modules//oke-cluster"
}
```

前两篇讲的"改一次全部环境都跟着变"这个 catalog 模式要解决的风险，在我们这里其实还没真正出现——因为压根只有一个消费者。硬要现在就把 `oke-cluster` 拆成独立 catalog 仓库、走 `git::...?ref=` 版本化引用，属于给一个还不存在的问题提前买保险。

真正会触发这个决策的信号，得是下面几件事之一：**改模块的人和用模块的人不再是同一拨人**、**需要给不同环境锁定不同版本做灰度**（比如新 Kubernetes 版本先在测试环境验证几周再推广到生产），或者**模块要被这个仓库以外的项目复用**。这三条我们目前一条都还没触发，甚至连"多消费者"这个前提都还没成立——`oke-test-us-ashburn` 都还没真正接入这份模块。

如果哪天真要往这个方向走，第一步不是拆仓库，而是先把 `oke-test-us-ashburn` 这类已经写好 `terragrunt.hcl`、只是还没启用的环境接进来，变成第二个消费者；然后可以先给 `oke/modules/oke-cluster` 打个 git tag（比如 `modules/oke-cluster/v1.0.0`），让这个新接入的环境试着用 `git::<repo-url>//oke/modules/oke-cluster?ref=modules/oke-cluster/v1.0.0` 这种带版本的引用，验证 `ref` 版本引用在我们这套 backend/CI 环境下是否顺畅，再决定要不要把模块整体搬到独立仓库。

## 6. 回头看 Stacks 模式：我们用得上吗

我们目前的 `oke-*` 和 `vcn-*` 是分开的顶层目录，彼此之间没有显式声明依赖——`oke-prod-us-ashburn-2` 复用哪个 VCN，是靠环境级 `terragrunt.hcl` 里手填一个现成的 `vcn_id` 做到的：

```hcl
locals {
  vcn_id = "ocid1.vcn.oc1.iad.aaaaaaaa..." # prod-us-ashburn
}
```

这在今天够用，因为 VCN 是提前手动规划好、很少变的资源。上一篇讲的 Stacks 用 `autoinclude` + `dependency` + `unit.x.path` 自动解析依赖路径，解决的是"目录一挪、所有 `dependency` 块都要跟着改"这个问题——但我们现在压根没有用 `dependency` 块去声明过任何跨目录依赖，谈不上这个痛点。

倒是核实这一块的时候，发现了一个真实的小问题：仓库里有 `accounts/default/account.hcl` 和 `regions/us-ashburn-1/region.hcl` 两个文件，内容分别是 `tenancy_id`/`compartment_id` 和 `region`/可用域，看起来是为账号级、区域级共享配置准备的。但全仓库搜下来，没有任何一处引用它们——`oke/terragrunt.hcl` 里实际是用 `get_env()` 独立定义了一遍同样的值：

```hcl
locals {
  tenancy_id     = get_env("TF_VAR_tenancy_id", "ocid1.tenancy.oc1..aaaa...")
  compartment_id = get_env("TF_VAR_compartment_id", "ocid1.tenancy.oc1..aaaa...")
}
```

这两个文件是彻底的孤儿——写好了，但从来没接进过任何配置读取链。合理的猜测是：当初规划过完整的 account/region 分层，起了个头，后来发现当时环境数量还不需要这么重的结构，就用 `get_env()` 兜底写死了，两个文件留在原地没人再动过。

前一篇 stacks-example 的 `root.hcl` 演示了正确的读法，用的是 `read_terragrunt_config()`，不是 `include`（`include` 是合并一份完整单元配置的，`account.hcl`/`region.hcl` 只是共享 locals 的容器）：

```hcl
locals {
  account_vars = read_terragrunt_config(find_in_parent_folders("account.hcl"))
  tenancy_id   = local.account_vars.locals.tenancy_id
}
```

处理这两个孤儿文件有两个选项：直接删掉（目前环境规模还不需要账号/区域分层，`get_env()` 兜底够用），或者照着上面的写法把它们真正接进 `oke/terragrunt.hcl`，让"文件存在"和"文件被用到"对上号。后者成本很低，不需要等到真正决定"要不要上 Stacks"才顺带做——留着两个看起来在用、实际没用的配置文件，对后面接手的人是个陷阱。

至于 Stacks 本身值不值得现在引入：现在真正接入 Terragrunt 的环境只有 `oke-prod-us-ashburn-2` 一个，其余环境都还是纯 Terraform——依赖复杂度远没有到位，真正的资源依赖目前都是靠提前规划好的固定 CIDR/OCID 手动避免冲突，谈不上需要 Terragrunt 帮忙解析依赖图。Stacks 相对来说还是一个较新的、仍在快速演进的特性，现在引入的复杂度收益比并不划算。真正该重新评估的信号是：环境之间出现了必须靠 `dependency` 显式声明的真实资源依赖，或者需要支撑多 tenancy 场景——到那时候，`accounts/`、`regions/` 这两个目录（如果先把它们接进了配置读取链）反而是现成的起点。

---

四篇写完，回头看这套 Terragrunt 用法的脉络：先搞懂 module/unit/stack 这几个概念（第一篇），再看官方推荐的两套进阶模式——Infrastructure-Catalog 怎么组织可复用代码（第二篇）、Infrastructure-Live + Stacks 怎么管理依赖和账号分层（第三篇）——最后套回我们自己规模不大、目前只有一个环境真正落地的 OKE 仓库，诚实地承认哪些还用不上、哪些是提前埋好的坑（第四篇）。按需引入，而不是一上来就照抄最复杂的那套模板，是这整个系列想表达的态度。
