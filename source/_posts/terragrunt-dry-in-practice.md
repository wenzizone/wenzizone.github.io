---
title: Terragrunt 三层 include：我们是怎么在 OKE 的 Terraform 配置里做到 DRY 的
date: 2026-08-22 09:00:00
tags: [terragrunt, terraform, iac, oci, oke]
categories: Devops
cover: /images/terragrunt/terragrunt-dry-in-practice.png
description: '系列收尾：用我们实际的 OKE Terraform 仓库作为案例，讲三层 include 结构怎么搭。原本这篇打算写"官方的 Catalog/Stacks 模式我们暂时用不上"，写到一半发现这几个月我们真的把这两套东西用起来了——这篇改成记录真实踩过的坑。'
---

前面两篇分别照着 Gruntwork 官方的两个示例仓库，讲了 Infrastructure-Catalog（可复用模式怎么组织、怎么版本化）和 Infrastructure-Live + Stacks（account/region 分层、自动依赖解析）。这一篇本来的计划是：回到我们自己真实维护的 OCI OKE Terraform 仓库，诚实地承认这两套模式对我们这个规模不大的仓库"暂时用不上"。

![从"以为用不上"到真的用上了——一次真实的 Terragrunt Catalog + Stacks 迁移](/images/terragrunt/terragrunt-dry-in-practice.png)

草稿写到一半，我们真的把 Terraform 仓库做了一轮重构——不是为了写这篇文章去凑素材，是业务上确实需要（新集群、新的对等网络越来越多，重复配置的维护成本已经真实地疼了）。所以这一篇的后半段整个重写了：先讲我们最初、也是现在仍在用的三层 `include` 结构，再回头看 Catalog 和 Stacks 这两套官方模式——这次不是"套上去看合不合适"，是真实用出来之后，踩过的坑和官方例子完全不一样。

## 起点：只有一个环境接入 Terragrunt 的时候

写前两篇的时候，我们在 OCI 上运营着好几个 OKE 集群，但只有 `oke-prod-us-ashburn-2` 这一个环境真正接入了 Terragrunt，其余环境是纯 Terraform 直接引用 `oracle-terraform-modules/oke/oci` 这个 registry 模块。这套三层 include 结构是照着"以后要扩展到更多环境"的预期搭的——backend 配置、provider 设置这些跟具体环境无关的东西，从一开始就不该跟这一个环境的目录绑死。

这一层结构到今天都没变，先讲清楚它，后面 Catalog/Stacks 的实战踩坑才有地方"挂"。

---

## 1. 三层目录结构总览（外加新长出来的一层）

先看最初、也是今天仍然存在的骨架：

```
Terraform/
├── root.hcl                       # 全局唯一：backend + remote_state
├── oke/
│   ├── terragrunt.hcl             # 项目级：OKE 所有环境共享的默认值
│   ├── oke-prod-us-ashburn-2/
│   │   └── terragrunt.hcl         # 环境级：老式单 unit 写法
│   ├── oke-test-us-ashburn/
│   ├── oke-prod-us-ashburn/       # 这几个目前仍是纯 Terraform
│   ├── oke-qa-us-ashburn/
│   ├── oke-ops-us-ashburn/
│   └── oke-prod-ap-singapore-2-1/
```

这套结构描述的是"老式单 unit"环境该怎么组织——一个环境一个 `terragrunt.hcl`，三层 include 负责把 backend、项目默认值、环境差异拼起来。下面第 2~4 节讲的就是这套机制。

但仓库里现在多了一层东西，是这几个月真实长出来的：

```
Terraform/
├── catalog/
│   ├── modules/        # 可复用 Terraform 模块（oke-cluster、vcn、drg...）
│   └── units/
│       ├── oke/         # OKE 的 unit 模板
│       ├── vcn/         # VCN 的 unit 模板
│       └── drg/         # DRG 的 unit 模板
├── live/
│   ├── oke/terragrunt.hcl
│   │   └── oke-prod-ap-singapore-1-1/terragrunt.stack.hcl
│   ├── vcn/terragrunt.hcl
│   │   └── vcn-prod-ap-singapore-1-1/terragrunt.stack.hcl
│   └── drg/terragrunt.hcl
│       ├── drg-ap-singapore-1/terragrunt.stack.hcl
│       └── drg-ap-singapore-2/terragrunt.stack.hcl
```

也就是说，现在仓库里是**两套写法并存**：老集群继续用第 2~4 节的三层 include 单 unit 写法；新集群（以及正在被迁移的老集群）用 `catalog/` + `live/` + `terragrunt.stack.hcl` 这套新写法。第 5、6 节讲这套新写法怎么来的、踩了什么坑。

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

这里最值得注意的是 `key` 里的 `path_relative_to_include()`：它会自动算出当前 unit 相对于 `root.hcl` 所在目录的路径，拼成 state 的 key。也就是说，`oke-prod-us-ashburn-2` 这个 state 的 key 会自动变成 `infra/oke/oke-prod-us-ashburn-2/terraform.tfstate`，完全不需要在每个环境的 `terragrunt.hcl` 里手写 key。

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

`inputs` 的合并规则很直接：多层 include 进来的 `inputs` 会按"根 → 项目 → 环境"的顺序合并，**同名 key 由更靠下的一层覆盖**，且是整体替换不是深度合并。`terraform.source = "../modules//oke-cluster"` 里的双斜杠：双斜杠**之前**的部分是 Terragrunt 整体处理的范围，双斜杠**之后**才是真正要 apply 的子目录。

这套写法对"一个环境一个 unit"够用。但当我们真的要让好几个新集群共享同一份 `oke-cluster` 模块、还要把 VCN 依赖也接进来的时候，事情变了。

---

## 5. 回头看 Catalog 模式：这次真的用上了，但官方例子没告诉我们的坑

前两篇讲 Gruntwork 的 catalog-example 时，`terraform.source` 用的是干净的双斜杠相对路径，`update_source_with_cas` 一开就完事。我们真正把 OKE 的模块挪成 `catalog/modules/oke-cluster` + `catalog/units/oke/oke-cluster/terragrunt.hcl` 之后，第一版按同样的思路写：

```hcl
# 第一版，看起来很合理，实测是错的
terraform {
  source = "../../../../modules//oke-cluster"
}
```

推理是"unit 模板现在比以前深了一层目录，多补一层 `../` 就行"。`terragrunt stack generate` + `validate` 一跑，直接报错：

```
Downloading Terraform configurations from ../../../modules ...
Working dir oke-cluster from source file:///.../Terraform/oke/modules does not exist
```

**真正的原因**：`terraform.source` 里的相对路径，不是相对于 `catalog/units/oke/oke-cluster/terragrunt.hcl` 这个模板文件本身的物理位置解析的，而是相对于 `terragrunt stack generate` 之后、这个模板被**复制到的那个目录**（`<集群目录>/.terragrunt-stack/<unit的path>/`）解析的——跟普通 Terraform module 的 `source` 字段解析规则一样，Terragrunt 并没有对 catalog 模板做"记住原始位置"的特殊处理。

这里要澄清一下：这不是官方文档漏讲，是我们 monorepo 的用法天然会撞上、而官方 polyrepo 拆分方式天然不会撞上的问题。catalog-example 里 `units/xxx/terragrunt.hcl` 的 `terraform.source` 也是写死的相对路径（`../..//modules/xxx`），但它是靠 `source = "github.com/acme/catalog//units/xxx"` 这种**远程 git 引用**被拉进 live 仓库的——Terragrunt 走的是把这个 unit 在 catalog 仓库里所在的那部分目录结构原样取下来，`units/` 到 `modules/` 的相对位置关系在 catalog 仓库内部永远不变，跟哪个 live 仓库来消费它无关。我们是 monorepo，`stack generate` 只是把 `catalog/units/oke/oke-cluster/terragrunt.hcl` 这一份文件复制到消费方集群目录下的 `.terragrunt-stack/<unit的path>/`，**没有把整个 `catalog/` 目录一起挪过去**——复制目标的目录深度是由消费方集群自己的目录结构决定的，跟 `catalog/` 内部原本 `units/` 到 `modules/` 的相对层数没有任何关系。官方"两个仓库、相对路径关系恒定"这个前提，在 monorepo 里被 `stack generate` 只复制单个文件这个行为打破了。

算准了应该是 4 层 `../` 而不是 3 层，问题倒是解决了，但这种"数隔了几层目录"的写法一旦以后 stack 目录结构再变，又要重新数一遍——本质上是在 monorepo 里手动模拟"这两部分永远绑在一起挪动"这个 polyrepo 天然具备的性质，不可能靠数层数长期维持。最后干净的解法是不再数层数，用 `find_in_parent_folders` 定位到仓库根：

```hcl
terraform {
  source = "${dirname(find_in_parent_folders("root.hcl"))}/catalog/modules//oke-cluster"
}
```

这行不随生成目录的深度变化，是我们踩坑后觉得真正该写的样子。

第二个坑跟 `values` 有关。Catalog 模式里 unit 模板靠 stack 文件传进来的 `values`（不是 `inputs`）拿集群特定参数，前两篇也讲过这个机制。但 `values` 这个变量有个限制：**只在 stack 直接指向的那一份 `terragrunt.hcl` 自己的 body 里可见**——如果这份文件再往上 `include` 一层，被 include 进来的那份文件里是看不到 `values` 的。我们一开始想让 `provider.tf` 的生成逻辑通过 `include "project"` 复用项目级配置，结果项目级文件里想按 `values.oci_profile_override` 做覆盖，根本拿不到 `values`。改法是不用 `include`，用 `read_terragrunt_config()` 只读项目级文件的 `inputs`/`locals`（不会触发它的 `generate` 块），自己在 unit 模板里单独定义 `generate "provider"`——这样才不会跟项目文件里同名的 `generate` 块冲突（两边都定义会报 `Detected generate blocks with the same name`）。

第三个坑是怎么把一个**已经 apply 过的老集群**（比如纯 Terraform 时代建的 `oke-prod-ap-singapore-1`）接进这套新结构，又不触发 state 迁移。做法是给 `remote_state` 的 `key` 加一个显式覆盖出口：

```hcl
key = coalesce(try(values.remote_state_key_override, null), "infra/${path_relative_to_include("root")}/terraform.tfstate")
```

新集群不传这个值，走原来自动推导的路径；老集群接入时显式传一个跟迁移前完全一样的 key，这样"目录结构变了"和"state 存在哪"这两件事就彻底脱钩，不会因为换了写法就被迫连带一次高风险的 state 搬迁。

这三个坑的根源其实不一样：第一个（`terraform.source` 数层数）是 monorepo 这种拓扑选择本身带来的，换成官方的 polyrepo 拆分方式就不会存在；第二个（`values` 的可见范围）是 Terragrunt stack 机制本身的限制，跟 mono/polyrepo 无关，只要有 `include` 嵌套 + 想在被 include 的文件里用 `values`，谁都会撞上；第三个（老集群无损接入）是"给已经跑在生产的基础设施引入新模式"这个场景带来的，catalog-example 那种从零开始的 Lambda/DynamoDB 示例压根没有已存在的 state 要保护，自然不会写这段。回头看前两篇的判断标准：**改模块的人和用模块的人是不是同一拨人、要不要按环境锁版本灰度、模块要不要被仓库外复用**——现在多个集群共享 `catalog/modules/oke-cluster` 这个事实已经成立了，是不是要进一步打 tag、走 `git::...?ref=` 版本化引用，倒是可以留到规模再大一点、真的出现"不同集群需要锁不同版本"的需求时再说。

## 6. 回头看 Stacks 模式：依赖关系这次是真的接进来了

前两篇讲 Stacks 的 `autoinclude` + `dependency` + `unit.x.path` 时，示例是 db → role → lambda 这种线性依赖。我们真实的场景是：新建一个 OKE 集群，有时候要顺带建一个全新的 VCN 一起用，有时候是接入一个已经存在、老早就规划好 CIDR 的 VCN——同一个 unit 模板要同时服务这两种情况。

解法是让 `dependency` 块本身变成可选的：

```hcl
dependency "vcn" {
  config_path = try(values.vcn_dependency_path, "not-used")
  enabled     = try(values.vcn_dependency_path, null) != null

  mock_outputs = {
    vcn_id       = null
    ig_route_id  = null
    nat_route_id = null
  }
  mock_outputs_allowed_terraform_commands = ["init", "validate", "plan"]
}
```

再在 `inputs` 里用三元表达式兜底，而不是 `coalesce()`（`coalesce()` 在两边都是 `null` 时——比如新 VCN 还没 apply 出来——会报 "no non-null arguments" 错，必须手写三元表达式）：

```hcl
vcn_id = try(values.vcn_id, null) != null ? values.vcn_id : try(dependency.vcn.outputs.vcn_id, null)
```

调用方在 stack 文件的 `values` 里传了 `vcn_dependency_path`，这个 unit 就真的去解析 `dependency`、组合一个同一个 stack 里刚建出来的 VCN；不传，就用 `values.vcn_id` 里显式给的静态 OCID——老集群接入新结构时完全不用动这套依赖机制。`oke-prod-ap-singapore-1-1` 就是第一种用法：VCN 和 OKE 在同一个 stack 里，`terragrunt.stack.hcl` 里两个 `unit` 块，一个建 VCN，一个建 OKE，OKE 那个 unit 的 `values` 里带上 `vcn_dependency_path`，指向 VCN 那个 unit 的相对路径。

这套依赖解析在 DRG（动态路由网关，管跨 VCN 对等网络）那边逼出了一条新规矩。两个 region 的 DRG 互相对等，如果双方都在自己的 stack 里声明"我依赖对方的 attachment 信息"，就是一个循环依赖，Terragrunt 处理不了。我们定的原则是：**hub 持有依赖，edge 保持裸**。发起对等请求的一方（hub）在自己的 stack 里用 `dependency` 声明依赖另一方的输出，接受方（edge）自己的 unit 不声明任何反向依赖，接受方需要的信息由 hub 侧显式传值过去。这条规矩官方的 stacks-example 不会讲，因为它的 db → role → lambda 是单向链，没有互相引用的场景——只有真的接了两个会互相牵扯的资源，才会撞上这类问题。

至于第三篇发现的那两个孤儿文件——`accounts/default/account.hcl` 和 `regions/us-ashburn-1/region.hcl`——重新 `grep` 了一遍，**依旧没有任何地方引用它们**。这次反而更看得出来，当初规划账号/区域分层这个方向本身是对的：`live/oke/terragrunt.hcl` 里 `tenancy_id`/`compartment_id` 还是用 `get_env()` 独立定义的，跟这两个文件完全没关系。它们从被创建到现在，没人再碰过，也没人接进真正的配置读取链——这是这一整轮重构里唯一没有顺手处理掉的旧账，值得专门开一个小改动去清理或接进 `read_terragrunt_config()`，而不是继续放着。

## 7. 还没做完的事

这次重构不是"推翻重来"，是新旧并存、逐个迁移。`Terraform/oke/terragrunt.hcl`（老的项目级默认值文件）和 `Terraform/live/oke/terragrunt.hcl`（迁移目标结构下的副本）目前是**两份内容需要手动保持同步的文件**——`oke-prod-us-ashburn-2`、`oke-qa-us-ashburn` 等还没迁移的老集群继续用前者，新集群和已经迁移的集群用后者。这是一笔明确记录在案、还没还完的技术债，等其余老集群都迁完了才能删掉旧的那份。

---

四篇写完，回头看这套 Terragrunt 用法的脉络，跟最初计划的不太一样：本来打算第四篇诚实地承认"官方那两套模式我们暂时用不上"，写作过程中这件事本身就被现实推翻了——不是为了这篇文章去用它，是集群和对等网络多起来之后，重复配置的维护成本真实地开始疼，逼着我们把 Catalog 和 Stacks 都用了起来，而且踩的坑（`terraform.source` 的相对路径解析基准、`values` 的可见范围、老集群怎么无损接入新结构、循环依赖怎么破）比官方那种干净的示例仓库丰富得多。系列想表达的态度没变：按需引入，而不是一上来就照抄最复杂的模板——只是这次"需"已经真的来了。
